import { and, asc, desc, eq, inArray, isNull, lt, not, or, sql, type SQL } from "drizzle-orm";
import {
  attachments as attachmentsTable,
  bodies,
  draftUploads,
  drafts,
  events,
  folders,
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
  MAX_MESSAGE_BYTES,
  makeSnippet,
  normalizeIndexText,
  recipientsIndexText,
  senderIndexText,
} from "@mail-hub/ingestion";
import type { SmtpSubmitReport } from "@mail-hub/contracts";
import { assessJob, type ControlStatus, type MailHubTransaction, type MutationGate } from "@mail-hub/recovery";
import {
  ATTACHMENTS_TOTAL_MAX_BYTES,
  lockDraftForSend,
  unlockDraftAfterFailure,
  unlockDraftAfterSend,
  type MutationContext,
} from "@mail-hub/compose";
import { createHash, randomUUID } from "node:crypto";
import { SendError } from "./errors.ts";
import { composeOutboundMime } from "./mime.ts";
import { renderMarkdownHtml } from "./render.ts";
import type { SmtpCredentials, SmtpCredentialsResolver, SmtpSubmitter } from "./smtp.ts";
import type { SentCopyDestination, SentCopyMailbox, SentCopySessionFactory } from "./sent-copy.ts";

/**
 * Immutable outbound snapshots, SMTP sending, and Sent-copy recovery
 * (SPEC F7).
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
 *    So does a local failure before SMTP opened — unreadable stored bytes,
 *    unresolvable credentials — because nothing was submitted and no server
 *    stated anything. An unclassifiable outcome means `outcome_unknown`; the
 *    draft stays locked and nothing resends automatically. Acceptance ends
 *    the lock in the same transaction that sets `sent`: the snapshot is the
 *    record, and the draft is deletable again while the outbound references
 *    keep its uploaded files alive.
 * 5. `executeSentCopyAppend` runs the separate Sent append job on the stored
 *    bytes. It reconciles first — a verified copy already in the Sent folder
 *    ends the job without a second append — appends only when absence is
 *    proved, and keeps `sent` whatever the append does. Append retries can
 *    never invoke SMTP.
 * 6. `recoverAbandonedAttempts` holds crashed `sending` and `appending` rows
 *    as unknown once their attempt lease expires, and `reconcileUnknownOutcome`
 *    resolves an uncertain send only from durable server evidence: a Sent copy
 *    whose bytes hash to the frozen snapshot. Without evidence the unknown
 *    stays, and no path in this service ever resubmits it.
 */

/** Event recorded when a snapshot and its draft lock commit (SPEC F7 step 2). */
export const SEND_QUEUED_EVENT = "send.queued";

/** Event recorded when SMTP accepted the message (SPEC F7 step 4). */
export const SEND_SENT_EVENT = "send.sent";

/** Event recorded when SMTP definitively refused the message (SPEC F7 step 6). */
export const SEND_FAILED_EVENT = "send.failed";

/** Event recorded when a submission's outcome cannot be classified (SPEC F7 step 6). */
export const SEND_UNKNOWN_EVENT = "send.outcome_unknown";

/** Event recorded when the Sent folder holds the verified stored copy (SPEC F7 step 5). */
export const SEND_SENT_COPY_STORED_EVENT = "send.sent_copy_stored";

/** Event recorded when the Sent append was definitively refused (SPEC F7 step 5). */
export const SEND_SENT_COPY_FAILED_EVENT = "send.sent_copy_failed";

/** Event recorded when the Sent append outcome cannot be classified (SPEC F7 step 5). */
export const SEND_SENT_COPY_UNKNOWN_EVENT = "send.sent_copy_unknown";

/** Event recorded when a Sent append exhausts its attempts and leaves the sweep. */
export const SEND_SENT_COPY_HALTED_EVENT = "send.sent_copy_halted";

/** Event recorded when an unknown outcome exhausts its reconcile passes and leaves the sweep. */
export const SEND_RECONCILE_HALTED_EVENT = "send.reconcile_halted";

/** Longest idempotency key accepted, so keys stay index-friendly. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Outbound rows one sweep claims per pass, bounded like every batch. */
export const DEFAULT_SEND_SWEEP_LIMIT = 10;

/**
 * How long one claimed attempt stays with its worker before recovery may
 * hold it (SPEC F7). The claims stamp `sendingStartedAt` and
 * `appendStartedAt`; a hold is allowed only after this lease expires, so a
 * live submission under a rolling restart or a second worker is never
 * flipped to unknown while it is still running.
 */
export const ATTEMPT_LEASE_MS = 10 * 60_000;

/**
 * Append attempts and reconcile passes one row gets before the sweeps set it
 * aside for review. A row that keeps failing or keeps finding no evidence
 * must not occupy the bounded sweep window forever; the halt event records
 * where the row stopped.
 */
export const SEND_SWEEP_ATTEMPT_CAP = 20;

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
  /** Opens the IMAP connection the Sent-copy job appends and reconciles over. */
  openSentCopy?: SentCopySessionFactory;
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
  /** Rows whose attempt threw; each keeps its claim until its lease expires. */
  rowErrors: number;
  blocked: boolean;
}

/** What one sweep pass over the due Sent copies did. */
export interface SentCopySweepSummary {
  scanned: number;
  attempted: number;
  skippedStale: number;
  /** Rows whose attempt threw; each keeps its claim until its lease expires. */
  rowErrors: number;
  blocked: boolean;
}

/** What one sweep pass over the unknown outcomes did. */
export interface UnknownSweepSummary {
  scanned: number;
  resolved: number;
  skippedStale: number;
  /** Rows whose pass threw; the unknown state is untouched either way. */
  rowErrors: number;
  blocked: boolean;
}

/** What one startup recovery pass over the abandoned attempts did. */
export interface AbandonedAttemptSummary {
  /** Sending rows held as `outcome_unknown`. */
  heldSends: number;
  /** Append attempts held as `unknown`. */
  heldAppends: number;
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

    // The request hash covers the attachment set too: attach and detach move
    // no revision, so the revision alone cannot tell two requests with
    // different files apart, and a reused key would silently replay the
    // first file set. The links are read without a lock here; the freeze
    // stores the hash of the set it actually froze.
    const requestHash = hashRequest(
      input.draftId,
      input.baseRevision,
      await this.readAttachmentLinks(input.draftId),
    );
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing !== null) {
      return { created: false, outbound: await this.existingSnapshot(existing, requestHash) };
    }

    // Everything heavy — upload verification, rendering, composition, and the
    // durable write — happens before the transaction opens. The transaction
    // re-checks the draft under its lock, so nothing mutable slips in. A
    // concurrent request with this key that created the snapshot first is
    // answered by the shared idempotency rules below, whatever stage of the
    // freeze the loser reached (SPEC F7 step 3).
    try {
      return {
        created: true,
        outbound: await this.freezeSnapshot(input, generation),
      };
    } catch (cause) {
      if (isUniqueViolation(cause) || isLostLockRace(cause)) {
        const raced = await this.findByIdempotencyKey(input.idempotencyKey);
        if (raced !== null) {
          return { created: false, outbound: await this.existingSnapshot(raced, requestHash) };
        }
      }
      throw cause;
    }
  }

  /**
   * Compose and durably store one snapshot, then commit it with its draft
   * lock in one transaction. Only the request that wins the draft lock gets
   * here; every later caller of `queueSend` reads the stored row instead.
   * The stored request hash describes the attachment set this freeze
   * actually verified, so a replay compares against what was frozen.
   */
  private async freezeSnapshot(
    input: QueueSendInput,
    generation: string,
  ): Promise<OutboundRecord> {
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
    const attachmentBytes = attachments.reduce(
      (total, attachment) => total + attachment.upload.sizeBytes,
      0,
    );
    if (attachmentBytes > ATTACHMENTS_TOTAL_MAX_BYTES) {
      throw new SendError(
        "invalid_request",
        `The attachments of this draft hold ${attachmentBytes} bytes in total, above the ${ATTACHMENTS_TOTAL_MAX_BYTES}-byte ceiling one message may carry; remove files before sending.`,
      );
    }
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
    if (bytes.byteLength > MAX_MESSAGE_BYTES) {
      // The aggregate bound on the referenced bytes should catch this first;
      // this check is the ceiling itself, so text and framing cannot slip a
      // message past what this deployment stores and servers accept.
      throw new SendError(
        "invalid_request",
        `The composed message is ${bytes.byteLength} bytes, above the ${MAX_MESSAGE_BYTES}-byte ceiling this deployment sends; remove files before sending.`,
      );
    }
    await verifyComposedMessage(bytes, rfcMessageId, attachments.length);

    const outboundId = this.generateId();
    const requestHash = hashRequest(
      input.draftId,
      input.baseRevision,
      attachments.map((attachment) => ({
        uploadId: attachment.upload.id,
        ordinal: attachment.ordinal,
      })),
    );
    const storageKey = outboundMimeKey(outboundId);
    const mimeSha256 = sha256Hex(bytes);
    const stored = await this.storage.durable.put(storageKey, bytes);
    if (stored.sha256 !== mimeSha256 || stored.sizeBytes !== bytes.byteLength) {
      throw new SendError(
        "upload_unverified",
        "The stored MIME bytes did not match their computed hash or size; the send was not queued.",
      );
    }

    return this.db.transaction(async (tx) => {
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
      // Attach and detach change the draft's files without moving its
      // revision, so the revision check above cannot see them. The link set
      // is re-read under the lock and must still match the set the bytes
      // were composed from; otherwise the send would carry files the draft
      // no longer names, or miss files it just gained (SPEC F7 step 1).
      const links = await tx
        .select({ uploadId: draftUploads.uploadId, ordinal: draftUploads.ordinal })
        .from(draftUploads)
        .where(eq(draftUploads.draftId, draft.id))
        .orderBy(asc(draftUploads.ordinal));
      if (!matchesFrozenAttachments(links, attachments)) {
        throw new SendError(
          "draft_stale",
          "This draft's attachments changed while the send was being frozen; read the draft again and retry.",
          locked.revision,
        );
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
    });
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
   * One row that throws cannot abort the pass: its attempt stays claimed,
   * and the lease-aged recovery hold picks it up later.
   */
  async executeQueued(limit = DEFAULT_SEND_SWEEP_LIMIT): Promise<SendSweepSummary> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready") {
      return { scanned: 0, submitted: 0, skippedStale: 0, rowErrors: 0, blocked: true };
    }
    const queued = await this.db
      .select({ id: outboundMessages.id, generation: outboundMessages.recoveryGeneration })
      .from(outboundMessages)
      .where(eq(outboundMessages.status, "queued"))
      .orderBy(asc(outboundMessages.createdAt))
      .limit(limit);

    let submitted = 0;
    let skippedStale = 0;
    let rowErrors = 0;
    for (const row of queued) {
      // A row keeps the generation it was queued with; a lease renewal or a
      // retry never upgrades it (SPEC section 7).
      if (assessJob(status, row.generation) === "stale") {
        skippedStale += 1;
        continue;
      }
      try {
        const outcome = await this.executeOutbound(row.id);
        if (outcome.submitted) {
          submitted += 1;
        }
      } catch {
        // The attempt stays claimed with its lease running; the next
        // recovery pass holds it once the lease expires.
        rowErrors += 1;
      }
    }
    return { scanned: queued.length, submitted, skippedStale, rowErrors, blocked: false };
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

    // The stored bytes are the request; submit nothing the record cannot
    // vouch for. A failure this early is local and definitive — SMTP never
    // opened, so nothing was submitted — and the draft returns to editing
    // instead of staying locked against an outcome that cannot arrive.
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.durable.get(row.mimeStorageKey);
    } catch {
      const updated = await this.recordFailure(row, {
        smtpResponse: null,
        recipientResults: [],
        error: {
          code: "mime_missing",
          message: "The stored MIME bytes could not be read; nothing was submitted.",
        },
      });
      return { ...toOutboundRecord(updated), submitted: true };
    }
    if (sha256Hex(bytes) !== row.mimeSha256) {
      const updated = await this.recordFailure(row, {
        smtpResponse: null,
        recipientResults: [],
        error: {
          code: "mime_mismatch",
          message: "The stored MIME bytes no longer match their recorded hash; nothing was submitted.",
        },
      });
      return { ...toOutboundRecord(updated), submitted: true };
    }

    let credentials: SmtpCredentials;
    try {
      credentials = await this.execution.resolveCredentials(row.accountId);
    } catch (cause) {
      // The claim is spent and nothing was submitted. The account's
      // submission settings are missing or unreadable — a wrong password, an
      // unmapped host — and no server stated anything; still, the attempt
      // itself is definitively over, so it fails and the draft is editable
      // again once the settings are corrected (SPEC F7 step 6).
      const updated = await this.recordFailure(row, {
        smtpResponse: null,
        recipientResults: [],
        error: {
          code: "credentials_unavailable",
          message: cause instanceof Error ? cause.message.split("\n")[0]! : "The account's submission settings could not be resolved.",
        },
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
      return {
        ...toOutboundRecord(
          await this.commitAcceptance(row, {
            fromStatus: "sending",
            bytes,
            smtpResponse: smtpResponseOf(report),
            recipientResults: recipientResultsOf(row.envelopeRecipients, report),
          }),
        ),
        submitted: true,
      };
    }
    if (report.state === "rejected") {
      return {
        ...toOutboundRecord(
          await this.recordFailure(row, {
            smtpResponse: smtpResponseOf(report),
            recipientResults: recipientResultsOf(row.envelopeRecipients, report),
            error: report.error === null ? null : { ...report.error },
          }),
        ),
        submitted: true,
      };
    }
    return { ...toOutboundRecord(await this.recordUnknown(row, report, null)), submitted: true };
  }

  /**
   * Sweep the due Sent copies of this deployment (SPEC F7 step 5). Rows whose
   * send left `sent`, and rows from another recovery generation, stay put:
   * a restored database keeps its pending work until reconciliation
   * dispositions it. Two row classes never occupy the bounded window: a row
   * that exhausted its append attempts, and a row whose unmapped-account
   * failure is still unmapped — the sweep cannot progress either until the
   * world changes, so neither may starve younger rows.
   */
  async appendDueSentCopies(limit = DEFAULT_SEND_SWEEP_LIMIT): Promise<SentCopySweepSummary> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready") {
      return { scanned: 0, attempted: 0, skippedStale: 0, rowErrors: 0, blocked: true };
    }
    const due = await this.db
      .select({ id: outboundMessages.id, generation: outboundMessages.recoveryGeneration })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.status, "sent"),
          inArray(outboundMessages.sentCopyStatus, ["pending", "failed", "unknown"]),
          lt(outboundMessages.sentCopyAttempts, SEND_SWEEP_ATTEMPT_CAP),
          // The recorded unmapped failure stays quiet only while the account
          // still maps no Sent folder; a fresh mapping makes the row due
          // again the moment it exists.
          not(
            sql`(${outboundMessages.sentCopyStatus} = 'failed'
              and ${outboundMessages.lastError} ->> 'code' = 'sent_folder_unmapped'
              and ${missingSentFolder()})`,
          ),
        ),
      )
      .orderBy(asc(outboundMessages.createdAt))
      .limit(limit);

    let attempted = 0;
    let skippedStale = 0;
    let rowErrors = 0;
    for (const row of due) {
      if (assessJob(status, row.generation) === "stale") {
        skippedStale += 1;
        continue;
      }
      try {
        const outcome = await this.executeSentCopyAppend(row.id);
        if (outcome.attempted) {
          attempted += 1;
        }
      } catch {
        rowErrors += 1;
      }
    }
    return { scanned: due.length, attempted, skippedStale, rowErrors, blocked: false };
  }

  /**
   * Run the Sent append job of one snapshot (SPEC F7 step 5). The job starts
   * only after confirmed acceptance, appends the exact stored bytes — never
   * SMTP — and reconciles before it writes: a copy already in the Sent folder
   * that hashes to the snapshot ends the job as `stored`, and an append
   * happens only once reconciliation proves the folder holds no such copy.
   * `appending` persists before the remote call, exactly like the SMTP claim.
   */
  async executeSentCopyAppend(outboundId: string): Promise<OutboundRecord & { attempted: boolean }> {
    requireUuid("outbound id", outboundId);
    if (this.execution.openSentCopy === undefined) {
      throw new SendError(
        "sent_copy_unavailable",
        "This process cannot store sent copies: no Sent-copy session factory is configured.",
      );
    }

    const rows = await this.db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)).limit(1);
    const before = rows[0];
    if (before === undefined) {
      throw new SendError("not_found", "No outbound message exists with this identifier.");
    }
    if (before.status !== "sent" || before.sentCopyStatus === "stored") {
      return { ...toOutboundRecord(before), attempted: false };
    }
    const status = await this.controls.readStatus();
    if (status.state !== "ready" || assessJob(status, before.recoveryGeneration) === "stale") {
      return { ...toOutboundRecord(before), attempted: false };
    }

    // The destination must be mapped before anything is appended (SPEC F1).
    // One unmapped folder fails the job once; later sweeps stay quiet until
    // the map changes, so a missing choice cannot flood the audit trail. A
    // missing mapping also answers nothing about an attempt whose outcome is
    // unknown: that record stays for review instead of being overwritten.
    const sentFolder = await this.findSentFolder(before.accountId);
    if (sentFolder === null) {
      if (
        before.sentCopyStatus === "unknown" ||
        (before.sentCopyStatus === "failed" && before.lastError?.code === "sent_folder_unmapped")
      ) {
        return { ...toOutboundRecord(before), attempted: false };
      }
      const failed = await this.concludeSentCopy(before, "unclaimed", {
        status: "failed",
        error: {
          code: "sent_folder_unmapped",
          message: "The account has no folder mapped to the Sent role; map one in settings to store the sent copy.",
        },
      });
      return { ...toOutboundRecord(failed), attempted: true };
    }

    // The claim: `appending` persists before the connection opens, and only
    // the claimer may conclude the attempt. The stamp starts the lease a
    // recovery hold waits for before calling the attempt abandoned.
    const claimed = await this.db
      .update(outboundMessages)
      .set({ sentCopyStatus: "appending", appendStartedAt: this.now() })
      .where(
        and(
          eq(outboundMessages.id, outboundId),
          eq(outboundMessages.status, "sent"),
          inArray(outboundMessages.sentCopyStatus, ["pending", "failed", "unknown"]),
        ),
      )
      .returning();
    const row = claimed[0];
    if (row === undefined) {
      const current = await this.readOutbound(outboundId);
      return { ...current, attempted: false };
    }

    let session: SentCopyMailbox;
    try {
      session = await this.execution.openSentCopy(row.accountId);
    } catch (cause) {
      const held = await this.concludeSentCopy(row, "claimed", {
        status: "unknown",
        error: {
          code: "session_unavailable",
          message: `The Sent-copy connection could not be opened: ${firstLine(cause)}`,
        },
      });
      return { ...toOutboundRecord(held), attempted: true };
    }
    try {
      // The stored bytes are the only bytes this job may append.
      let bytes: Uint8Array;
      try {
        bytes = await this.storage.durable.get(row.mimeStorageKey);
      } catch {
        const held = await this.concludeSentCopy(row, "claimed", {
          status: "unknown",
          error: {
            code: "mime_missing",
            message: "The stored MIME bytes could not be read; nothing was appended.",
          },
        });
        return { ...toOutboundRecord(held), attempted: true };
      }
      if (sha256Hex(bytes) !== row.mimeSha256) {
        const held = await this.concludeSentCopy(row, "claimed", {
          status: "unknown",
          error: {
            code: "mime_mismatch",
            message: "The stored MIME bytes no longer match their recorded hash; nothing was appended.",
          },
        });
        return { ...toOutboundRecord(held), attempted: true };
      }

      // Reconcile first (SPEC F7 step 5): a verified copy ends the job, a
      // same-identifier message with different bytes blocks the append, and
      // only a proved absence authorizes one.
      const evidence = await this.locateVerifiedCopy(session, sentFolder, row);
      if (evidence.kind === "verified") {
        const stored = await this.concludeSentCopy(row, "claimed", {
          status: "stored",
          destination: evidence.destination,
        });
        return { ...toOutboundRecord(stored), attempted: true };
      }
      if (evidence.kind === "conflict") {
        const held = await this.concludeSentCopy(row, "claimed", {
          status: "unknown",
          error: {
            code: "sent_copy_conflict",
            message:
              "The Sent folder holds a message with this identifier but different bytes; the copy was not verified and nothing was appended.",
          },
        });
        return { ...toOutboundRecord(held), attempted: true };
      }

      const appended = await session.appendMessage(sentFolder.path, bytes);
      if (appended.result === "rejected") {
        const failed = await this.concludeSentCopy(row, "claimed", {
          status: "failed",
          error: {
            code: "append_rejected",
            message: "The server refused the Sent append; the sent state is unchanged.",
          },
        });
        return { ...toOutboundRecord(failed), attempted: true };
      }
      if (appended.result === "appended" && appended.uidvalidity !== null && appended.uid !== null) {
        const stored = await this.concludeSentCopy(row, "claimed", {
          status: "stored",
          destination: { folderId: sentFolder.id, uidvalidity: appended.uidvalidity, uid: appended.uid },
        });
        return { ...toOutboundRecord(stored), attempted: true };
      }

      // The server gave no usable coordinates, or its response was lost:
      // reconcile before deciding anything, and never append twice for one
      // attempt (SPEC F7 step 5).
      const after = await this.locateVerifiedCopy(session, sentFolder, row);
      if (after.kind === "verified") {
        const stored = await this.concludeSentCopy(row, "claimed", {
          status: "stored",
          destination: after.destination,
        });
        return { ...toOutboundRecord(stored), attempted: true };
      }
      if (after.kind === "conflict") {
        const held = await this.concludeSentCopy(row, "claimed", {
          status: "unknown",
          error: {
            code: "sent_copy_conflict",
            message:
              "The Sent folder holds a message with this identifier but different bytes; the append outcome stays unknown.",
          },
        });
        return { ...toOutboundRecord(held), attempted: true };
      }
      if (appended.result === "appended") {
        // A positive append response with no destination coordinates: the
        // copy is stored as far as the server stated, and the next Sent
        // import records the occurrence itself.
        const stored = await this.concludeSentCopy(row, "claimed", {
          status: "stored",
          destination: { folderId: sentFolder.id, uidvalidity: null, uid: null },
        });
        return { ...toOutboundRecord(stored), attempted: true };
      }
      const held = await this.concludeSentCopy(row, "claimed", {
        status: "unknown",
        error: {
          code: "append_uncertain",
          message: `The Sent append response was lost: ${appended.reason}`,
        },
      });
      return { ...toOutboundRecord(held), attempted: true };
    } catch (cause) {
      const held = await this.concludeSentCopy(row, "claimed", {
        status: "unknown",
        error: {
          code: "session_error",
          message: `The Sent-copy session failed: ${firstLine(cause)}`,
        },
      });
      return { ...toOutboundRecord(held), attempted: true };
    } finally {
      await session.logout().catch(() => undefined);
    }
  }

  /**
   * Sweep the unknown outcomes of this deployment (SPEC F7 step 7). Every
   * pass is read-only towards SMTP: it only looks for durable server
   * evidence, and a row without evidence keeps its unknown state and reason.
   * A row that exhausted its passes, or whose account maps no Sent folder to
   * search, never occupies the bounded window; a fresh mapping makes the row
   * due again the moment it exists.
   */
  async reconcileUnknownOutcomes(limit = DEFAULT_SEND_SWEEP_LIMIT): Promise<UnknownSweepSummary> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready") {
      return { scanned: 0, resolved: 0, skippedStale: 0, rowErrors: 0, blocked: true };
    }
    const unknown = await this.db
      .select({ id: outboundMessages.id, generation: outboundMessages.recoveryGeneration })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.status, "outcome_unknown"),
          lt(outboundMessages.reconcileAttempts, SEND_SWEEP_ATTEMPT_CAP),
          not(missingSentFolder()),
        ),
      )
      .orderBy(asc(outboundMessages.createdAt))
      .limit(limit);

    let resolved = 0;
    let skippedStale = 0;
    let rowErrors = 0;
    for (const row of unknown) {
      if (assessJob(status, row.generation) === "stale") {
        skippedStale += 1;
        continue;
      }
      try {
        const outcome = await this.reconcileUnknownOutcome(row.id);
        if (outcome.reconciled) {
          resolved += 1;
        }
      } catch {
        rowErrors += 1;
      }
    }
    return { scanned: unknown.length, resolved, skippedStale, rowErrors, blocked: false };
  }

  /**
   * Reconcile one uncertain send (SPEC F7 step 7). The only evidence that
   * resolves it is a Sent-folder copy that carries the generated identifier
   * and hashes to the frozen snapshot; that evidence commits the same
   * acceptance transaction as a positive final response, sent state, local
   * index, and append outcome together. An empty Sent folder proves nothing,
   * and nothing here can resubmit the snapshot.
   */
  async reconcileUnknownOutcome(
    outboundId: string,
  ): Promise<OutboundRecord & { reconciled: boolean; reason: string | null }> {
    requireUuid("outbound id", outboundId);
    if (this.execution.openSentCopy === undefined) {
      throw new SendError(
        "sent_copy_unavailable",
        "This process cannot reconcile sends: no Sent-copy session factory is configured.",
      );
    }

    const rows = await this.db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)).limit(1);
    const before = rows[0];
    if (before === undefined) {
      throw new SendError("not_found", "No outbound message exists with this identifier.");
    }
    if (before.status !== "outcome_unknown") {
      return { ...toOutboundRecord(before), reconciled: false, reason: null };
    }
    const status = await this.controls.readStatus();
    if (status.state !== "ready" || assessJob(status, before.recoveryGeneration) === "stale") {
      return { ...toOutboundRecord(before), reconciled: false, reason: null };
    }

    const sentFolder = await this.findSentFolder(before.accountId);
    if (sentFolder === null) {
      return { ...toOutboundRecord(before), reconciled: false, reason: "sent_folder_unmapped" };
    }

    let session: SentCopyMailbox;
    try {
      session = await this.execution.openSentCopy(before.accountId);
    } catch (cause) {
      await this.noteReconcilePass(before);
      return { ...toOutboundRecord(before), reconciled: false, reason: `session_unavailable: ${firstLine(cause)}` };
    }
    try {
      const evidence = await this.locateVerifiedCopy(session, sentFolder, before);
      if (evidence.kind !== "verified") {
        // Neither an empty folder nor an unverified candidate proves anything
        // about the submission; the unknown keeps its recorded reason.
        await this.noteReconcilePass(before);
        return { ...toOutboundRecord(before), reconciled: false, reason: evidence.kind };
      }
      const bytes = await session.fetchOriginal(evidence.destination.uid!);
      if (bytes === null || sha256Hex(bytes) !== before.mimeSha256) {
        await this.noteReconcilePass(before);
        return { ...toOutboundRecord(before), reconciled: false, reason: "candidate_unreadable" };
      }
      const resolved = await this.commitAcceptance(before, {
        fromStatus: "outcome_unknown",
        bytes,
        // The durable responses the uncertain attempt recorded stay as they
        // are; reconciliation evidence is noted on the event instead.
        smtpResponse: before.smtpResponse,
        recipientResults: reconciledRecipientResults(before),
        sentCopy: evidence.destination,
        evidence: "verified_sent_copy",
      });
      return { ...toOutboundRecord(resolved), reconciled: true, reason: null };
    } finally {
      await session.logout().catch(() => undefined);
    }
  }

  /**
   * Count one evidence pass that settled nothing. A row that keeps finding
   * no evidence must not occupy the bounded reconcile window forever: at the
   * cap the row leaves the sweep, and the halt event records where it
   * stopped. The unknown state itself never changes here.
   */
  private async noteReconcilePass(row: OutboundMessage): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(outboundMessages)
        .set({ reconcileAttempts: sql`${outboundMessages.reconcileAttempts} + 1` })
        .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "outcome_unknown")))
        .returning({ attempts: outboundMessages.reconcileAttempts });
      const after = updated[0];
      if (after !== undefined && after.attempts >= SEND_SWEEP_ATTEMPT_CAP) {
        await recordSendEvent(tx, "system", SEND_RECONCILE_HALTED_EVENT, row.id, {
          accountId: row.accountId,
          attempts: after.attempts,
        });
      }
    });
  }

  /**
   * Hold the attempts a crash left behind (SPEC F7): every abandoned
   * `sending` row becomes `outcome_unknown` and every abandoned
   * `appending` row becomes `unknown`, both with the reason recorded. Nothing
   * is replayed; rows from another recovery generation stay for the operator
   * recovery flow (SPEC section 10, step 4).
   *
   * A hold waits for the attempt lease: the claims stamp
   * `sendingStartedAt` and `appendStartedAt`, and only a row whose stamp is
   * older than `ATTEMPT_LEASE_MS` may be held. A live submission under a
   * rolling restart or a second worker therefore keeps its row, and its own
   * commit still wins. An unstamped `sending` row is never held — only the
   * claim writes that status, and every claim stamps, so no stamp means no
   * hold, the safe direction. An unstamped `appending` row predates the
   * stamp column and counts as expired.
   */
  async recoverAbandonedAttempts(): Promise<AbandonedAttemptSummary> {
    const status = await this.controls.readStatus();
    if (status.state !== "ready") {
      return { heldSends: 0, heldAppends: 0, skippedStale: 0, blocked: true };
    }
    const expiredBefore = new Date(this.now().getTime() - ATTEMPT_LEASE_MS);

    const sending = await this.db
      .select({ id: outboundMessages.id, generation: outboundMessages.recoveryGeneration })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.status, "sending"),
          lt(outboundMessages.sendingStartedAt, expiredBefore),
        ),
      );
    let heldSends = 0;
    let skippedStale = 0;
    for (const row of sending) {
      if (assessJob(status, row.generation) === "stale") {
        skippedStale += 1;
        continue;
      }
      const held = await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(outboundMessages)
          .set({
            status: "outcome_unknown",
            lastError: {
              code: "sending_abandoned",
              message:
                "The submission attempt recorded no outcome before the process stopped; nothing was resubmitted.",
            },
          })
          .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "sending")))
          .returning();
        if (updated[0] === undefined) {
          return false;
        }
        await recordSendEvent(tx, "system", SEND_UNKNOWN_EVENT, row.id, {
          accountId: updated[0].accountId,
          code: "sending_abandoned",
        });
        return true;
      });
      if (held) {
        heldSends += 1;
      }
    }

    const appending = await this.db
      .select({ id: outboundMessages.id, generation: outboundMessages.recoveryGeneration })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.sentCopyStatus, "appending"),
          or(
            isNull(outboundMessages.appendStartedAt),
            lt(outboundMessages.appendStartedAt, expiredBefore),
          ),
        ),
      );
    let heldAppends = 0;
    for (const row of appending) {
      if (assessJob(status, row.generation) === "stale") {
        skippedStale += 1;
        continue;
      }
      const held = await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(outboundMessages)
          .set({
            sentCopyStatus: "unknown",
            lastError: {
              code: "append_abandoned",
              message:
                "The Sent append attempt recorded no outcome before the process stopped; it was not retried blindly.",
            },
          })
          .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.sentCopyStatus, "appending")))
          .returning();
        if (updated[0] === undefined) {
          return false;
        }
        await recordSendEvent(tx, "system", SEND_SENT_COPY_UNKNOWN_EVENT, row.id, {
          accountId: updated[0].accountId,
          code: "append_abandoned",
        });
        return true;
      });
      if (held) {
        heldAppends += 1;
      }
    }
    return { heldSends, heldAppends, skippedStale, blocked: false };
  }

  /**
   * Commit one acceptance (SPEC F7 step 4 and the local-sent-record rules):
   * one transaction sets `sent`, creates or reuses the local message by its
   * account and original hash, writes its body, attachments, and search text,
   * marks the thread job, records the event, and leaves the Sent append job
   * to start from `pending`. Reconciliation of an uncertain send reuses this
   * transaction from `outcome_unknown` with the verified Sent copy attached,
   * so its sent state, local index, and append outcome commit together.
   */
  private async commitAcceptance(
    row: OutboundMessage,
    input: {
      /** The status the row must still hold when the transaction runs. */
      fromStatus: "sending" | "outcome_unknown";
      /** The accepted bytes: submitted or, on reconciliation, the verified copy. */
      bytes: Uint8Array;
      smtpResponse: Record<string, unknown> | null;
      recipientResults: RecipientResult[];
      /** A Sent copy verification already settled; it finishes the append job too. */
      sentCopy?: SentCopyDestination | null;
      /** What proved acceptance, recorded on the event for the audit trail. */
      evidence?: string | null;
    },
  ): Promise<OutboundMessage> {
    const parsed = await parseMime(input.bytes);

    // Repeated acceptance, or a Sent import that raced this handler, may
    // already hold a message with the same original hash; the unique index
    // serializes us onto the reuse path.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const existing = await findMessageByHash(tx, row.accountId, row.mimeSha256);
          const messageId =
            existing?.id ??
            (await this.insertLocalSentMessage(tx, row, parsed, input.bytes));
          const updated = await tx
            .update(outboundMessages)
            .set({
              status: "sent",
              logicalMessageId: messageId,
              smtpResponse: input.smtpResponse,
              recipientResults: input.recipientResults,
              sentAt: this.now(),
              lastError: null,
              ...(input.sentCopy === undefined || input.sentCopy === null
                ? {}
                : {
                    sentCopyStatus: "stored" as const,
                    sentFolderId: input.sentCopy.folderId,
                    sentUidvalidity: input.sentCopy.uidvalidity,
                    sentUid: input.sentCopy.uid,
                  }),
            })
            .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, input.fromStatus)))
            .returning();
          if (updated[0] !== undefined) {
            // Acceptance ends the send lock in the same transaction: the
            // snapshot is the record now, and the draft returns to plain
            // list state — deletable, never wedged — while the outbound
            // references keep its uploaded files alive (SPEC F6 and F7).
            await unlockDraftAfterSend(tx, row.id);
          }
          await recordSendEvent(tx, "system", SEND_SENT_EVENT, row.id, {
            accountId: row.accountId,
            messageId,
            accepted: input.recipientResults.filter((result) => result.accepted).length,
            rejected: input.recipientResults.filter((result) => !result.accepted).length,
            partial: input.recipientResults.some((result) => !result.accepted),
            ...(input.evidence === undefined || input.evidence === null
              ? {}
              : { evidence: input.evidence }),
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
   * One definitive failure (SPEC F7 step 6): `failed`, whatever responses the
   * attempt produced — none, when SMTP never opened — and the draft lock
   * released for editing.
   */
  private async recordFailure(
    row: OutboundMessage,
    outcome: {
      smtpResponse: Record<string, unknown> | null;
      recipientResults: RecipientResult[];
      error: { code: string; message: string } | null;
    },
  ): Promise<OutboundMessage> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(outboundMessages)
        .set({
          status: "failed",
          smtpResponse: outcome.smtpResponse,
          recipientResults: outcome.recipientResults,
          lastError: outcome.error === null ? null : { ...outcome.error },
        })
        .where(and(eq(outboundMessages.id, row.id), eq(outboundMessages.status, "sending")))
        .returning();
      const failed = updated[0] ?? row;
      await unlockDraftAfterFailure(tx, row.id);
      await recordSendEvent(tx, "system", SEND_FAILED_EVENT, row.id, {
        accountId: row.accountId,
        code: outcome.error?.code ?? "unknown",
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

  /** The folder one account maps to the Sent role (SPEC F1). */
  private async findSentFolder(accountId: string): Promise<{ id: string; path: string } | null> {
    const rows = await this.db
      .select({ id: folders.id, path: folders.name })
      .from(folders)
      .where(and(eq(folders.accountId, accountId), eq(folders.role, "sent")))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Search one Sent folder for the snapshot's copy and verify every candidate
   * against the frozen hash (SPEC F7 step 5). The identifier locates; the
   * bytes decide. A candidate with different bytes is a conflict, because a
   * reused `Message-ID` must never be treated as the snapshot's own copy.
   */
  private async locateVerifiedCopy(
    session: SentCopyMailbox,
    folder: { id: string; path: string },
    row: OutboundMessage,
  ): Promise<
    | { kind: "verified"; destination: SentCopyDestination }
    | { kind: "absent" }
    | { kind: "conflict" }
  > {
    const state = await session.select(folder.path);
    const uids = await session.searchByMessageId(row.rfcMessageId);
    let candidateSeen = false;
    for (const uid of uids) {
      const bytes = await session.fetchOriginal(uid);
      if (bytes === null) {
        continue;
      }
      candidateSeen = true;
      if (sha256Hex(bytes) === row.mimeSha256) {
        return {
          kind: "verified",
          destination: { folderId: folder.id, uidvalidity: state.uidValidity, uid },
        };
      }
    }
    return candidateSeen ? { kind: "conflict" } : { kind: "absent" };
  }

  /**
   * Conclude one append attempt. A claimed conclusion requires the row to
   * still hold `appending`, so only the worker that claimed the attempt can
   * finish it; when a concurrent recovery already moved the row, nothing is
   * written and no event is invented. An unclaimed conclusion covers the
   * destination problems found before any claim.
   */
  private async concludeSentCopy(
    row: OutboundMessage,
    claim: "claimed" | "unclaimed",
    outcome:
      | { status: "stored"; destination: SentCopyDestination }
      | { status: "failed" | "unknown"; error: { code: string; message: string } },
  ): Promise<OutboundMessage> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(outboundMessages)
        .set(
          outcome.status === "stored"
            ? {
                sentCopyStatus: "stored",
                sentFolderId: outcome.destination.folderId,
                sentUidvalidity: outcome.destination.uidvalidity,
                sentUid: outcome.destination.uid,
                lastError: null,
              }
            : {
                sentCopyStatus: outcome.status,
                lastError: { ...outcome.error },
                // Every attempt that ends without a stored copy counts, so
                // a permanently failing append leaves the bounded sweep.
                sentCopyAttempts: sql`${outboundMessages.sentCopyAttempts} + 1`,
              },
        )
        .where(
          and(
            eq(outboundMessages.id, row.id),
            eq(outboundMessages.status, "sent"),
            claim === "claimed"
              ? eq(outboundMessages.sentCopyStatus, "appending")
              : inArray(outboundMessages.sentCopyStatus, ["pending", "failed", "unknown"]),
          ),
        )
        .returning();
      const after = updated[0];
      if (after === undefined) {
        return row;
      }
      await recordSendEvent(
        tx,
        "system",
        outcome.status === "stored"
          ? SEND_SENT_COPY_STORED_EVENT
          : outcome.status === "failed"
            ? SEND_SENT_COPY_FAILED_EVENT
            : SEND_SENT_COPY_UNKNOWN_EVENT,
        row.id,
        outcome.status === "stored"
          ? {
              accountId: row.accountId,
              folderId: outcome.destination.folderId,
              uidvalidity: outcome.destination.uidvalidity,
              uid: outcome.destination.uid,
            }
          : { accountId: row.accountId, code: outcome.error.code },
      );
      if (
        outcome.status !== "stored" &&
        after.sentCopyAttempts >= SEND_SWEEP_ATTEMPT_CAP
      ) {
        // The row leaves the sweep here; the event marks where it stopped,
        // because nothing else will touch it automatically.
        await recordSendEvent(tx, "system", SEND_SENT_COPY_HALTED_EVENT, row.id, {
          accountId: row.accountId,
          attempts: after.sentCopyAttempts,
          code: outcome.error.code,
        });
      }
      return after;
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

  /** The draft's attachment links in ordinal order, read without a lock. */
  private async readAttachmentLinks(draftId: string): Promise<{ uploadId: string; ordinal: number }[]> {
    return this.db
      .select({ uploadId: draftUploads.uploadId, ordinal: draftUploads.ordinal })
      .from(draftUploads)
      .where(eq(draftUploads.draftId, draftId))
      .orderBy(asc(draftUploads.ordinal));
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

/**
 * Recipient results once a verified Sent copy proved the submission was
 * accepted (SPEC F7 step 7). A per-recipient statement the uncertain attempt
 * recorded stays verbatim — a definitive rejection is still the server's
 * last word for that address. Recipients without their own statement are
 * covered by the proved acceptance, exactly as one positive final response
 * covers them; leaving the pre-send `accepted: false` would show a sent
 * message that reports no acceptance at all.
 */
function reconciledRecipientResults(row: OutboundMessage): RecipientResult[] {
  const recorded = new Map(row.recipientResults.map((result) => [result.address, result]));
  return row.envelopeRecipients.map((address) => {
    const prior = recorded.get(address);
    if (prior !== undefined && prior.response !== null) {
      return { address, accepted: prior.accepted, response: prior.response };
    }
    return { address, accepted: true, response: null };
  });
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

/**
 * Whether the draft's live upload links still name the frozen attachment
 * set, position for position. Both lists are ordered by ordinal; attach and
 * detach change the set without moving the draft revision, so this is the
 * check that catches them inside the freeze transaction.
 */
function matchesFrozenAttachments(
  links: { uploadId: string; ordinal: number }[],
  frozen: { upload: { id: string }; ordinal: number }[],
): boolean {
  if (links.length !== frozen.length) {
    return false;
  }
  return links.every(
    (link, index) => link.uploadId === frozen[index]!.upload.id && link.ordinal === frozen[index]!.ordinal,
  );
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

/**
 * True when the row's account maps no folder to the Sent role. The sweeps
 * use it to leave configuration-blocked rows out of their bounded windows;
 * the unique index on (account_id, role) keeps the subquery one row at
 * most, and a fresh mapping turns the predicate false at once.
 */
function missingSentFolder(): SQL {
  return sql`not exists (select 1 from ${folders} where ${folders.accountId} = ${outboundMessages.accountId} and ${folders.role} = 'sent')`;
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

/**
 * The request one idempotency key commits to: the draft, the revision, and
 * the frozen attachment set. Attach and detach move no revision, so the file
 * set is part of the request identity or a changed set could reuse a key.
 */
function hashRequest(
  draftId: string,
  baseRevision: number,
  attachments: { uploadId: string; ordinal: number }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        draftId: draftId.toLowerCase(),
        baseRevision,
        attachments: attachments.map((attachment) => [attachment.uploadId, attachment.ordinal]),
      }),
    )
    .digest("hex");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The first line of one failure, without credentials or stack noise. */
function firstLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.split("\n")[0]!;
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

/**
 * The draft lock left with another request, the shape of a queue race the
 * idempotency key must settle: when the winner carried the same key, the
 * loser replays the stored snapshot instead of surfacing the lock.
 */
function isLostLockRace(cause: unknown): boolean {
  return cause instanceof SendError && cause.code === "draft_locked";
}
