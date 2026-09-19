import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftAutosaver, type AutosaveOutcome, type AutosavePatch, type AutosaveState } from "../src/index.ts";

/**
 * The client half of autosave (SPEC F9 and F12): two-second debounce,
 * field-wise coalescing, revision tracking, and the stale-revision choice.
 * The save function is injected, so these tests need no transport.
 */

const DRAFT_ID = "0b0f6af3-8327-4d0e-8a34-2a58c1a4b6ee";

/** One scripted save attempt and what the controller asked for. */
interface SaveCall {
  baseRevision: number;
  patch: AutosavePatch;
}

function makeSave(outcomes: AutosaveOutcome[]) {
  const calls: SaveCall[] = [];
  let attempt = 0;
  const save = vi.fn(
    (_draftId: string, baseRevision: number, patch: AutosavePatch): Promise<AutosaveOutcome> => {
      calls.push({ baseRevision, patch });
      const outcome = outcomes[Math.min(attempt, outcomes.length - 1)]!;
      attempt += 1;
      return Promise.resolve(outcome);
    },
  );
  return { save, calls };
}

function makeSaver(
  options: Partial<ConstructorParameters<typeof DraftAutosaver>[0]> & { save: ConstructorParameters<typeof DraftAutosaver>[0]["save"] },
): DraftAutosaver {
  return new DraftAutosaver({ draftId: DRAFT_ID, revision: 1, debounceMs: 2000, ...options });
}

describe("draft autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces edits for two seconds and coalesces them into one save", async () => {
    const { save, calls } = makeSave([{ state: "saved", revision: 2 }]);
    const states: AutosaveState[] = [];
    const saver = makeSaver({ save, onStateChange: (state) => states.push(state) });

    saver.push({ markdown: "# Draft" });
    expect(saver.state).toBe("unsaved");
    expect(save).not.toHaveBeenCalled();

    saver.push({ subject: "Weekly notes" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saver.state).toBe("saved");
    expect(saver.revision).toBe(2);
    expect(saver.pendingPatch).toBeNull();
    expect(calls[0]).toEqual({ baseRevision: 1, patch: { markdown: "# Draft", subject: "Weekly notes" } });
    expect(states).toEqual(["unsaved", "saving", "saved"]);

    saver.dispose();
  });

  it("saves immediately on flush and chains edits that arrive mid-flight", async () => {
    const calls: SaveCall[] = [];
    let pendingRelease: ((outcome: AutosaveOutcome) => void) | null = null;
    let nextOutcome: Promise<AutosaveOutcome> = new Promise((resolve) => {
      pendingRelease = resolve;
    });
    const save = vi.fn((_draftId: string, baseRevision: number, patch: AutosavePatch) => {
      calls.push({ baseRevision, patch });
      const outcome = nextOutcome;
      // Later calls resolve on their own; only the first is held manually.
      nextOutcome = Promise.resolve({ state: "saved", revision: baseRevision + 1 });
      return outcome;
    });
    const saver = makeSaver({ save });

    saver.push({ markdown: "first" });
    const saving = saver.flush();
    expect(saver.state).toBe("saving");

    // An edit landing while the request is in flight waits for it.
    saver.push({ markdown: "second" });
    expect(saver.state).toBe("saving");

    pendingRelease!({ state: "saved", revision: 2 });
    await saving;

    expect(save).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.patch.markdown)).toEqual(["first", "second"]);
    expect(calls[1]!.baseRevision).toBe(2);
    expect(saver.state).toBe("saved");
    expect(saver.pendingPatch).toBeNull();

    saver.dispose();
  });

  it("keeps local edits and both revisions on a stale rejection", async () => {
    const { save } = makeSave([
      { state: "conflict", currentRevision: 7 },
      { state: "saved", revision: 8 },
    ]);
    const saver = makeSaver({ save });

    saver.push({ markdown: "local text" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saver.state).toBe("conflict");
    expect(saver.pendingPatch).toEqual({ markdown: "local text" });

    // Edits during a conflict accumulate but never autosave over the choice.
    saver.push({ subject: "still local" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(saver.state).toBe("conflict");
    expect(save).toHaveBeenCalledTimes(1);

    // Keeping the local copy rebases onto the server revision and saves now.
    await saver.keepLocalCopy(7);
    expect(save).toHaveBeenCalledTimes(2);
    expect(saver.state).toBe("saved");
    expect(saver.revision).toBe(8);
    expect(saver.pendingPatch).toBeNull();

    saver.dispose();
  });

  it("discards local edits when the server copy wins", async () => {
    const { save } = makeSave([{ state: "conflict", currentRevision: 5 }]);
    const saver = makeSaver({ save });

    saver.push({ markdown: "throwaway" });
    await vi.advanceTimersByTimeAsync(2000);
    saver.acceptServerCopy(5);

    expect(saver.state).toBe("saved");
    expect(saver.revision).toBe(5);
    expect(saver.pendingPatch).toBeNull();

    saver.dispose();
  });

  it("retains every edit across an offline save and retries on demand", async () => {
    const { save, calls } = makeSave([{ state: "offline" }, { state: "saved", revision: 2 }]);
    const saver = makeSaver({ save });

    saver.push({ markdown: "offline draft" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saver.state).toBe("offline");
    expect(saver.pendingPatch).toEqual({ markdown: "offline draft" });

    // Time alone never retries; the wiring layer calls retry on reconnection.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);

    await saver.retry();
    expect(saver.state).toBe("saved");
    expect(calls[1]).toEqual({ baseRevision: 1, patch: { markdown: "offline draft" } });

    saver.dispose();
  });

  it("surfaces recoverable errors and retries with the pending edits", async () => {
    const { save } = makeSave([{ state: "error", message: "server unavailable" }, { state: "saved", revision: 3 }]);
    const saver = makeSaver({ save });

    saver.push({ markdown: "draft" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(saver.state).toBe("error");

    await saver.retry();
    expect(saver.state).toBe("saved");
    expect(saver.revision).toBe(3);

    saver.dispose();
  });

  it("stops the debounce on dispose without losing pending edits", async () => {
    const { save } = makeSave([{ state: "saved", revision: 2 }]);
    const saver = makeSaver({ save });

    saver.push({ markdown: "last words" });
    saver.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).not.toHaveBeenCalled();
    expect(saver.pendingPatch).toEqual({ markdown: "last words" });
  });
});
