/**
 * The offline data and replay controls of the progressive web app
 * (SPEC F9 and section 10).
 *
 * `OfflineStore` keeps recent mail, local drafts, upload bytes, and queued
 * actions in Dexie. `OfflineSync` replays that queue: it stamps every record
 * with the recovery generation the server issued, stops replay when the
 * generation changes after a restore, and resolves the review that follows
 * only through explicit choices.
 */
export {
  RECENT_MAIL_LIMIT,
  SYNCED_ACTION_LIMIT,
  OfflineStore,
  isQuotaError,
  type OfflineStoreOptions,
} from "./store.ts";
export {
  GenerationUnknownError,
  OfflineSync,
  RESTORE_REVIEW_MESSAGE,
  ReviewChoiceError,
  UploadsUnverifiedError,
  isQuotaRejection,
  type FailedItem,
  type OfflinePort,
  type ReplayOutcome,
  type ReviewChoice,
  type ReviewItem,
  type SyncReport,
  type SyncSnapshot,
} from "./sync.ts";
export {
  META_KEYS,
  isUuid,
  type CachedMessage,
  type DraftEditPatch,
  type FrozenTarget,
  type LocalDraft,
  type LocalUpload,
  type QueuedAction,
  type QueuedKind,
  type QueuedPayload,
  type QueuedState,
  type RestoreMarker,
  type ReviewReason,
} from "./records.ts";
