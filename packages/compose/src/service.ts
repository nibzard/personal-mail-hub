import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  accounts,
  draftUploads,
  drafts,
  events,
  outboundMessages,
  uploads,
  uploadKey,
  type AccountIdentity,
  type EmailAddress,
  type Recipients,
  type Storage,
  type Upload,
} from "@mail-hub/database";
import type { MailHubDatabase } from "@mail-hub/database";
import type { MessageRecipients } from "@mail-hub/contracts";
import type { MailHubTransaction, MutationGate } from "@mail-hub/recovery";
import { createHash, randomUUID } from "node:crypto";
import { ComposeError } from "./errors.ts";
import {
  normalizeContentType,
  normalizeFilename,
  normalizeMarkdown,
  normalizeRecipients,
  normalizeSubject,
  resolveIdentity,
  validateUploadBytes,
} from "./validation.ts";

/**
 * Draft editing and durable uploads (SPEC F6 and F9).
 *
 * One service owns editable drafts and the files they reference:
 *
 * 1. Every mutation passes the recovery-generation gate before it writes
 *    (SPEC section 7, step 1).
 * 2. Draft updates carry their base revision. A stale base rejects with the
 *    server's current revision, so two devices never silently overwrite each
 *    other; the client asks which copy to keep (SPEC F9).
 * 3. Uploads persist in durable storage before the row that references them
 *    commits, and the stored hash must match the computed one before the
 *    upload is acknowledged (SPEC section 8).
 * 4. A queued send locks its draft. While locked, every edit path rejects,
 *    so the queued snapshot stays the frozen record (SPEC F7). Only a
 *    definitive failure unlocks the draft again.
 *
 * The Markdown editor debounces autosave on the client; the server side of
 * that contract is the revision-aware update alone.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Context for one durable mutation: the generation the client captured. */
export interface MutationContext {
  requestGeneration?: string | null;
}

/** Input for one new draft. Reply context has its own path (SPEC F6). */
export interface CreateDraftInput {
  accountId: string;
  /** The From choice. Absent takes the account's default identity. */
  identity?: { address: string } | null;
  recipients?: MessageRecipients | null;
  subject?: string | null;
  markdown?: string | null;
}

/** Editable draft fields. `undefined` leaves a field unchanged. */
export interface UpdateDraftInput {
  /** The revision the caller basing this edit on. */
  baseRevision: number;
  /** An explicit From choice; `null` returns to the account's default identity. */
  identity?: { address: string } | null;
  /** `null` clears every list; an object replaces the whole set. */
  recipients?: MessageRecipients | null;
  /** `null` clears the subject. */
  subject?: string | null;
  markdown?: string | null;
}

/** Input for one upload. Bytes are written to durable storage verbatim. */
export interface CreateUploadInput {
  accountId: string;
  filename: string;
  contentType?: string | null;
  bytes: Uint8Array;
}

/** One editable draft as stored. */
export interface DraftRecord {
  id: string;
  accountId: string;
  identity: EmailAddress;
  recipients: Recipients;
  subject: string | null;
  markdown: string;
  revision: number;
  lockedBySend: string | null;
  updatedAt: Date;
}

/** One durable upload as stored. */
export interface UploadRecord {
  id: string;
  accountId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

/** One upload attached to a draft, with its position. */
export interface DraftAttachmentRecord extends UploadRecord {
  ordinal: number;
}

/** The result of verifying every upload a draft references (SPEC F6). */
export interface DraftUploadVerification {
  draftId: string;
  ok: boolean;
  uploads: { uploadId: string; filename: string; verified: boolean }[];
}

export class ComposeService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly storage: Storage,
    private readonly gate: MutationGate,
  ) {}

  /**
   * Create one draft. The From identity is selected here: an absent choice
   * takes the account's default, and an explicit choice must name a
   * configured identity of the account (SPEC F6).
   */
  async createDraft(context: MutationContext, input: CreateDraftInput): Promise<DraftRecord> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("account id", input.accountId);
    const account = await this.requireAccount(input.accountId);
    const identity = resolveIdentity(account.identities, input.identity);
    const recipients = normalizeRecipients(input.recipients);
    const subject = normalizeSubject(input.subject);
    const markdown = normalizeMarkdown(input.markdown);

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(drafts)
        .values({ accountId: account.id, identity, recipients, subject, markdown })
        .returning();
      const row = inserted[0]!;
      await recordComposeEvent(tx, "user", "draft.created", "draft", row.id, {
        account: account.id,
        identity: identity.address,
        recipientCount:
          recipients.to.length + (recipients.cc?.length ?? 0) + (recipients.bcc?.length ?? 0),
        hasSubject: subject !== null,
      });
      return toDraftRecord(row);
    });
  }

  /**
   * Apply one revision-aware draft edit (SPEC F9). The base revision must
   * match the stored one; a mismatch rejects with the server's current
   * revision so the client can prompt a choice instead of overwriting.
   */
  async updateDraft(context: MutationContext, draftId: string, input: UpdateDraftInput): Promise<DraftRecord> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("draft id", draftId);
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) {
      throw new ComposeError("invalid_request", "The base revision must be a positive integer.");
    }

    return this.db.transaction(async (tx) => {
      const row = await lockEditableDraft(tx, draftId);
      if (row.revision !== input.baseRevision) {
        throw new ComposeError(
          "draft_stale",
          `This draft changed elsewhere; the server holds revision ${row.revision}.`,
          row.revision,
        );
      }

      const changed: string[] = [];
      const patch: Partial<typeof drafts.$inferInsert> = {};
      if (input.identity !== undefined) {
        const account = await this.requireAccount(row.accountId, tx);
        patch.identity = resolveIdentity(account.identities, input.identity);
        changed.push("identity");
      }
      if (input.recipients !== undefined) {
        patch.recipients = normalizeRecipients(input.recipients);
        changed.push("recipients");
      }
      if (input.subject !== undefined) {
        patch.subject = normalizeSubject(input.subject);
        changed.push("subject");
      }
      if (input.markdown !== undefined) {
        patch.markdown = normalizeMarkdown(input.markdown);
        changed.push("markdown");
      }

      if (changed.length === 0) {
        return toDraftRecord(row);
      }
      const updated = await tx
        .update(drafts)
        .set({ ...patch, revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(drafts.id, draftId))
        .returning();
      const next = updated[0]!;
      await recordComposeEvent(tx, "user", "draft.updated", "draft", draftId, {
        fromRevision: row.revision,
        toRevision: next.revision,
        changed,
      });
      return toDraftRecord(next);
    });
  }

  /** Read one live draft. A deleted draft is gone. */
  async readDraft(draftId: string): Promise<DraftRecord> {
    requireUuid("draft id", draftId);
    const rows = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), isNull(drafts.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ComposeError("not_found", "No draft exists with this identifier.");
    }
    return toDraftRecord(row);
  }

  /** List live drafts, newest edit first, optionally for one account. */
  async listDrafts(accountId?: string): Promise<DraftRecord[]> {
    if (accountId !== undefined) {
      requireUuid("account id", accountId);
    }
    const rows = await this.db
      .select()
      .from(drafts)
      .where(accountId === undefined ? isNull(drafts.deletedAt) : and(eq(drafts.accountId, accountId), isNull(drafts.deletedAt)))
      .orderBy(desc(drafts.updatedAt));
    return rows.map(toDraftRecord);
  }

  /**
   * Soft-delete one draft. Upload rows never disappear here: outbound
   * snapshots keep their files alive after the draft is gone (SPEC F6).
   */
  async deleteDraft(context: MutationContext, draftId: string): Promise<void> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("draft id", draftId);
    await this.db.transaction(async (tx) => {
      const row = await lockEditableDraft(tx, draftId);
      const deletedAt = new Date();
      await tx.update(drafts).set({ deletedAt }).where(eq(drafts.id, draftId));
      await recordComposeEvent(tx, "user", "draft.deleted", "draft", draftId, { revision: row.revision });
    });
  }

  /**
   * Store one upload durably, then acknowledge it (SPEC F6). The bytes land
   * in durable storage and hash to the recorded value before the database
   * row commits, so an acknowledged upload is always retrievable.
   */
  async createUpload(context: MutationContext, input: CreateUploadInput): Promise<UploadRecord> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("account id", input.accountId);
    await this.requireAccount(input.accountId);
    const filename = normalizeFilename(input.filename);
    const contentType = normalizeContentType(input.contentType);
    validateUploadBytes(input.bytes);

    const id = randomUUID();
    const storageKey = uploadKey(id);
    const sha256 = sha256Hex(input.bytes);
    const stored = await this.storage.durable.put(storageKey, input.bytes);
    if (stored.sha256 !== sha256 || stored.sizeBytes !== input.bytes.byteLength) {
      throw new ComposeError(
        "upload_unverified",
        "The stored upload did not match its computed hash or size; the upload was not acknowledged.",
      );
    }

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(uploads)
        .values({
          id,
          accountId: input.accountId,
          filename,
          contentType,
          sizeBytes: input.bytes.byteLength,
          storageKey,
          sha256,
        })
        .returning();
      const row = inserted[0]!;
      await recordComposeEvent(tx, "user", "upload.created", "upload", row.id, {
        account: input.accountId,
        filename,
        contentType,
        sizeBytes: row.sizeBytes,
        sha256,
      });
      return toUploadRecord(row);
    });
  }

  /**
   * Attach one upload to a draft at the next position. The upload must
   * belong to the draft's account; account boundaries apply to drafts and
   * uploads alike (SPEC section 8).
   */
  async attachUpload(context: MutationContext, draftId: string, uploadId: string): Promise<DraftAttachmentRecord> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("draft id", draftId);
    requireUuid("upload id", uploadId);
    return this.db.transaction(async (tx) => {
      const draft = await lockEditableDraft(tx, draftId);
      const upload = await requireUpload(tx, uploadId);
      if (upload.accountId !== draft.accountId) {
        throw new ComposeError(
          "invalid_request",
          "The upload belongs to a different account than the draft.",
        );
      }
      const next = await nextOrdinal(tx, draftId);
      await tx.insert(draftUploads).values({ draftId, uploadId, ordinal: next });
      await recordComposeEvent(tx, "user", "draft.upload_attached", "draft", draftId, {
        uploadId,
        ordinal: next,
        filename: upload.filename,
      });
      return { ...toUploadRecord(upload), ordinal: next };
    });
  }

  /** Detach one upload from a draft. The upload row and its bytes remain. */
  async detachUpload(context: MutationContext, draftId: string, uploadId: string): Promise<void> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("draft id", draftId);
    requireUuid("upload id", uploadId);
    await this.db.transaction(async (tx) => {
      await lockEditableDraft(tx, draftId);
      const removed = await tx
        .delete(draftUploads)
        .where(and(eq(draftUploads.draftId, draftId), eq(draftUploads.uploadId, uploadId)))
        .returning({ uploadId: draftUploads.uploadId });
      if (removed.length === 0) {
        throw new ComposeError("not_found", "The draft does not reference this upload.");
      }
      await recordComposeEvent(tx, "user", "draft.upload_detached", "draft", draftId, { uploadId });
    });
  }

  /** List the uploads a draft references, in attachment order. */
  async listDraftAttachments(draftId: string): Promise<DraftAttachmentRecord[]> {
    requireUuid("draft id", draftId);
    await this.readDraft(draftId);
    const rows = await this.db
      .select({ upload: uploads, ordinal: draftUploads.ordinal })
      .from(draftUploads)
      .innerJoin(uploads, eq(draftUploads.uploadId, uploads.id))
      .where(eq(draftUploads.draftId, draftId))
      .orderBy(draftUploads.ordinal);
    return rows.map((row) => ({ ...toUploadRecord(row.upload), ordinal: row.ordinal }));
  }

  /**
   * Verify every upload a draft references against durable storage (SPEC
   * F6): a send may queue only after all referenced files are present and
   * their bytes still hash to the recorded value.
   */
  async verifyDraftUploads(draftId: string): Promise<DraftUploadVerification> {
    const attachments = await this.listDraftAttachments(draftId);
    const results: DraftUploadVerification["uploads"] = [];
    for (const attachment of attachments) {
      const verified = await this.verifyUploadRow(attachment.id);
      results.push({ uploadId: attachment.id, filename: attachment.filename, verified });
    }
    return { draftId, ok: results.every((result) => result.verified), uploads: results };
  }

  /** Re-read one upload row and check its durable bytes against the record. */
  private async verifyUploadRow(uploadId: string): Promise<boolean> {
    const rows = await this.db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      return false;
    }
    return verifyStoredUpload(this.storage, row);
  }

  private async requireAccount(
    accountId: string,
    handle: MailHubDatabase | MailHubTransaction = this.db,
  ): Promise<{ id: string; identities: AccountIdentity[] }> {
    const rows = await handle.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ComposeError("not_found", "No account exists with this identifier.");
    }
    return { id: row.id, identities: row.identities };
  }
}

/**
 * Lock one draft for its queued send (SPEC F7). Call this inside the
 * transaction that commits the outbound snapshot, so the snapshot, its job,
 * and the draft lock commit together. The revision must match what the send
 * froze; a draft already locked by another attempt rejects.
 */
export async function lockDraftForSend(
  tx: MailHubTransaction,
  draftId: string,
  revision: number,
  outboundId: string,
): Promise<DraftRecord> {
  requireUuid("draft id", draftId);
  requireUuid("outbound id", outboundId);
  const row = await lockDraftRow(tx, draftId);
  if (row.revision !== revision) {
    throw new ComposeError(
      "draft_stale",
      `The draft moved to revision ${row.revision}; the send snapshot is stale.`,
      row.revision,
    );
  }
  if (row.lockedBySend === outboundId) {
    return toDraftRecord(row);
  }
  if (row.lockedBySend !== null) {
    throw new ComposeError(
      "draft_locked",
      "This draft is already locked by another send attempt.",
    );
  }
  const updated = await tx
    .update(drafts)
    .set({ lockedBySend: outboundId })
    .where(eq(drafts.id, draftId))
    .returning();
  await recordComposeEvent(tx, "system", "draft.locked", "draft", draftId, {
    outboundId,
    revision: row.revision,
  });
  return toDraftRecord(updated[0]!);
}

/**
 * Unlock a draft after its send definitively failed (SPEC F7), returning it
 * to editing. Commit the failure status first: only a `failed` outbound row
 * may release its lock, and an unresolved attempt never does.
 */
export async function unlockDraftAfterFailure(tx: MailHubTransaction, outboundId: string): Promise<number> {
  requireUuid("outbound id", outboundId);
  const outbound = await tx
    .select({ status: outboundMessages.status })
    .from(outboundMessages)
    .where(eq(outboundMessages.id, outboundId))
    .limit(1);
  const row = outbound[0];
  if (row === undefined) {
    throw new ComposeError("not_found", "No outbound message exists with this identifier.");
  }
  if (row.status !== "failed") {
    throw new ComposeError(
      "invalid_request",
      "Only a definitively failed send unlocks its draft; unresolved attempts stay locked.",
    );
  }
  const released = await tx
    .update(drafts)
    .set({ lockedBySend: null })
    .where(eq(drafts.lockedBySend, outboundId))
    .returning({ id: drafts.id });
  for (const draft of released) {
    await recordComposeEvent(tx, "system", "draft.unlocked", "draft", draft.id, { outboundId });
  }
  return released.length;
}

/** Check an upload's durable bytes against its recorded hash. */
async function verifyStoredUpload(storage: Storage, row: Upload): Promise<boolean> {
  const stat = await storage.durable.stat(row.storageKey);
  if (stat === null || stat.sizeBytes !== row.sizeBytes) {
    return false;
  }
  return storage.durable.verify(row.storageKey, row.sha256);
}

type DraftRow = typeof drafts.$inferSelect;

/** Lock one live draft for edit checks. Deleted and unknown drafts are gone. */
async function lockEditableDraft(tx: MailHubTransaction, draftId: string): Promise<DraftRow> {
  const row = await lockDraftRow(tx, draftId);
  if (row.deletedAt !== null) {
    throw new ComposeError("not_found", "No draft exists with this identifier.");
  }
  if (row.lockedBySend !== null) {
    throw new ComposeError(
      "draft_locked",
      "This draft is locked by a queued send and can no longer be edited.",
    );
  }
  return row;
}

async function lockDraftRow(tx: MailHubTransaction, draftId: string): Promise<DraftRow> {
  const rows = await tx.select().from(drafts).where(eq(drafts.id, draftId)).for("update").limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ComposeError("not_found", "No draft exists with this identifier.");
  }
  return row;
}

async function requireUpload(tx: MailHubTransaction, uploadId: string): Promise<Upload> {
  const rows = await tx.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ComposeError("not_found", "No upload exists with this identifier.");
  }
  return row;
}

/** The next attachment position of one draft: one past the current highest. */
async function nextOrdinal(tx: MailHubTransaction, draftId: string): Promise<number> {
  const rows = await tx
    .select({ highest: sql<number | null>`max(${draftUploads.ordinal})` })
    .from(draftUploads)
    .where(eq(draftUploads.draftId, draftId));
  const highest = rows[0]?.highest ?? null;
  return highest === null ? 0 : Number(highest) + 1;
}

function toDraftRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    identity: row.identity,
    recipients: normalizeRecipients(row.recipients),
    subject: row.subject,
    markdown: row.markdown,
    revision: row.revision,
    lockedBySend: row.lockedBySend,
    updatedAt: row.updatedAt,
  };
}

function toUploadRecord(row: Upload): UploadRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    createdAt: row.createdAt,
  };
}

/** Record one compose audit event. Payloads never contain message text. */
async function recordComposeEvent(
  tx: MailHubTransaction,
  actor: "user" | "system",
  type: string,
  entityType: "draft" | "upload",
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(events).values({ actor, type, entityType, entityId, payload });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new ComposeError("invalid_request", `The ${kind} must be a UUID.`);
  }
}
