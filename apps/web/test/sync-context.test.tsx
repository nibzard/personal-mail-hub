// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OfflineSync, SyncReport, SyncSnapshot } from "@mail-hub/offline";
import {
  OfflineSyncProvider,
  useOfflineSync,
  type OfflineSyncState,
} from "../src/offline/sync-context.tsx";

/*
 * The provider's pass orchestration (SPEC F9): a generation that arrives
 * while a pass runs is still observed when the pass can take it, and a
 * failed pass stays handled instead of surfacing an unhandled rejection.
 */

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";

/** The mocked `offlineSync` singleton the provider reads. */
const harness = vi.hoisted(() => ({
  controller: null as unknown,
}));

vi.mock("../src/offline/port.ts", () => ({
  offlineSync: () => harness.controller,
}));

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    serverGeneration: GENERATION_A,
    reviewRequired: false,
    restore: null,
    signInRequired: false,
    pendingActions: 0,
    unsupportedActions: 0,
    waitingSends: 0,
    reviewActions: [],
    failedActions: [],
    dirtyDrafts: 0,
    pendingUploads: 0,
    lastSyncedAt: null,
    ...overrides,
  };
}

/** One pass-shaped report with nothing done. */
function report(shot: SyncSnapshot): SyncReport {
  return {
    attempted: 0,
    synced: 0,
    stoppedForRestore: false,
    pausedForSignIn: false,
    snapshot: shot,
  };
}

/** Records every sync state the probe saw, so tests read the last one. */
function Probe({ noted }: { noted: (state: OfflineSyncState) => void }) {
  noted(useOfflineSync());
  return null;
}

/** Renders the provider and hands the test its re-render and state log. */
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const states: OfflineSyncState[] = [];
  const noted = (state: OfflineSyncState) => {
    states.push(state);
  };
  const render = (generation: string | null) => {
    act(() => {
      root.render(
        <OfflineSyncProvider probeGeneration={generation}>
          <Probe noted={noted} />
        </OfflineSyncProvider>,
      );
    });
  };
  return {
    states,
    render,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const mounts: Array<ReturnType<typeof mount>> = [];

function freshMount() {
  const made = mount();
  mounts.push(made);
  return made;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const made of mounts.splice(0)) {
    made.cleanup();
  }
  harness.controller = null;
});

/** One controller whose passes park until the test releases them, in order. */
function gatedController(observed: Array<string | null>) {
  const gates: Array<() => void> = [];
  const controller = {
    observeGeneration: async (generation: string | null) => {
      observed.push(generation);
      return snapshot();
    },
    sync: async () => {
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      return report(snapshot());
    },
  };
  return { controller: controller as unknown as OfflineSync, gates };
}

describe("the offline sync provider", () => {
  it("observes a generation that arrives while a pass runs", async () => {
    const observed: Array<string | null> = [];
    const { controller, gates } = gatedController(observed);
    harness.controller = controller;

    const made = freshMount();
    made.render(GENERATION_A);
    // The first pass runs and parks inside its replay.
    await act(async () => {});

    // The probe answers with generation B while that pass still runs.
    await act(async () => {
      made.render(GENERATION_B);
    });

    // Releasing the parked pass must hand the newer generation over: the
    // pass observes B and runs one more pass with it, instead of dropping
    // B and letting the next pass replay everything into recovery refusals.
    await act(async () => {
      gates[0]!();
    });
    await act(async () => {
      gates[1]!();
    });

    expect(observed).toEqual([GENERATION_A, GENERATION_B]);
    expect(made.states.at(-1)?.syncing).toBe(false);
  });

  it("keeps the last good snapshot when a pass fails", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let fail = false;
    const controller = {
      observeGeneration: async () => snapshot(),
      sync: async () => {
        if (fail) {
          throw new Error("The IndexedDB store is unavailable.");
        }
        return report(snapshot({ pendingActions: 2 }));
      },
    };
    harness.controller = controller as unknown as OfflineSync;

    const made = freshMount();
    made.render(GENERATION_A);
    await act(async () => {});
    expect(made.states.at(-1)?.snapshot?.pendingActions).toBe(2);

    fail = true;
    await act(async () => {
      made.render(GENERATION_B);
    });
    // Give a would-be unhandled rejection a macrotask to surface.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(rejections).toEqual([]);
    expect(made.states.at(-1)?.syncing).toBe(false);
    expect(made.states.at(-1)?.snapshot?.pendingActions).toBe(2);
    process.off("unhandledRejection", onUnhandled);
  });
});
