import type { MessageRecipients } from "@mail-hub/contracts";

/**
 * The client half of revision-aware autosave (SPEC F9 and F12).
 *
 * The Markdown editor reports every change here. The controller debounces
 * for two seconds, coalesces pending edits field by field, and saves with
 * the revision the server last acknowledged. Its state is the one stable
 * place the editor shows save progress: `unsaved`, `saving`, `saved`,
 * `conflict`, `offline`, or `error`. A stale rejection never overwrites the
 * other copy: the controller holds the local edits and surfaces both
 * revisions until you choose one.
 *
 * The controller holds no transport. The wiring layer supplies the `save`
 * function, replay on reconnection, and the durable local copy for offline
 * drafting.
 */

/** The autosave status shown in one stable place (SPEC F12). */
export type AutosaveState = "saved" | "unsaved" | "saving" | "conflict" | "offline" | "error";

/** One editor change, applied field by field to the pending edits. */
export interface AutosavePatch {
  identity?: { address: string } | null;
  recipients?: MessageRecipients | null;
  subject?: string | null;
  markdown?: string | null;
}

/** What one save attempt concluded. */
export type AutosaveOutcome =
  | { state: "saved"; revision: number }
  | { state: "conflict"; currentRevision: number }
  | { state: "offline" }
  | { state: "error"; message: string };

export interface DraftAutosaverOptions {
  draftId: string;
  /** The revision the local copy is based on. */
  revision: number;
  /** Saves one coalesced patch against one base revision. */
  save(draftId: string, baseRevision: number, patch: AutosavePatch): Promise<AutosaveOutcome>;
  /** Called once for every state change, including the first. */
  onStateChange?(state: AutosaveState): void;
  /** The autosave delay. Two seconds by default (SPEC F9). */
  debounceMs?: number;
}

/** The autosave state machine for one open draft. */
export class DraftAutosaver {
  readonly draftId: string;
  private readonly revisionBase: { revision: number };
  private readonly saveFn: DraftAutosaverOptions["save"];
  private readonly onStateChange: ((state: AutosaveState) => void) | undefined;
  private readonly debounceMs: number;

  private currentState: AutosaveState = "saved";
  private pending: AutosavePatch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private flushWanted = false;
  private disposed = false;

  constructor(options: DraftAutosaverOptions) {
    this.draftId = options.draftId;
    this.revisionBase = { revision: options.revision };
    this.saveFn = options.save;
    this.onStateChange = options.onStateChange;
    this.debounceMs = options.debounceMs ?? 2000;
  }

  /** The state the editor shows. */
  get state(): AutosaveState {
    return this.currentState;
  }

  /** The revision the local copy is based on. */
  get revision(): number {
    return this.revisionBase.revision;
  }

  /** The edits not yet acknowledged by the server. */
  get pendingPatch(): AutosavePatch | null {
    return this.pending === null ? null : { ...this.pending };
  }

  /**
   * Report one editor change. Merges into the pending edits and restarts the
   * debounce, except during a conflict: the choice must come first, but the
   * local edits still accumulate so nothing is lost.
   */
  push(patch: AutosavePatch): void {
    this.requireLive();
    this.pending = mergePatch(this.pending, patch);
    if (this.currentState === "conflict") {
      return;
    }
    if (this.currentState !== "saving") {
      this.setState("unsaved");
    }
    this.schedule();
  }

  /**
   * Save now. Coalesced edits are always kept: a new edit that lands while a
   * save is in flight schedules one more save after it settles.
   */
  flush(): Promise<void> {
    this.requireLive();
    if (this.inFlight !== null) {
      this.flushWanted = true;
      return this.inFlight;
    }
    this.clearTimer();
    this.inFlight = this.guardedSave();
    return this.inFlight;
  }

  /** Retry after `offline` or `error`, keeping every pending edit. */
  retry(): Promise<void> {
    this.requireLive();
    if (this.currentState !== "offline" && this.currentState !== "error") {
      return Promise.resolve();
    }
    if (this.pending === null) {
      this.setState("saved");
      return Promise.resolve();
    }
    this.setState("unsaved");
    return this.flush();
  }

  /**
   * Resolve a conflict by keeping the server copy. Local pending edits are
   * discarded; call this only after you showed both versions (SPEC F9).
   */
  acceptServerCopy(revision: number): void {
    this.requireLive();
    if (this.currentState !== "conflict") {
      return;
    }
    this.revisionBase.revision = revision;
    this.pending = null;
    this.setState("saved");
  }

  /**
   * Resolve a conflict by keeping the local copy. The pending edits rebase
   * onto the server revision and save immediately, which overwrites the
   * other device's changes on purpose.
   */
  keepLocalCopy(currentRevision: number): Promise<void> {
    this.requireLive();
    if (this.currentState !== "conflict") {
      return Promise.resolve();
    }
    this.revisionBase.revision = currentRevision;
    this.setState("unsaved");
    return this.flush();
  }

  /** Stop the debounce timer. Pending edits stay in memory. */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run one save and always release the in-flight slot afterwards. */
  private async guardedSave(): Promise<void> {
    try {
      await this.runSave();
    } finally {
      this.inFlight = null;
    }
  }

  private async runSave(): Promise<void> {
    // A conflict waits for an explicit choice; nothing autosaves over it.
    if (this.currentState === "conflict") {
      return;
    }
    if (this.pending === null) {
      this.setStateIfLive("saved");
      return;
    }
    const patch = this.pending;
    const baseRevision = this.revisionBase.revision;
    this.setStateIfLive("saving");
    const outcome = await this.saveFn(this.draftId, baseRevision, patch);
    if (this.disposed) {
      return;
    }
    if (outcome.state === "saved") {
      this.revisionBase.revision = outcome.revision;
      if (this.pending !== null && shallowEqual(this.pending, patch)) {
        this.pending = null;
      }
    }
    switch (outcome.state) {
      case "saved":
        if (this.pending === null) {
          this.setState("saved");
        } else {
          // Edits arrived while this save was in flight: save them too.
          this.setState("unsaved");
          await this.runSave();
        }
        break;
      case "conflict":
        // Keep the pending edits; the choice methods move them forward.
        this.setState("conflict");
        break;
      case "offline":
        this.setState("offline");
        break;
      case "error":
        this.setState("error");
        break;
    }
    if (this.flushWanted) {
      this.flushWanted = false;
      if (this.pending !== null) {
        // The conflict guard at the top of `runSave` still applies here.
        await this.runSave();
      }
    }
  }

  private setStateIfLive(state: AutosaveState): void {
    if (!this.disposed) {
      this.setState(state);
    }
  }

  private setState(state: AutosaveState): void {
    if (state !== this.currentState) {
      this.currentState = state;
      this.onStateChange?.(state);
    }
  }

  private requireLive(): void {
    if (this.disposed) {
      throw new Error("This autosaver was disposed.");
    }
  }
}

/** Merge one patch into the pending edits; later values win per field. */
function mergePatch(current: AutosavePatch | null, patch: AutosavePatch): AutosavePatch {
  return { ...current, ...patch };
}

/** Compare patches by identity: the same field values mean the same edits. */
function shallowEqual(left: AutosavePatch, right: AutosavePatch): boolean {
  const leftKeys = Object.keys(left) as (keyof AutosavePatch)[];
  const rightKeys = Object.keys(right) as (keyof AutosavePatch)[];
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}
