import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  attachments as attachmentsTable,
  bodies,
  draftUploads,
  drafts,
  events,
  messages,
  outboundMessages,
  outboundUploads,
  outboundMimeKey,
  uploads,
  type EmailAddress,
  type MailHubDatabase,
  type OutboundMessage,
  type Recipients,
  type RecipientResult,
  type Storage,
} from "@mail-hub/database";
import {
  HtmlSanitizer,
  parseMime,
  SANITIZER_VERSION,
  LOCATOR_VERSION,
  markThreadJobsDirty,
  BODY_INDEX_MAX_CHARS,
  makeSnippet,
  normalizeIndexText,
  recipientsIndexText,
  senderIndexText,
} from "@mail-hub/ingestion";
import type { SmtpSubmitReport } from "@mail-hub/contracts";
import { assessJob, type ControlStatus, type MailHubTransaction, type MutationGate } from "@mail-hub/recovery";
import { lockDraftForSend, unlockDraftAfterFailure, type MutationContext } from "@mail-hub/compose";
import { createHash, randomUUID } from "node:crypto";
import { SendError } from "./errors.ts";
import { composeOutboundMime } from "./mime.ts";
import { renderMarkdownHtml } from "./render.ts";
import type { SmtpCredentials, SmtpCredentialsResolver, SmtpSubmitter } from "./smtp.ts";

/**
 * Immutable outbound snapshots and SMTP sending (SPEC F7).
 *
 * One service owns the whole outbound life of a draft:
 *
 * 1. `queueSend` validates the request the way every mutation does — the
 *    recovery generation first, then the draft revision, recipients, and
 *    completed uploads — freezes the From identity, envelope, visible
 *    headers, reply headers, Markdown, and attachments, generates
 *    `Message-ID` and `Date` once, builds the exact MIME bytes, stores them
 *    durably, and commits the snapshot with its draft lock and one event.
 *    Blind-copy recipients stay out of the bytes and live in the envelope
 *    snapshot only.
 * 2. `executeOutbound` claims the queued row atomically — `sending` is
 *    persisted before SMTP opens — and never re-submits a row that left
 *    `queued`. Only one claim wins, and a lease expiring never authorizes a
 *    second submission.
 * 3. Recipient-level results and the final response are recorded verbatim.
 *    A positive final response commits `sent` together with the local
 *    message record: one logical message keyed by account and original hash,
 *    its body, attachments, and search text, plus the thread-reconciliation
 *    job. Partial acceptance shows per-recipient results instead of inventing
 *    one outcome.
 * 4. A definitive refusal means `failed` and releases the draft for editing.
 *    An unclassifiable outcome means `outcome_unknown`; the draft stays
 *    locked and nothing resends automatically. The separate Sent-copy append
 *    (T022) starts from `sent_copy_status = 'pending'`.
 */

/** Event recorded when a snapshot and its draft lock commit (SPEC F7 step 2). */
export const SEND_QUEUED_EVENT = "send.queued";

/** Event recorded when SMTP accepted the message (SPEC F7 step 4). */
export const SEND_SENT_EVENT = "send.sent";

/** Event recorded when SMTP definitively refused the message (SPEC F7 step 6). */
export const SEND_FAILED_EVENT = "send.failed";

/** Event recorded when a submission's outcome cannot be classified (SPEC F7 step 6). */
export const SEND_UNKNOWN_EVENT = "send.outcome_unknown";

/** Longest idempotency key accepted, so keys stay index-friendly. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Outbound rows one sweep claims per pass, bounded like every batch. */
export const DEFAULT_SEND_SWEEP_LIMIT = 10;

/** Control-state access the send service needs. `RecoveryControls` satisfies it. */
export interface SendControlState extends MutationGate {
  readStatus(): Promise<ControlStatus>;
}

/** Injected execution dependencies. Queueing needs none of them. */
export interface OutboundExecutionDeps {
  /** Submits the exact stored bytes over one verified connection. */
  submit?: SmtpSubmitter;
  /** Resolves an account's SMTP settings and credentials. */
  resolveCredentials?: SmtpCredentialsResolver;
  /** Sanitizer for the HTML alternative; defaults to the shared server pass. */
  sanitizer?: HtmlSanitizer;
  /** Clock and identifier factories, overridable in tests. */
  now?: () => Date;
  generateId?: () => string;
}

/** One queued-send request as a client submits it (SPEC F7 step 1). */
export interface QueueSendInput {
  draftId: string;
  idempotencyKey: string;
  /** The draft revision the sender based this request on. */
  baseRevision: number;
}

/** What `queueSend` returns: the snapshot, and whether this call created it. */
export interface QueueSendResult {
  created: boolean;
  outbound: OutboundRecord;
}

/** One outbound snapshot as stored. */
export interface OutboundRecord {
  id: string;
  draftId: string | null;
  accountId: string;
  status: OutboundMessage["status"];
  sentCopyStatus: OutboundMessage["sentCopyStatus"];
  identity: EmailAddress;
  recipients: Recipients;
  subject: string | null;
  rfcMessageId: string;
  recipientResults: RecipientResult[];
  smtpResponse: Record<string, unknown> | null;
  lastError: Record<string, unknown> | null;
  createdAt: Date;
  sentAt: Date | null;
}

/** What one sweep pass over the queued set did. */
export interface SendSweepSummary {
  scanned: number;
  submitted: number;
  skippedStale: number;
  blocked: boolean;
}

type DraftRow = typeof drafts.$inferSelect;
type UploadRow = typeof uploads.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class OutboundService {
  private readonly sanitizer: HtmlSanitizer;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(
    private readonly db: MailHubDatabase,
    private readonly storage: Storage,
    private readonly controls: SendControlState,
    private readonly execution: OutboundExecutionDeps = {},
  ) {
    this.sanitizer = execution.sanitizer ?? new HtmlSanitizer();
    this.now = execution.now ?? (() => new Date());
    this.generateId = execution.generateId ?? randomUUID;
  }

  /**
   * Queue one send (SPEC F7 steps 1 and 2). The recovery gate runs before the
   * idempotency lookup; a repeated key returns the existing snapshot, and a
   * changed request under the same key conflicts. The snapshot, its draft
   * lock, and one event commit together, after the exact MIME bytes are
   * durably stored.
   */
  async queueSend(context: MutationContext, input: QueueSendInput): Promise<QueueSendResult> {
    // SPEC section 7, step 1: the generation check precedes the idempotency
    // lookup, even when the key is absent from the database.
    const { generation } = await this.controls.gateMutation(context.requestGeneration);
    requireUuid("draft id", input.draftId);
    if (
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new SendError(
        "invalid_request",
        `The idempotency key must hold 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      );
    }
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1) {
      throw new SendError("invalid_request", "The base revision must be a positive integer.");
    }

    const requestHash = hashRequest(input.draftId, input.baseRevision);
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing !== null) {
      return { created: false, outbound: await this.existingSnapshot(existing, requestHash) };
    }

    // Everything heavy — upload verification, rendering, composition, and the
    // durable write — happens before the transaction opens. The transaction
    // re-checks the draft under its lock, so nothing mutable slips in.
    const draft = await this.loadEditableDraft(input.draftId);
    if (draft.revision !== input.baseRevision) {
      throw new SendError(
        "draft_stale",
        `This draft changed elsewhere; the server holds revision ${draft.revision}.`,
        draft.revision,
      );
    }
    if (draft.lockedBySend !== null) {
      throw new SendError("draft_locked", "This draft is already locked by a queued send.");
    }
    const envelope = envelopeOf(draft);
    if (envelope.length === 0) {
      throw new SendError("recipients_required", "A send needs at least one recipient.");
    }

    const attachments = await this.loadVerifiedAttachments(draft.accountId, draft.id);
    const html = renderMarkdownHtml(draft.markdown, this.sanitizer);
    const rfcMessageId = generateRfcMessageId(draft.identity.address, this.generateId);
    const date = this.now();

    const bytes = await composeOutboundMime({
      identity: draft.identity,
      to: draft.recipients.to,
      cc: draft.recipients.cc ?? [],
      subject: draft.subject,
      markdown: draft.markdown,
      html,
      rfcMessageId,
      date,
      inReplyTo: draft.inReplyTo,
      referenceIds: draft.referenceIds,
      attachments: attachments.map((attachment) => ({
        filename: attachment.upload.filename,
        contentType: attachment.upload.contentType,
        content: attachment.bytes,
      })),
    });
    await verifyComposedMessage(bytes, rfcMessageId, attachments.length);

    const outboundId = this.generateId();
    const storageKey = outboundMimeKey(outboundId);
    const mimeSha256 = sha256Hex(bytes);
    const stored = await this.storage.durable.put(storageKey, bytes);
    if (stored.sha256 !== mimeSha256 || stored.sizeBytes !== bytes.byteLength) {
      throw new SendError(
        "upload_unverified",
        "The stored MIME bytes did not match their computed hash or size; the send was not queued.",
      );
    }

    try {
      return {
        created: true,
        outbound: await this.db.transaction(async (tx) => {
          const locked = await lockDraftRow(tx, draft.id);
          if (locked.deletedAt !== null) {
            throw new SendError("not_found", "No draft exists with this identifier.");
          }
          if (locked.revision !== input.baseRevision) {
            throw new SendError(
              "draft_stale",
              `This draft changed elsewhere; the server holds revision ${locked.revision}.`,
              locked.revision,
            );
          }
          if (locked.lockedBySend !== null) {
            throw new SendError("draft_locked", "This draft is already locked by a queued send.");
          }

          const inserted = await tx
            .insert(outboundMessages)
            .values({
              id: outboundId,
              accountId: draft.accountId,
              recoveryGeneration: generation,
              idempotencyKey: input.idempotencyKey,
              requestHash,
              draftId: draft.id,
              draftRevision: draft.revision,
              identity: { address: draft.identity.address, name: draft.identity.name },
              envelopeSender: draft.identity.address,
              envelopeRecipients: envelope,
              status: "queued",
              threadId: draft.threadId,
              replyParentId: draft.replyParentId,
              inReplyTo: draft.inReplyTo,
              referenceIds: draft.referenceIds,
              recipients: draft.recipients,
              subject: draft.subject,
              markdownSource: draft.markdown,
              html,
              rfcMessageId,
              mimeStorageKey: storageKey,
              mimeSha256,
            })
            .returning();
          const row = inserted[0]!;
          if (attachments.length > 0) {
            await tx.insert(outboundUploads).values(
              attachments.map((attachment) => ({
                outboundId,
                uploadId: attachment.upload.id,
                ordinal: attachment.ordinal,
              })),
            );
          }
          await lockDraftForSend(tx, draft.id, draft.revision, outboundId);
          await recordSendEvent(tx, "user", SEND_QUEUED_EVENT, outboundId, {
            accountId: draft.accountId,
            draftId: draft.id,
            draftRevision: draft.revision,
            recipients: envelope.length,
            attachments: attachments.length,
            rfcMessageId,
          });
          return toOutboundRecord(row);
        }),
      };
    } catch (cause) {
      // A concurrent request with the same key inserted first; the shared
      // idempotency rules answer instead of surfacing the race.
      if (isUniqueViolation(cause)) {
        const raced = await this.findByIdempotencyKey(input.idempotencyKey);
        if (raced !== null) {
          return { created: false, outbound: await this.existingSnapshot(raced, requestHash) };
        }
      }
      throw cause;
    }
  }

  /** Read one outbound snapshot. */
  async readOutbound(outboundId: string): Promise<OutboundRecord> {
    requireUuid("outbound id", outboundId);
    const rows = await this.db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new SendError("not_found", "No outbound message exists with this identifier.");
    }
    return toOutboundRecord(row);
  }

  /**
   * Sweep the queued set and submit what this deployment still owns (SPEC F7
   * step 3). Rows from another recovery generation are skipped: a restored
   * database keeps its pending sends until reconciliation dispositions them.
   */
  async executeQueued(limit = DEFAULT_SEND_SWEEP_LIMIT): Promise<SendSweepSummary> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready") {
      return { scanned: 0, submitted: 0, skippedStale: 0, blocked: true };
    }
    const queued = await this.db
      .select({ id: outboundMessages.id, generation: outboundMessages.recoveryGeneration })
      .from(outboundMessages)
      .where(eq(outboundMessages.status, "queued"))
      .orderBy(asc(outboundMessages.createdAt))
      .limit(limit);

    let submitted = 0;
    let skippedStale = 0;
    for (const row of queued) {
      // A row keeps the generation it was queued with; a lease renewal or a
      // retry never upgrades it (SPEC section 7).
      if (assessJob(status, row.generation) === "stale") {
        skippedStale += 1;
        continue;
      }
      const outcome = await this.executeOutbound(row.id);
      if (outcome.submitted) {
        submitted += 1;
      }
    }
    return { scanned: queued.length, submitted, skippedStale, blocked: false };
  }

  /**
   * Submit one outbound snapshot (SPEC F7 steps 3 and 4). The claim is the
   * only door to SMTP: `sending` persists before the connection opens, and a
   * row that already left `queued` is never submitted again. The mutable
   * draft is not consulted; the frozen snapshot is the whole request.
   */
  async executeOutbound(outboundId: string): Promise<OutboundRecord & { submitted: boolean }> {
    requireUuid("outbound id", outboundId);
    if (this.execution.submit === undefined || this.execution.resolveCredentials === undefined) {
      throw new SendError(
        "send_unavailable",
        "This process cannot submit mail: no SMTP submitter is configured.",
      );
    }

    const rows = await this.db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)).limit(1);
    const before = rows[0];
    if (before === undefined) {
      throw new SendError("not_found", "No outbound message exists with this identifier.");
    }
    if (before.status !== "queued") {
      return { ...toOutboundRecord(before), submitted: false };
    }
    const status = await this.controls.readStatus();
    if (status.state !== "ready" || assessJob(status, before.recoveryGeneration) === "stale") {
      return { ...toOutboundRecord(before), submitted: false };
    }

    // The claim: exactly one writer moves this row from `queued` to
    // `sending`, and that move persists before any network work.
    const claimed = await this.db
      .update(outboundMessages)
      .set({ status: "sending", sendingStartedAt: this.now() })
      .where(and(eq(outboundMessages.id, outboundId), eq(outboundMessages.status, "queued")))
      .returning();
    const row = claimed[0];
    if (row === undefined) {
      const current = await this.readOutbound(outboundId);
      return { ...current, submitted: false };
    }

    // The stored bytes are the request; submit nothing the record cannot vouch for.
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.durable.get(row.mimeStorageKey);
    } catch {
      const updated = await this.recordUnknown(row, null, {
        code: "mime_missing",
        message: "The stored MIME bytes could not be read; nothing was submitted.",
      });
      return { ...toOutboundRecord(updated), submitted: true };
    }
    if (sha256Hex(bytes) !== row.mimeSha256) {
      const updated = await this.recordUnknown(row, null, {
        code: "mime_mismatch",
        message: "The stored MIME bytes no longer match their recorded hash; nothing was submitted.",
      });
      return { ...toOutboundRecord(updated), submitted: true };
    }

    let credentials: SmtpCredentials;
    try {
      credentials = await this.execution.resolveCredentials(row.accountId);
    } catch (cause) {
      // The claim is spent and nothing was submitted, but the account's
      // submission settings are missing or unreadable; that is not a refusal
      // the server stated, so the outcome stays open.
      const updated = await this.recordUnknown(row, null, {
        code: "credentials_unavailable",
        message: cause instanceof Error ? cause.message.split("\n")[0]! : "The account's submission settings could not be resolved.",
      });
      return { ...toOutboundRecord(updated), submitted: true };
    }
    let report: SmtpSubmitReport;
    try {
      report = await this.execution.submit({
        host: credentials.host,
        port: credentials.port,
        security: credentials.security,
        username: credentials.username,
        password: credentials.password,
        envelope: { from: row.envelopeSender, to: [...row.envelopeRecipients] },
        raw: bytes,
      });
    } catch (cause) {
      report = {
        state: "unknown",
        response: null,
        responseCode: null,
        recipients: [],
        error: {
          code: "submitter_error",
          message: cause instanceof Error ? cause.message.split(": ")[0]! : String(cause),
        },
      };
    }

    if (report.state === "accepted") {
      return { ...toOutboundRecord(await this.recordAcceptance(row, report, bytes)), submitted: true };
    }
    if (report.state === "rejected") {
      return { ...toOutboundRecord(await this.recordFailure(row, report)), submitted: true };
    }
    return { ...toOutboundRecord(await this.recordUnknown(row, report, null)), submitted: true };
  }

  /**
   * Commit one acceptance (SPEC F7 step 4 and the local-sent-record rules):
   * one transaction sets `sent`, creates or reuses the local message by its
   * account and original hash, writes its body, attachments, and search text,
   * marks the thread job, records the event, and leaves the Sent append job
   * to start from `pending`.
   */
  private async recordAcceptance(
    row: OutboundMessage,
    report: SmtpSubmitReport,
    bytes: Uint8Array,
  ): Promise<OutboundMessage> {
    const recipientResults = recipientResultsOf(row.envelopeRecipients, report);
    const parsed = await parseMime(bytes);

    // Repeated acceptance, or a Sent import that raced this handler, may
    // already hold a message with the same original hash; the unique index
    // serializes us onto the reuse path.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const existing = await findMessageByHash(tx, row.accountId, row.mimeSha256);
          const messageId =
            existing?.id ??
            (await this.insertLocalSentMessage(tx, row, parsed, bytes));
          const updated = await tx
            .update(outboundMessages)
            .set({
              status: "sent",
              logicalMessageId: messageId,
              smtpResponse: smtpResponseOf(report),
              recipientResults,
              sentAt: this.now(),
              lastError: null,
            })
            .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "sending")))
            .returning();
          await recordSendEvent(tx, "system", SEND_SENT_EVENT, row.id, {
            accountId: row.accountId,
            messageId,
            accepted: recipientResults.filter((result) => result.accepted).length,
            rejected: recipientResults.filter((result) => !result.accepted).length,
            partial: recipientResults.some((result) => !result.accepted),
          });
          return updated[0] ?? row;
        });
      } catch (cause) {
        if (attempt === 0 && isUniqueViolation(cause)) {
          continue;
        }
        throw cause;
      }
    }
  }

  /**
   * One definitive refusal (SPEC F7 step 6): `failed`, the responses it did
   * produce, and the draft lock released for editing.
   */
  private async recordFailure(row: OutboundMessage, report: SmtpSubmitReport): Promise<OutboundMessage> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(outboundMessages)
        .set({
          status: "failed",
          smtpResponse: smtpResponseOf(report),
          recipientResults: recipientResultsOf(row.envelopeRecipients, report),
          lastError: report.error === null ? null : { ...report.error },
        })
        .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "sending")))
        .returning();
      const failed = updated[0] ?? row;
      await unlockDraftAfterFailure(tx, row.id);
      await recordSendEvent(tx, "system", SEND_FAILED_EVENT, row.id, {
        accountId: row.accountId,
        code: report.error?.code ?? "unknown",
      });
      return failed;
    });
  }

  /**
   * One unclassifiable outcome (SPEC F7 step 6): `outcome_unknown`, whatever
   * responses arrived, and the draft still locked. Nothing resends
   * automatically; a deliberate resend is a new snapshot and key.
   */
  private async recordUnknown(
    row: OutboundMessage,
    report: SmtpSubmitReport | null,
    error: { code: string; message: string } | null,
  ): Promise<OutboundMessage> {
    const failure = error ?? report?.error ?? null;
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(outboundMessages)
        .set({
          status: "outcome_unknown",
          smtpResponse: report === null ? null : smtpResponseOf(report),
          recipientResults: recipientResultsOf(row.envelopeRecipients, report),
          lastError: failure === null ? null : { code: failure.code, message: failure.message },
        })
        .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "sending")))
        .returning();
      const unknown = updated[0] ?? row;
      await recordSendEvent(tx, "system", SEND_UNKNOWN_EVENT, row.id, {
        accountId: row.accountId,
        code: failure?.code ?? "unknown",
      });
      return unknown;
    });
  }

  /**
   * Create the local message record of one accepted send (SPEC F7, local sent
   * record). The outbound MIME object is the message original; the body is
   * born fetched; Bcc addresses stay private local metadata inside the
   * recipients column; thread reconciliation places the row.
   */
  private async insertLocalSentMessage(
    tx: MailHubTransaction,
    row: OutboundMessage,
    parsed: Awaited<ReturnType<typeof parseMime>>,
    bytes: Uint8Array,
  ): Promise<string> {
    const messageId = this.generateId();
    await tx.insert(messages).values({
      id: messageId,
      accountId: row.accountId,
      messageId: row.rfcMessageId,
      inReplyTo: row.inReplyTo,
      referenceIds: row.referenceIds,
      threadId: row.threadId,
      parentMessageId: null,
      threadLinkState: "pending",
      threadDirty: true,
      sender: { address: row.identity.address, name: row.identity.name },
      replyTo: null,
      recipients: row.recipients,
      subject: row.subject,
      sentAt: parsed.sentAt ?? this.now(),
      snippet: makeSnippet(row.markdownSource),
      hasAttachments: parsed.attachments.length > 0,
      sizeBytes: bytes.byteLength,
      fetchedBody: true,
      originalStorageKey: row.mimeStorageKey,
      originalSha256: row.mimeSha256,
      senderText: normalizeIndexText(senderIndexText(row.identity)),
      recipientsText: normalizeIndexText(recipientsIndexText(row.recipients)),
      subjectText: normalizeIndexText(row.subject ?? ""),
      bodyIndexText: truncate(normalizeIndexText(row.markdownSource), BODY_INDEX_MAX_CHARS),
    });
    await tx.insert(bodies).values({
      messageId,
      textPlain: row.markdownSource,
      htmlSanitized: row.html,
      sanitizerVersion: SANITIZER_VERSION,
    });
    for (const part of parsed.attachments) {
      await tx.insert(attachmentsTable).values({
        messageId,
        partPath: part.partPath,
        locatorVersion: LOCATOR_VERSION,
        decodedSha256: part.decodedSha256,
        contentId: part.contentId,
        disposition: part.disposition,
        filename: part.filename,
        contentType: part.contentType,
        sizeBytes: part.sizeBytes,
      });
    }
    await markThreadJobsDirty(tx, row.accountId, {
      messageIds: [messageId],
      identifiers: [row.rfcMessageId],
    });
    return messageId;
  }

  /** Load the draft a send freezes, without locking it yet. */
  private async loadEditableDraft(draftId: string): Promise<DraftRow> {
    const rows = await this.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, draftId), isNull(drafts.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new SendError("not_found", "No draft exists with this identifier.");
    }
    return row;
  }

  /**
   * Every upload the draft references, read from durable storage and verified
   * against its recorded hash (SPEC F6: a send queues only after all
   * referenced files are uploaded and verified).
   */
  private async loadVerifiedAttachments(
    accountId: string,
    draftId: string,
  ): Promise<{ upload: UploadRow; ordinal: number; bytes: Uint8Array }[]> {
    const links = await this.db
      .select({ upload: uploads, ordinal: draftUploads.ordinal })
      .from(draftUploads)
      .innerJoin(uploads, eq(uploads.id, draftUploads.uploadId))
      .where(and(eq(draftUploads.draftId, draftId), eq(uploads.accountId, accountId)))
      .orderBy(asc(draftUploads.ordinal));

    const verified: { upload: UploadRow; ordinal: number; bytes: Uint8Array }[] = [];
    for (const link of links) {
      const stat = await this.storage.durable.stat(link.upload.storageKey);
      if (stat === null || stat.sizeBytes !== link.upload.sizeBytes) {
        throw new SendError(
          "upload_unverified",
          `The file ${link.upload.filename} is missing from durable storage; the send was not queued.`,
        );
      }
      if (!(await this.storage.durable.verify(link.upload.storageKey, link.upload.sha256))) {
        throw new SendError(
          "upload_unverified",
          `The file ${link.upload.filename} no longer matches its recorded hash; the send was not queued.`,
        );
      }
      verified.push({ upload: link.upload, ordinal: link.ordinal, bytes: await this.storage.durable.get(link.upload.storageKey) });
    }
    return verified;
  }

  private async findByIdempotencyKey(key: string): Promise<OutboundMessage | null> {
    const rows = await this.db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The shared idempotency answer: replay the snapshot, or conflict. */
  private async existingSnapshot(row: OutboundMessage, requestHash: string): Promise<OutboundRecord> {
    if (row.requestHash !== requestHash) {
      throw new SendError(
        "idempotency_conflict",
        "This idempotency key belongs to a different send request.",
      );
    }
    return toOutboundRecord(row);
  }
}

/** The envelope recipients of one draft: visible and blind, in list order. */
function envelopeOf(draft: DraftRow): string[] {
  const recipients = draft.recipients;
  return [
    ...recipients.to,
    ...(recipients.cc ?? []),
    ...(recipients.bcc ?? []),
  ].map((address) => address.address);
}

/**
 * Verify the composed bytes before they are stored (SPEC F7 step 2): the
 * message must parse, carry the frozen identifier, and hold every file.
 */
async function verifyComposedMessage(bytes: Uint8Array, rfcMessageId: string, attachments: number): Promise<void> {
  const parsed = await parseMime(bytes);
  if (parsed.messageId !== rfcMessageId) {
    throw new SendError("invalid_request", "The composed message lost its generated identifier.");
  }
  if (parsed.attachments.length !== attachments) {
    throw new SendError("invalid_request", "The composed message did not carry every attachment.");
  }
}

/** One `<random@domain>` identifier, generated once per snapshot. */
function generateRfcMessageId(identityAddress: string, generateId: () => string): string {
  const domain = identityAddress.split("@")[1] ?? "localhost";
  return `<${generateId()}@${domain}>`;
}

/** Recipient-level results for every envelope address, in envelope order. */
function recipientResultsOf(
  envelope: string[],
  report: SmtpSubmitReport | null,
): RecipientResult[] {
  if (report === null || report.recipients.length === 0) {
    // Without per-recipient detail, one positive final response covers the
    // whole envelope; anything else leaves each outcome open.
    const acceptedAll = report?.state === "accepted";
    return envelope.map((address) => ({
      address,
      accepted: acceptedAll,
      response: acceptedAll ? (report!.response ?? null) : null,
    }));
  }
  const byAddress = new Map(report.recipients.map((entry) => [entry.address, entry]));
  return envelope.map((address) => {
    const entry = byAddress.get(address);
    return {
      address,
      accepted: entry?.accepted ?? false,
      response: entry?.response ?? null,
    };
  });
}

/** The final SMTP response, without credentials (SPEC section 8). */
function smtpResponseOf(report: SmtpSubmitReport): Record<string, unknown> | null {
  if (report.response === null && report.responseCode === null) {
    return null;
  }
  return { response: report.response, responseCode: report.responseCode };
}

async function findMessageByHash(
  tx: MailHubTransaction,
  accountId: string,
  sha256: string,
): Promise<{ id: string } | null> {
  const rows = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.originalSha256, sha256)))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return rows[0] ?? null;
}

async function lockDraftRow(tx: MailHubTransaction, draftId: string): Promise<DraftRow> {
  const rows = await tx.select().from(drafts).where(eq(drafts.id, draftId)).for("update").limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new SendError("not_found", "No draft exists with this identifier.");
  }
  return row;
}

/** Record one send audit event. Payloads never contain message text. */
async function recordSendEvent(
  tx: MailHubTransaction,
  actor: "user" | "system",
  type: string,
  outboundId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(events).values({ actor, type, entityType: "outbound_message", entityId: outboundId, payload });
}

function toOutboundRecord(row: OutboundMessage): OutboundRecord {
  return {
    id: row.id,
    draftId: row.draftId,
    accountId: row.accountId,
    status: row.status,
    sentCopyStatus: row.sentCopyStatus,
    identity: row.identity,
    recipients: row.recipients,
    subject: row.subject,
    rfcMessageId: row.rfcMessageId,
    recipientResults: row.recipientResults,
    smtpResponse: row.smtpResponse,
    lastError: row.lastError,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}

function hashRequest(draftId: string, baseRevision: number): string {
  return createHash("sha256").update(JSON.stringify({ draftId: draftId.toLowerCase(), baseRevision })).digest("hex");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new SendError("invalid_request", `The ${kind} must be a UUID.`);
  }
}

/** PostgreSQL rejects two live rows with one (account, hash) pair. */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "23505"
  );
}
