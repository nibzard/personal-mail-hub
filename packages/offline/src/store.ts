import { Dexie, type EntityTable } from "dexie";
import type { MessageDetailView, SearchResultItem } from "@mail-hub/contracts";
import {
  META_KEYS,
  type CachedMessage,
  type LocalDraft,
  type LocalUpload,
  type QueuedAction,
  type QueuedPayload,
} from "./records.ts";

/*
 * The Dexie store behind the offline contract (SPEC F9). Recent mail,
 * local drafts, upload bytes, and queued actions live in IndexedDB, so a
 * browser without connectivity still reads downloaded messages and keeps
 * drafting. The store holds no transport: the replay controller in
 * `sync.ts` owns when its records leave the device.
 */

/** How many downloaded messages the store keeps. */
export const RECENT_MAIL_LIMIT = 500;

/** How many synced queue entries the store keeps, for the sync history. */
export const SYNCED_ACTION_LIMIT = 100;

/**
 * How long settled local records stay: synced draft copies and uploads the
 * server draft references outlive their queue entries for review, then go.
 */
export const SETTLED_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

class OfflineDatabase extends Dexie {
  messages!: EntityTable<CachedMessage, "messageId">;
  drafts!: EntityTable<LocalDraft, "draftId">;
  uploads!: EntityTable<LocalUpload, "localId">;
  queue!: EntityTable<QueuedAction, "localId">;
  meta!: EntityTable<{ key: string; value: unknown }, "key">;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      messages: "messageId, cachedAt",
      drafts: "draftId, updatedAt",
      uploads: "localId, draftId, createdAt",
      queue: "localId, state, queuedAt",
      meta: "key",
    });
  }
}

export interface OfflineStoreOptions {
  /** The IndexedDB database name. */
  name?: string;
  /** The clock, injectable for deterministic tests. */
  now?: () => number;
  /** The local id factory, injectable for deterministic tests. */
  newId?: () => string;
}

/** One durable offline store (SPEC F9). */
export class OfflineStore {
  private readonly db: OfflineDatabase;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: OfflineStoreOptions = {}) {
    this.db = new OfflineDatabase(options.name ?? "mail-hub-offline");
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Close the database. Records stay on disk. */
  close(): void {
    this.db.close();
  }

  /** One stored-clock reading. */
  timestamp(): number {
    return this.now();
  }

  /** One stored id, unique inside this device. */
  generateId(): string {
    return this.newId();
  }

  //
  // Recent mail
  //

  /** Cache one list row, keeping any detail already downloaded. */
  async cacheMessageRow(row: SearchResultItem): Promise<void> {
    // The read and the write share one transaction: an unlocked pair let a
    // row cache and a detail cache read the same base record and each write
    // dropped the other's half.
    await this.db.transaction("rw", this.db.messages, async () => {
      const existing = await this.db.messages.get(row.messageId);
      await this.db.messages.put({
        messageId: row.messageId,
        row,
        detail: existing?.detail ?? null,
        cachedAt: this.now(),
      });
    });
  }

  /** Cache one sanitized detail after the reader fetched it (SPEC F3). */
  async cacheMessageDetail(detail: MessageDetailView): Promise<void> {
    await this.db.transaction("rw", this.db.messages, async () => {
      const existing = await this.db.messages.get(detail.id);
      await this.db.messages.put({
        messageId: detail.id,
        row: existing?.row ?? null,
        detail,
        cachedAt: this.now(),
      });
    });
  }

  /** Every downloaded list row, newest first. */
  async cachedRows(): Promise<SearchResultItem[]> {
    const records = await this.db.messages.toArray();
    return records
      .filter((record): record is CachedMessage & { row: SearchResultItem } => record.row !== null)
      .map((record) => record.row)
      .sort(compareCachedRows);
  }

  /** One downloaded detail, when the reader fetched it before. */
  async cachedDetail(messageId: string): Promise<MessageDetailView | null> {
    return (await this.db.messages.get(messageId))?.detail ?? null;
  }

  /** Keep only the newest downloaded messages. */
  async pruneRecentMail(keep = RECENT_MAIL_LIMIT): Promise<void> {
    const records = await this.db.messages.orderBy("cachedAt").reverse().toArray();
    const stale = records.slice(keep).map((record) => record.messageId);
    if (stale.length > 0) {
      await this.db.messages.bulkDelete(stale);
    }
  }

  //
  // Local drafts
  //

  /** Write the local copy of one draft (SPEC F9: offline drafting). */
  async putLocalDraft(draft: LocalDraft): Promise<void> {
    await this.db.drafts.put({ ...draft, updatedAt: this.now() });
  }

  /** The local copy of one draft, when this device holds one. */
  async getLocalDraft(draftId: string): Promise<LocalDraft | null> {
    return (await this.db.drafts.get(draftId)) ?? null;
  }

  /** Every local draft, most recently touched first. */
  async localDrafts(): Promise<LocalDraft[]> {
    return this.db.drafts.orderBy("updatedAt").reverse().toArray();
  }

  /** Drop one local copy. The server copy, when one exists, stays. */
  async deleteLocalDraft(draftId: string): Promise<void> {
    await this.db.drafts.delete(draftId);
  }

  //
  // Uploads
  //

  /** Persist one upload before any acknowledgement (SPEC F6). */
  async putPendingUpload(upload: Omit<LocalUpload, "localId" | "createdAt">): Promise<LocalUpload> {
    const record: LocalUpload = {
      ...upload,
      localId: this.newId(),
      createdAt: this.now(),
    };
    await this.db.uploads.put(record);
    return record;
  }

  /** One upload record, by its local id. */
  async getUpload(localId: string): Promise<LocalUpload | null> {
    return (await this.db.uploads.get(localId)) ?? null;
  }

  /** The uploads one draft references. */
  async uploadsForDraft(draftId: string): Promise<LocalUpload[]> {
    return this.db.uploads.where("draftId").equals(draftId).toArray();
  }

  /** Every upload still waiting for its server acknowledgement. */
  async pendingUploads(): Promise<LocalUpload[]> {
    const all = await this.db.uploads.toArray();
    return all.filter((upload) => upload.serverId === null);
  }

  /** Apply one partial update to an upload record. */
  async updateUpload(
    localId: string,
    patch: Partial<Omit<LocalUpload, "localId" | "createdAt">>,
  ): Promise<void> {
    await this.db.uploads.update(localId, patch);
  }

  /**
   * Record the server's acknowledgement. The bytes leave Dexie here, the
   * earliest point the server owns them (SPEC F6).
   */
  async markUploadAcknowledged(localId: string, serverId: string): Promise<void> {
    await this.db.uploads.update(localId, { serverId, bytes: new Blob([]) });
  }

  /** Record that the server draft now references one acknowledged upload. */
  async markUploadAttached(localId: string): Promise<void> {
    await this.db.uploads.update(localId, { attachedAt: this.now() });
  }

  /** Drop one upload record and its bytes, with the action that named them. */
  async deleteUpload(localId: string): Promise<void> {
    await this.db.uploads.delete(localId);
  }

  //
  // The action queue
  //

  /**
   * Freeze one action into the queue. The payload is copied, so later edits
   * to the caller's object never change what replay sends (SPEC F9).
   */
  async enqueue(payload: QueuedPayload, recoveryGeneration: string): Promise<QueuedAction> {
    const action = this.buildAction(payload, recoveryGeneration);
    await this.db.queue.put(action);
    return { ...action, payload: structuredClone(action.payload) };
  }

  /**
   * Persist one upload and its queue action in one IndexedDB transaction, so
   * a crash between the two writes can never leave bytes that wait forever
   * (SPEC F6 and F9).
   */
  async putPendingUploadWithAction(
    upload: Omit<LocalUpload, "localId" | "createdAt">,
    recoveryGeneration: string,
  ): Promise<{ action: QueuedAction; upload: LocalUpload }> {
    const record: LocalUpload = { ...upload, localId: this.newId(), createdAt: this.now() };
    const action = this.buildAction(
      { kind: "upload", localUploadId: record.localId },
      recoveryGeneration,
    );
    await this.db.transaction("rw", [this.db.uploads, this.db.queue], async () => {
      await this.db.uploads.put(record);
      await this.db.queue.put(action);
    });
    return { action: { ...action, payload: structuredClone(action.payload) }, upload: record };
  }

  /** Every queued action, oldest first. */
  async allActions(): Promise<QueuedAction[]> {
    return this.db.queue.orderBy("queuedAt").toArray();
  }

  /** The actions still waiting to leave this device. */
  async pendingActions(): Promise<QueuedAction[]> {
    const pending = await this.db.queue.where("state").equals("pending").toArray();
    return pending.sort(
      (a, b) => a.queuedAt - b.queuedAt || replayRank(a.payload.kind) - replayRank(b.payload.kind),
    );
  }

  /** One queued action by its local id, when it still exists. */
  async getAction(localId: string): Promise<QueuedAction | null> {
    return (await this.db.queue.get(localId)) ?? null;
  }

  /** The actions waiting for a person, not the network (SPEC F9). */
  async reviewActions(): Promise<QueuedAction[]> {
    const review = await this.db.queue.where("state").equals("review").toArray();
    return review.sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Apply one partial update to a queued action. */
  async updateAction(
    localId: string,
    patch: Partial<Omit<QueuedAction, "localId" | "queuedAt">>,
  ): Promise<void> {
    await this.db.queue.update(localId, patch);
  }

  /** Drop one queued action. Local drafts and files stay (SPEC F9). */
  async deleteAction(localId: string): Promise<void> {
    await this.db.queue.delete(localId);
  }

  /** Keep only the newest synced entries in the sync history. */
  async pruneSyncedActions(keep = SYNCED_ACTION_LIMIT): Promise<void> {
    const synced = await this.db.queue.where("state").equals("synced").toArray();
    const stale = synced
      .sort((a, b) => (b.syncedAt ?? b.queuedAt) - (a.syncedAt ?? a.queuedAt))
      .slice(keep)
      .map((action) => action.localId);
    if (stale.length > 0) {
      await this.db.queue.bulkDelete(stale);
    }
  }

  /**
   * Drop local records the server owns and nothing waits on: draft copies
   * with no unsynchronized edits, and uploads the server draft references.
   * Dirty drafts and unacknowledged or unlinked uploads stay, because the
   * review surface and the send gate read them. Nothing else deletes these
   * rows, so without this sweep Dexie grows without bound.
   */
  async pruneSettledLocalRecords(
    retentionMs = SETTLED_RECORD_RETENTION_MS,
  ): Promise<void> {
    const cutoff = this.now() - retentionMs;
    const drafts = await this.db.drafts.toArray();
    const staleDrafts = drafts
      .filter((draft) => !draft.dirty && draft.updatedAt < cutoff)
      .map((draft) => draft.draftId);
    if (staleDrafts.length > 0) {
      await this.db.drafts.bulkDelete(staleDrafts);
    }
    const uploads = await this.db.uploads.toArray();
    const staleUploads = uploads
      .filter((upload) => upload.attachedAt !== null && upload.attachedAt < cutoff)
      .map((upload) => upload.localId);
    if (staleUploads.length > 0) {
      await this.db.uploads.bulkDelete(staleUploads);
    }
  }

  //
  // Metadata
  //

  /** Read one metadata value, when the store holds one. */
  async readMeta<T>(key: string): Promise<T | null> {
    return ((await this.db.meta.get(key))?.value as T | undefined) ?? null;
  }

  /** Write one metadata value. */
  async writeMeta(key: string, value: unknown): Promise<void> {
    await this.db.meta.put({ key, value });
  }

  /** The generation the server last issued, when this device knows one. */
  async serverGeneration(): Promise<string | null> {
    return this.readMeta<string>(META_KEYS.serverGeneration);
  }

  /** One queue entry, built with its own local id and a cloned payload. */
  private buildAction(payload: QueuedPayload, recoveryGeneration: string): QueuedAction {
    return {
      localId: this.newId(),
      payload: structuredClone(payload),
      state: "pending",
      reviewReason: null,
      failure: null,
      attempts: 0,
      recoveryGeneration,
      queuedAt: this.now(),
      syncedAt: null,
    };
  }
}

/**
 * True when an IndexedDB write failed for storage quota. Callers report the
 * error and skip queueing, because the bytes never persisted (SPEC F6).
 */
export function isQuotaError(error: unknown): boolean {
  const candidate = error as { name?: string; inner?: { name?: string } } | null;
  return (
    candidate?.name === "QuotaExceededError" ||
    candidate?.inner?.name === "QuotaExceededError"
  );
}

/** Newest downloaded row first, matching the list's server order closely. */
function compareCachedRows(a: SearchResultItem, b: SearchResultItem): number {
  const at = a.sentAt === null ? 0 : Date.parse(a.sentAt);
  const bt = b.sentAt === null ? 0 : Date.parse(b.sentAt);
  if (at !== bt) {
    return bt - at;
  }
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

/**
 * The replay order of equal timestamps. One editor burst can queue a save
 * and its send in the same millisecond, and the store's key order is
 * meaningless there, so the kinds carry their own order: bytes reach the
 * server before the work that needs them, and a draft's save reaches the
 * server before its send. Otherwise the send can replay first and mail the
 * pre-edit content.
 */
function replayRank(kind: QueuedPayload["kind"]): number {
  switch (kind) {
    case "upload":
      return 0;
    case "draft-save":
      return 1;
    case "flag":
    case "move":
      return 2;
    case "send":
      return 3;
  }
}
