// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DraftView } from "@mail-hub/contracts";
import {
  ReviewChoiceError,
  type FailedItem,
  type LocalDraft,
  type ReviewItem,
  type SyncSnapshot,
} from "@mail-hub/offline";
import { ApiError } from "../src/lib/api.ts";
import { SyncStatusChip } from "../src/components/mail/sync-status.tsx";

/*
 * The review rows own their failures (SPEC F9): a refused resolve, retry,
 * comparison, or server-copy adoption shows its words in the row it came
 * from, the busy flag settles, and no rejection escapes unhandled.
 */

const harness = vi.hoisted(() => ({
  state: null as unknown,
  controller: null as unknown,
  store: null as unknown,
  serverDraft: null as (() => Promise<DraftView>) | null,
}));

vi.mock("../src/offline/sync-context.tsx", () => ({
  useOfflineSync: () => harness.state,
}));

vi.mock("../src/offline/port.ts", () => ({
  offlineSync: () => harness.controller,
  fetchServerDraft: () =>
    harness.serverDraft === null
      ? Promise.reject(new Error("No server draft was prepared."))
      : harness.serverDraft(),
}));

vi.mock("../src/offline/store.ts", () => ({
  offlineStore: () => harness.store,
}));

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    serverGeneration: "gen-1",
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

function reviewItem(kind: ReviewItem["kind"], draftId: string | null): ReviewItem {
  return {
    localId: "r-1",
    kind,
    reason: kind === "draft-save" ? "draft_conflict" : "server_restored",
    queuedAt: 0,
    draftId,
  };
}

function failedItem(): FailedItem {
  return {
    localId: "f-1",
    kind: "flag",
    failure: "The server refused the flag change.",
    queuedAt: 0,
    draftId: null,
  };
}

function serverDraftOf(markdown: string): DraftView {
  return {
    id: "d-1",
    accountId: "acc-1",
    identity: { address: "one@a.example", name: null },
    recipients: { to: [] },
    subject: "Server subject",
    markdown,
    revision: 4,
    lockedBySend: null,
    replyParentId: null,
    threadId: null,
    inReplyTo: null,
    referenceIds: [],
    updatedAt: "2026-09-20T10:00:00Z",
  };
}

function localDraftOf(markdown: string): LocalDraft {
  return {
    draftId: "d-1",
    accountId: "acc-1",
    server: serverDraftOf("server text"),
    identity: { address: "one@a.example" },
    recipients: { to: [] },
    subject: "Local subject",
    markdown,
    baseRevision: 3,
    dirty: true,
    recoveryGeneration: "gen-1",
    updatedAt: 0,
  };
}

/** The sync state the chip reads, with the row actions under test. */
function stateWith(
  shot: SyncSnapshot,
  actions: { resolve?: () => Promise<void>; retry?: () => Promise<void> } = {},
) {
  return {
    snapshot: shot,
    online: true,
    syncing: false,
    resolve: vi.fn().mockImplementation(actions.resolve ?? (() => Promise.resolve())),
    retry: vi.fn().mockImplementation(actions.retry ?? (() => Promise.resolve())),
    discard: vi.fn().mockImplementation(() => Promise.resolve()),
  };
}

interface Mount {
  text(): string;
  button(label: string): HTMLButtonElement | null;
  cleanup(): void;
}

function mountChip(): Mount {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<SyncStatusChip onSessionLost={() => undefined} />);
  });
  return {
    // The dialog portals into the document body, not the container.
    text: () => document.body.textContent ?? "",
    button: (label) => {
      const found = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((entry) => entry.textContent?.trim() === label);
      return found ?? null;
    },
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const mounts: Mount[] = [];

function freshChip(): Mount {
  const made = mountChip();
  mounts.push(made);
  return made;
}

/** Lets the clicked step run to its note or its snapshot change. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  for (const made of mounts.splice(0)) {
    made.cleanup();
  }
  harness.state = null;
  harness.controller = null;
  harness.store = null;
  harness.serverDraft = null;
});

describe("the review rows' failure handling", () => {
  it("shows a refused choice's words in the row that made it", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    // A queued action the restore already dismissed resolves to nothing; the
    // row must say so instead of dropping the rejection.
    harness.state = stateWith(
      snapshot({ reviewRequired: true, reviewActions: [reviewItem("flag", null)] }),
      { resolve: () => Promise.reject(new ReviewChoiceError("That queued action no longer exists.")) },
    );
    const made = freshChip();
    await settle();

    await act(async () => {
      made.button("Discard")!.click();
    });
    await settle();

    expect(made.text()).toContain("That queued action no longer exists.");
    expect(made.button("Keep it queued")!.disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rejections).toEqual([]);
    process.off("unhandledRejection", onUnhandled);
  });

  it("keeps the comparison step available when the server copy cannot be read", async () => {
    harness.state = stateWith(
      snapshot({ reviewRequired: true, reviewActions: [reviewItem("draft-save", "d-1")] }),
    );
    harness.controller = { localDraft: async () => localDraftOf("local text") };
    harness.serverDraft = () =>
      Promise.reject(new ApiError(500, "unexpected", "The draft cannot be read right now."));
    const made = freshChip();
    await settle();

    await act(async () => {
      made.button("Compare with the server")!.click();
    });
    await settle();

    expect(made.text()).toContain("The draft cannot be read right now.");
    // The comparison never landed, so its step stays offered.
    expect(made.button("Compare with the server")).not.toBeNull();
    expect(made.button("Compare with the server")!.disabled).toBe(false);
  });

  it("surfaces a failed adoption of the server copy and keeps the item", async () => {
    const resolve = vi.fn().mockReturnValue(Promise.resolve());
    harness.state = {
      snapshot: snapshot({
        reviewRequired: true,
        reviewActions: [reviewItem("draft-save", "d-1")],
      }),
      online: true,
      syncing: false,
      resolve,
      retry: vi.fn().mockReturnValue(Promise.resolve()),
      discard: vi.fn().mockReturnValue(Promise.resolve()),
    };
    harness.serverDraft = () => Promise.resolve(serverDraftOf("server text"));
    harness.controller = {
      localDraft: async () => localDraftOf("local text"),
      noteComparedServerCopy: vi.fn().mockReturnValue(Promise.resolve()),
    };
    harness.store = {
      putLocalDraft: vi
        .fn()
        .mockImplementation(() =>
          Promise.reject(new Error("The local copy could not be written.")),
        ),
    };
    const made = freshChip();
    await settle();

    await act(async () => {
      made.button("Compare with the server")!.click();
    });
    await settle();
    await act(async () => {
      made.button("Keep the server copy")!.click();
    });
    await settle();

    expect(made.text()).toContain("The local copy could not be written.");
    // The adoption failed, so the item was not resolved as discarded.
    expect(resolve).not.toHaveBeenCalled();
    expect(made.button("Keep the server copy")!.disabled).toBe(false);
  });

  it("shows a refused retry in the failed row that asked for it", async () => {
    harness.state = stateWith(snapshot({ failedActions: [failedItem()] }), {
      retry: () => Promise.reject(new Error("The queue cannot be read.")),
    });
    const made = freshChip();
    await settle();

    // The failed tone leaves the dialog closed until the chip opens it.
    await act(async () => {
      made.button("1 failed to sync")!.click();
    });
    await settle();
    await act(async () => {
      made.button("Try again")!.click();
    });
    await settle();

    expect(made.text()).toContain("The queue cannot be read.");
    expect(made.button("Try again")!.disabled).toBe(false);
  });
});
