import type {
  DraftView,
  MessageDetailView,
  MessageRecipients,
  SearchResultItem,
} from "@mail-hub/contracts";

/*
 * The offline records the progressive web app keeps in Dexie (SPEC F9):
 * recent conversations, local drafts, upload bytes that wait for their
 * acknowledgement, and the durable queue of pending actions.
 *
 * Every durable client record carries the recovery generation the server
 * issued when it was created. Reconnection never replaces that generation;
 * only the explicit review after a restore does (SPEC section 10).
 */

/** The message the store calls a UUID, so caller-provided ids stay checked. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True when the value is a UUID the server could have issued. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** One downloaded message: its list row, plus the sanitized detail once read. */
export interface CachedMessage {
  messageId: string;
  /** The downloaded list row; null while only a detail arrived. */
  row: SearchResultItem | null;
  /** The sanitized body, cached after the reader fetched it (SPEC F3). */
  detail: MessageDetailView | null;
  cachedAt: number;
}

/**
 * The local copy of one draft. `server` is the last acknowledged copy; the
 * top-level fields hold the local edits, so offline drafting and the restore
 * review can always show the local text (SPEC F9).
 */
export interface LocalDraft {
  draftId: string;
  accountId: string;
  /** The copy the server last acknowledged, when one exists. */
  server: DraftView | null;
  identity: { address: string } | null;
  recipients: MessageRecipients | null;
  subject: string | null;
  markdown: string | null;
  /** The revision the local edits are based on. */
  baseRevision: number;
  /** True while the local edits have no server acknowledgement. */
  dirty: boolean;
  /** The generation the server issued when this draft last synced. */
  recoveryGeneration: string;
  updatedAt: number;
}

/** One upload whose bytes stay in Dexie until the server acknowledges them. */
export interface LocalUpload {
  localId: string;
  draftId: string;
  accountId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** The bytes themselves. Cleared once the server acknowledges the upload. */
  bytes: Blob;
  /** The upload id the server issued, once it acknowledges the bytes. */
  serverId: string | null;
  /** The generation the upload request was created under. */
  recoveryGeneration: string;
  createdAt: number;
}

/** The occurrence one queued mail action was aimed at, frozen at queue time. */
export interface FrozenTarget {
  accountId: string;
  folderId: string;
  messageId: string;
  occurrenceId: string;
  /** The local revision observed when the action was queued. */
  revision: number;
  /** The CONDSTORE value observed when the action was queued, when one did. */
  modseq: string | null;
}

/** The edit fields one draft save carries, matching `PATCH /drafts/:id`. */
export interface DraftEditPatch {
  identity?: { address: string } | null;
  recipients?: MessageRecipients | null;
  subject?: string | null;
  markdown?: string | null;
}

/**
 * One frozen queue payload. Reconnection replays exactly this value; the
 * scope never grows to messages that arrived later (SPEC F9).
 */
export type QueuedPayload =
  | { kind: "draft-save"; draftId: string; baseRevision: number; patch: DraftEditPatch }
  | { kind: "upload"; localUploadId: string }
  | { kind: "send"; draftId: string; idempotencyKey: string; baseRevision: number }
  | {
      kind: "flag";
      targets: FrozenTarget[];
      flag: "unread" | "flagged";
      value: boolean;
      idempotencyKey: string;
    }
  | {
      kind: "move";
      targets: FrozenTarget[];
      destinationFolderId: string;
      idempotencyKey: string;
    };

/** Every action family the queue can hold. */
export type QueuedKind = QueuedPayload["kind"];

/** Why one queue item waits for a person instead of the network. */
export type ReviewReason = "server_restored" | "uncertain_send" | "draft_conflict";

/** The life cycle of one queued action. */
export type QueuedState = "pending" | "synced" | "review" | "failed";

/** One entry in the durable action queue (SPEC F9). */
export interface QueuedAction {
  localId: string;
  payload: QueuedPayload;
  state: QueuedState;
  /** Present while the item waits for a person (SPEC F9). */
  reviewReason: ReviewReason | null;
  /** The last definitive refusal, for the interface to show. */
  failure: string | null;
  attempts: number;
  /** The generation the server issued when this action was created. */
  recoveryGeneration: string;
  queuedAt: number;
  syncedAt: number | null;
}

/** The restore review marker the session probe sets (SPEC section 10). */
export interface RestoreMarker {
  /** The generation the server issues now. */
  serverGeneration: string;
  /** The generation this device held before the change. */
  previousGeneration: string;
  markedAt: number;
}

/** The singleton keys the `meta` table holds. */
export const META_KEYS = {
  serverGeneration: "serverGeneration",
  restore: "restore",
  lastSyncedAt: "lastSyncedAt",
} as const;
