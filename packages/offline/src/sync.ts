import type { DraftView } from "@mail-hub/contracts";
import {
  META_KEYS,
  isUuid,
  type DraftEditPatch,
  type LocalDraft,
  type LocalUpload,
  type QueuedAction,
  type QueuedKind,
  type QueuedPayload,
  type RestoreMarker,
  type ReviewReason,
} from "./records.ts";
import { isQuotaError, type OfflineStore } from "./store.ts";

/*
 * The replay half of the offline contract (SPEC F9 and section 10).
 *
 * The controller replays queued actions oldest first, but three things stop
 * it on purpose. A generation mismatch means the server was restored, so
 * every affected item moves to review and replay stops. A send whose
 * response was lost stays unknown; only a person who acknowledged the
 * duplicate warning may create a new snapshot and key. A stale draft
 * rejection waits for an explicit comparison. Nothing here invents targets,
 * keys, or generations on its own.
 */

/** The one sentence a restore shows (SPEC F9). */
export const RESTORE_REVIEW_MESSAGE = "Server restored; review pending changes";

/** How one replay attempt ended, reported by the transport port. */
export type ReplayOutcome =
  | { state: "synced"; revision?: number; serverUploadId?: string }
  | { state: "retry"; reason: string; signInRequired?: boolean }
  | { state: "failed"; reason: string }
  | { state: "review"; reason: ReviewReason };

/** The transport the wiring layer supplies. Missing handlers block a kind. */
export interface OfflinePort {
  /** Saves one coalesced draft edit: `PATCH /drafts/:id`. */
  saveDraft?(payload: Extract<QueuedPayload, { kind: "draft-save" }>): Promise<ReplayOutcome>;
  /** Uploads one file's bytes: `POST /uploads`. */
  uploadBytes?(upload: LocalUpload): Promise<ReplayOutcome>;
  /** Queues one send: `POST /drafts/:id/send`. */
  queueSend?(payload: Extract<QueuedPayload, { kind: "send" }>): Promise<ReplayOutcome>;
  /** Runs one frozen mail action through the action service. */
  runMailAction?(
    payload: Extract<QueuedPayload, { kind: "flag" | "move" }>,
  ): Promise<ReplayOutcome>;
}

/** One queued action as the review surface shows it. */
export interface ReviewItem {
  localId: string;
  kind: QueuedKind;
  reason: ReviewReason;
  queuedAt: number;
  /** The draft involved, when the action names one. */
  draftId: string | null;
}

/** One definitively failed action as the interface shows it. */
export interface FailedItem {
  localId: string;
  kind: QueuedKind;
  /** The refusal the server gave, in the words the interface shows. */
  failure: string;
  queuedAt: number;
  /** The draft involved, when the action names one. */
  draftId: string | null;
}

/** What the interface always shows about unsynchronized work (SPEC F9). */
export interface SyncSnapshot {
  /** The generation the server last issued, when this device knows one. */
  serverGeneration: string | null;
  /** A restore happened and local work still holds the earlier generation. */
  reviewRequired: boolean;
  restore: RestoreMarker | null;
  /** The last replay pass paused because the session had ended. */
  signInRequired: boolean;
  /** Queued actions still waiting to leave this device. */
  pendingActions: number;
  /** Pending actions this port cannot replay yet. */
  unsupportedActions: number;
  /** Queued sends shown as waiting on this device (SPEC F9). */
  waitingSends: number;
  reviewActions: ReviewItem[];
  failedActions: FailedItem[];
  /** Local drafts with edits no server has acknowledged. */
  dirtyDrafts: number;
  /** Uploads whose bytes stay in Dexie (SPEC F6). */
  pendingUploads: number;
  lastSyncedAt: number | null;
}

/** What one `sync` pass did. */
export interface SyncReport {
  attempted: number;
  synced: number;
  /** True when a generation mismatch stopped the pass (SPEC F9). */
  stoppedForRestore: boolean;
  /** True when an ended session paused the pass (SPEC F9). */
  pausedForSignIn: boolean;
  snapshot: SyncSnapshot;
}

/** The choice that resolves one review item (SPEC F9). */
export type ReviewChoice =
  | {
      choice: "rebase";
      /** Set after both copies were shown; required for draft saves. */
      comparedWithServer?: boolean;
      /** Set after the duplicate warning; required for sends (SPEC F7). */
      duplicateWarningAcknowledged?: boolean;
      /** The server revision shown during the comparison. */
      serverRevision?: number;
    }
  | { choice: "discard" };

/** New durable work needs a generation, and none arrived yet. */
export class GenerationUnknownError extends Error {
  constructor() {
    super("The server has not issued a recovery generation on this device yet.");
    this.name = "GenerationUnknownError";
  }
}

/** A send was queued while its files still wait for the server. */
export class UploadsUnverifiedError extends Error {
  constructor(readonly waiting: number) {
    super(`Waiting on ${waiting} upload(s) before this send can be queued.`);
    this.name = "UploadsUnverifiedError";
  }
}

/** A review resolution skipped a step SPEC F9 requires. */
export class ReviewChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewChoiceError";
  }
}

/** True when a quota report should say the file never persisted. */
export function isQuotaRejection(error: unknown): boolean {
  return isQuotaError(error);
}

/**
 * The replay controller. One instance owns the queue of one device. All
 * methods are safe to call offline; only `sync` and `resolveReview` move
 * work out of the device, and `sync` talks only to the port.
 */
export class OfflineSync {
  constructor(
    private readonly store: OfflineStore,
    private readonly port: OfflinePort,
  ) {}

  /**
   * Record the generation an authenticated session issued (SPEC section 10).
   * A change marks every pending item from the earlier generation for
   * review; their stored generations stay untouched.
   */
  async observeGeneration(current: string | null): Promise<SyncSnapshot> {
    const normalized = normalizeGeneration(current);
    if (normalized === null) {
      return this.snapshot();
    }
    const previous = await this.store.serverGeneration();
    await this.store.writeMeta(META_KEYS.serverGeneration, normalized);
    if (previous === null || previous === normalized) {
      return this.snapshot();
    }

    await this.store.writeMeta(META_KEYS.restore, {
      serverGeneration: normalized,
      previousGeneration: previous,
      markedAt: this.store.timestamp(),
    } satisfies RestoreMarker);
    for (const action of await this.store.pendingActions()) {
      if (action.recoveryGeneration !== normalized) {
        await this.store.updateAction(action.localId, {
          state: "review",
          reviewReason: "server_restored",
        });
      }
    }
    return this.snapshot();
  }

  /**
   * Replay pending actions oldest first (SPEC F9). A generation mismatch
   * marks the item for review and stops the whole pass. An ended session
   * pauses the pass the same way: the items stay pending, and the pass after
   * sign-in resumes them.
   */
  async sync(): Promise<SyncReport> {
    const serverGeneration = await this.store.serverGeneration();
    if (serverGeneration === null) {
      return {
        attempted: 0,
        synced: 0,
        stoppedForRestore: false,
        pausedForSignIn: false,
        snapshot: await this.snapshot(),
      };
    }

    // A pass that starts speaks for the session it found; any upload a past
    // crash left without its action joins the queue before replay reads it.
    await this.store.writeMeta(META_KEYS.signInRequired, false);
    await this.reconcileOrphanedUploads();

    let attempted = 0;
    let synced = 0;
    let stoppedForRestore = false;
    let pausedForSignIn = false;
    for (const action of await this.store.pendingActions()) {
      if (action.recoveryGeneration !== serverGeneration) {
        await this.store.updateAction(action.localId, {
          state: "review",
          reviewReason: "server_restored",
        });
        stoppedForRestore = true;
        break;
      }
      // A save that settled earlier in this pass may have chained this
      // item's base revision forward, so replay the payload as the store
      // holds it now, not as the pass snapshot captured it.
      const queued = await this.store.getAction(action.localId);
      if (queued === null || queued.state !== "pending") {
        continue;
      }
      const run = this.handlerFor(queued.payload);
      if (run === null) {
        continue;
      }
      await this.store.updateAction(action.localId, { attempts: action.attempts + 1 });
      const outcome = await run();
      attempted += 1;
      if (outcome.state === "synced") {
        await this.settleSynced(queued, outcome.revision, outcome.serverUploadId);
        synced += 1;
      } else if (outcome.state === "failed") {
        await this.store.updateAction(action.localId, {
          state: "failed",
          failure: outcome.reason,
        });
      } else if (outcome.state === "review") {
        await this.store.updateAction(action.localId, {
          state: "review",
          reviewReason: outcome.reason,
        });
      } else if (outcome.signInRequired === true) {
        await this.store.writeMeta(META_KEYS.signInRequired, true);
        pausedForSignIn = true;
        break;
      }
      // An ordinary retry keeps the item pending for the next pass.
    }

    if (synced > 0) {
      await this.store.writeMeta(META_KEYS.lastSyncedAt, this.store.timestamp());
    }
    await this.store.pruneSyncedActions();
    return {
      attempted,
      synced,
      stoppedForRestore,
      pausedForSignIn,
      snapshot: await this.snapshot(),
    };
  }

  /**
   * Resolve one review item (SPEC F9). A rebase re-stamps the item with the
   * current generation, but only after the step its kind requires: sends
   * need the acknowledged duplicate warning and get a new idempotency key,
   * draft saves need the comparison and rebase onto the shown server
   * revision. A discard drops the action and keeps local text and files.
   */
  async resolveReview(localId: string, choice: ReviewChoice): Promise<SyncSnapshot> {
    const action = (await this.store.allActions()).find((entry) => entry.localId === localId);
    if (action === undefined) {
      throw new ReviewChoiceError("That queued action no longer exists.");
    }
    if (action.state !== "review") {
      throw new ReviewChoiceError("Only an action waiting for review can be resolved.");
    }

    if (choice.choice === "discard") {
      if (action.payload.kind === "upload") {
        // The file's only purpose here is to reach the server; a record the
        // user gave up on could never drain and would block the draft's
        // send, and reconciliation would resurrect the discarded action.
        await this.store.deleteUpload(action.payload.localUploadId);
      }
      await this.store.deleteAction(localId);
      return this.snapshot();
    }

    const serverGeneration = await this.store.serverGeneration();
    if (serverGeneration === null) {
      throw new GenerationUnknownError();
    }
    const payload = structuredClone(action.payload);
    if (payload.kind === "send") {
      if (choice.duplicateWarningAcknowledged !== true) {
        throw new ReviewChoiceError(
          "An uncertain send needs the duplicate warning acknowledged first (SPEC F7).",
        );
      }
      // A resend is new work: a new key, never the old one (SPEC F7).
      payload.idempotencyKey = this.store.generateId();
    }
    if (payload.kind === "draft-save") {
      if (choice.comparedWithServer !== true || typeof choice.serverRevision !== "number") {
        throw new ReviewChoiceError(
          "Rebase a draft only after an explicit comparison with the server copy (SPEC F9).",
        );
      }
      payload.baseRevision = choice.serverRevision;
    }

    await this.store.updateAction(localId, {
      payload,
      recoveryGeneration: serverGeneration,
      state: "pending",
      reviewReason: null,
      failure: null,
    });
    await this.restampLocalWork(payload, serverGeneration);
    return this.snapshot();
  }

  /** Move one definitively failed action back to the queue. */
  async retryFailure(localId: string): Promise<SyncSnapshot> {
    await this.store.updateAction(localId, { state: "pending", failure: null });
    return this.snapshot();
  }

  /**
   * Drop one definitively failed action. Local drafts stay; the bytes of a
   * failed upload go with their action, because the server refused them and
   * they would block their draft's send forever (SPEC F6).
   */
  async discardFailure(localId: string): Promise<SyncSnapshot> {
    const action = (await this.store.allActions()).find((entry) => entry.localId === localId);
    if (action !== undefined && action.payload.kind === "upload") {
      await this.store.deleteUpload(action.payload.localUploadId);
    }
    await this.store.deleteAction(localId);
    return this.snapshot();
  }

  //
  // Enqueueing, with the current generation stamped on creation (SPEC F9)
  //

  /** Queue one draft edit against its base revision. */
  async enqueueDraftSave(
    draftId: string,
    baseRevision: number,
    patch: DraftEditPatch,
  ): Promise<QueuedAction> {
    return this.enqueue({ kind: "draft-save", draftId, baseRevision, patch });
  }

  /**
   * Persist one file and queue its upload in one write (SPEC F6). A quota
   * error propagates without queueing anything.
   */
  async enqueueUpload(
    upload: Omit<LocalUpload, "localId" | "createdAt">,
  ): Promise<{ action: QueuedAction; upload: LocalUpload }> {
    const serverGeneration = await this.store.serverGeneration();
    if (serverGeneration === null) {
      throw new GenerationUnknownError();
    }
    return this.store.putPendingUploadWithAction(upload, serverGeneration);
  }

  /**
   * Queue one send (SPEC F6: only after every referenced file is uploaded
   * and verified). The idempotency key stays the one this device created.
   */
  async enqueueSend(
    draftId: string,
    idempotencyKey: string,
    baseRevision: number,
  ): Promise<QueuedAction> {
    const waiting = (await this.store.uploadsForDraft(draftId)).filter(
      (upload) => upload.serverId === null,
    );
    if (waiting.length > 0) {
      throw new UploadsUnverifiedError(waiting.length);
    }
    return this.enqueue({ kind: "send", draftId, idempotencyKey, baseRevision });
  }

  /** Queue one mail action with frozen occurrence targets (SPEC F9). */
  async enqueueMailAction(
    payload: Extract<QueuedPayload, { kind: "flag" | "move" }>,
  ): Promise<QueuedAction> {
    return this.enqueue(payload);
  }

  /** Everything the interface shows about unsynchronized work. */
  async snapshot(): Promise<SyncSnapshot> {
    const [serverGeneration, restore, actions, drafts, uploads, lastSyncedAt, signInRequired] =
      await Promise.all([
        this.store.serverGeneration(),
        this.store.readMeta<RestoreMarker>(META_KEYS.restore),
        this.store.allActions(),
        this.store.localDrafts(),
        this.store.pendingUploads(),
        this.store.readMeta<number>(META_KEYS.lastSyncedAt),
        this.store.readMeta<boolean>(META_KEYS.signInRequired),
      ]);

    const pending = actions.filter((action) => action.state === "pending");
    const review = actions.filter((action) => action.state === "review");
    const failed = actions.filter((action) => action.state === "failed");
    const dirtyDrafts = drafts.filter((draft) => draft.dirty);
    const reviewRequired =
      restore !== null &&
      (review.length > 0 ||
        dirtyDrafts.some((draft) => draft.recoveryGeneration === restore.previousGeneration) ||
        uploads.some((upload) => upload.recoveryGeneration === restore.previousGeneration) ||
        pending.some((action) => action.recoveryGeneration === restore.previousGeneration));

    // Upload payloads name files, not drafts; the file records carry the
    // draft link the review surface needs.
    const uploadDraftIds = new Map(uploads.map((upload) => [upload.localId, upload.draftId]));

    return {
      serverGeneration,
      reviewRequired,
      restore: reviewRequired ? restore : null,
      signInRequired: signInRequired === true,
      pendingActions: pending.length,
      unsupportedActions: pending.filter((action) => this.handlerFor(action.payload) === null)
        .length,
      waitingSends: pending.filter(
        (action) => action.payload.kind === "send",
      ).length,
      reviewActions: review.map((action) => toReviewItem(action, uploadDraftIds)),
      failedActions: failed.map((action) => ({
        localId: action.localId,
        kind: action.payload.kind,
        failure: action.failure ?? "",
        queuedAt: action.queuedAt,
        draftId: actionDraftId(action.payload, uploadDraftIds),
      })),
      dirtyDrafts: dirtyDrafts.length,
      pendingUploads: uploads.length,
      lastSyncedAt,
    };
  }

  /** One local draft copy for the review surface to compare (SPEC F9). */
  async localDraft(draftId: string): Promise<LocalDraft | null> {
    return this.store.getLocalDraft(draftId);
  }

  /** The server draft, fetched by the wiring for the comparison step. */
  async noteComparedServerCopy(draftId: string, server: DraftView): Promise<void> {
    const local = await this.store.getLocalDraft(draftId);
    if (local !== null) {
      await this.store.putLocalDraft({ ...local, server });
    }
  }

  /** Freeze one action under the current generation. */
  private async enqueue(payload: QueuedPayload): Promise<QueuedAction> {
    const serverGeneration = await this.store.serverGeneration();
    if (serverGeneration === null) {
      throw new GenerationUnknownError();
    }
    return this.store.enqueue(payload, serverGeneration);
  }

  /** The port handler for one payload, or null when the kind is blocked. */
  private handlerFor(
    payload: QueuedPayload,
  ): (() => Promise<ReplayOutcome>) | null {
    switch (payload.kind) {
      case "draft-save": {
        const save = this.port.saveDraft;
        return save === undefined
          ? null
          : () => save(payload);
      }
      case "upload": {
        const uploadBytes = this.port.uploadBytes;
        return uploadBytes === undefined
          ? null
          : () => this.replayUpload(payload.localUploadId, uploadBytes);
      }
      case "send": {
        const queueSend = this.port.queueSend;
        return queueSend === undefined ? null : () => queueSend(payload);
      }
      case "flag":
      case "move": {
        const runMailAction = this.port.runMailAction;
        return runMailAction === undefined ? null : () => runMailAction(payload);
      }
    }
  }

  /** Load the stored bytes and hand them to the port. */
  private async replayUpload(
    localUploadId: string,
    uploadBytes: NonNullable<OfflinePort["uploadBytes"]>,
  ): Promise<ReplayOutcome> {
    const upload = await this.store.getUpload(localUploadId);
    if (upload === null) {
      return { state: "failed", reason: "The uploaded file is no longer on this device." };
    }
    if (upload.serverId !== null) {
      return { state: "synced", serverUploadId: upload.serverId };
    }
    return uploadBytes(upload);
  }

  /** Apply one synced outcome to the records behind the action. */
  private async settleSynced(
    action: QueuedAction,
    revision: number | undefined,
    serverUploadId: string | undefined,
  ): Promise<void> {
    const syncedAt = this.store.timestamp();
    await this.store.updateAction(action.localId, {
      state: "synced",
      reviewReason: null,
      failure: null,
      syncedAt,
    });
    if (action.payload.kind === "draft-save" && revision !== undefined) {
      const payload = action.payload;
      const pending = await this.store.pendingActions();
      // Queued saves of one draft are coalesced snapshots of the same
      // editor, each frozen against the revision enqueue time held. The
      // save that just synced moved that revision, so chain it forward:
      // without the chain, the device's own next edit replays against the
      // revision its earlier edit produced, the server refuses it as
      // stale, and no competing change ever existed (SPEC F9).
      for (const entry of pending) {
        if (
          entry.payload.kind === "draft-save" &&
          entry.payload.draftId === payload.draftId &&
          entry.payload.baseRevision < revision
        ) {
          await this.store.updateAction(entry.localId, {
            payload: { ...entry.payload, baseRevision: revision },
          });
        }
      }
      const local = await this.store.getLocalDraft(payload.draftId);
      const moreEditsPending = pending.some(
        (entry) => draftIdOf(entry.payload) === payload.draftId,
      );
      if (local !== null && local.baseRevision <= revision) {
        await this.store.putLocalDraft({
          ...local,
          baseRevision: revision,
          // The queue is the truth about unsynced edits: later queued
          // saves keep the draft dirty, otherwise the server owns it all.
          dirty: moreEditsPending,
          recoveryGeneration: action.recoveryGeneration,
        });
      }
    }
    if (action.payload.kind === "upload" && serverUploadId !== undefined) {
      await this.store.markUploadAcknowledged(action.payload.localUploadId, serverUploadId);
    }
  }

  /** After a rebase, the local records join the current generation too. */
  private async restampLocalWork(
    payload: QueuedPayload,
    serverGeneration: string,
  ): Promise<void> {
    if (payload.kind === "upload") {
      const upload = await this.store.getUpload(payload.localUploadId);
      if (upload !== null) {
        await this.store.updateUpload(upload.localId, { recoveryGeneration: serverGeneration });
      }
    }
    if (payload.kind === "draft-save") {
      const local = await this.store.getLocalDraft(payload.draftId);
      if (local !== null) {
        await this.store.putLocalDraft({
          ...local,
          baseRevision: payload.baseRevision,
          recoveryGeneration: serverGeneration,
        });
      }
    }
  }

  /**
   * Give every waiting upload a replay action. An enqueue from before the
   * atomic write could crash between its two records and leave bytes that
   * never drain and block their draft's send (SPEC F6).
   */
  private async reconcileOrphanedUploads(): Promise<void> {
    const covered = new Set<string>();
    for (const action of await this.store.allActions()) {
      if (action.state !== "synced" && action.payload.kind === "upload") {
        covered.add(action.payload.localUploadId);
      }
    }
    for (const upload of await this.store.pendingUploads()) {
      if (!covered.has(upload.localId)) {
        // The action keeps the generation the upload was created under, so a
        // restore still routes it through review (SPEC section 10).
        await this.store.enqueue(
          { kind: "upload", localUploadId: upload.localId },
          upload.recoveryGeneration,
        );
      }
    }
  }
}

/** Normalize one generation the way the server's gate does. */
function normalizeGeneration(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return isUuid(trimmed) ? trimmed : null;
}

/** The draft one payload names, when it names one directly. */
function draftIdOf(payload: QueuedPayload): string | null {
  switch (payload.kind) {
    case "draft-save":
    case "send":
      return payload.draftId;
    default:
      return null;
  }
}

/** The draft one action names, directly or through its upload record. */
function actionDraftId(payload: QueuedPayload, uploadDraftIds: Map<string, string>): string | null {
  const direct = draftIdOf(payload);
  if (direct !== null) {
    return direct;
  }
  return payload.kind === "upload" ? (uploadDraftIds.get(payload.localUploadId) ?? null) : null;
}

/** One review-facing summary of a queued action. */
function toReviewItem(action: QueuedAction, uploadDraftIds: Map<string, string>): ReviewItem {
  return {
    localId: action.localId,
    kind: action.payload.kind,
    reason: action.reviewReason ?? "server_restored",
    queuedAt: action.queuedAt,
    draftId: actionDraftId(action.payload, uploadDraftIds),
  };
}
