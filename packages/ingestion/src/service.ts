import { and, eq, ne, notInArray } from "drizzle-orm";
import type { MailHubDatabase, Storage } from "@mail-hub/database";
import {
  attachments,
  bodies,
  drafts,
  events,
  messageOccurrences,
  messages,
  outboundMessages,
  originalMessageKey,
  attachmentCacheKey,
  type Attachment,
} from "@mail-hub/database";
import type { MailHubTransaction } from "@mail-hub/recovery";
import { createHash } from "node:crypto";
import { IngestionError } from "./errors.ts";
import { LOCATOR_VERSION, MAX_MESSAGE_BYTES, parseMime, type ParsedMessage } from "./parse.ts";
import { HtmlSanitizer, SANITIZER_VERSION } from "./sanitize.ts";
import {
  BODY_INDEX_MAX_CHARS,
  makeSnippet,
  normalizeIndexText,
  recipientsIndexText,
  senderIndexText,
} from "./text.ts";
import { markThreadJobsDirty } from "./thread-jobs.ts";

/**
 * Durable MIME ingestion (SPEC F2 backfill step 6 and section 8).
 *
 * One call stores the complete original bytes in durable storage, then parses,
 * sanitizes, and indexes derived content in a single transaction:
 *
 * 1. The original is written and hashed before any database row changes, so a
 *    message marked `fetched_body` always has retrievable bytes behind it.
 * 2. One transaction updates the logical message, writes the sanitized body,
 *    upserts verified attachment locators, and records the audit event.
 * 3. A byte-identical duplicate inside one account merges into the existing
 *    logical message: occurrences and derived records move across, and the
 *    provisional row disappears.
 * 4. Both paths mark their thread-reconciliation jobs — the changed row and
 *    every row referencing its identifiers — inside the same transaction.
 *
 * Workers call this after the recovery gate; the job wrapper owns that gate,
 * so ingestion itself never runs while service state is not `ready`.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Input for one original: the provisional logical message and its complete bytes. */
export interface IngestOriginalInput {
  accountId: string;
  messageId: string;
  bytes: Uint8Array;
}

/** One original to stream into durable storage, before anything parses. */
export interface StageOriginalInput {
  messageId: string;
  /** The complete message bytes, chunked; never buffered whole. */
  source: AsyncIterable<Uint8Array>;
  /**
   * The size the server reported for the message, when known. An original
   * already above the maximum is rejected before any byte moves.
   */
  expectedSize?: number | null;
}

/** One original durably stored and hashed, not yet parsed or applied. */
export interface StagedOriginal {
  messageId: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
}

/** Apply one staged original to its provisional logical message. */
export interface ApplyStagedInput {
  accountId: string;
  messageId: string;
  staged: StagedOriginal;
}

/** Outcome of one ingestion call. `messageId` is always the surviving row. */
export interface IngestResult {
  result: "ingested" | "merged";
  messageId: string;
  /** The provisional row that merged away; present on `merged` only. */
  removedMessageId: string | null;
  sha256: string;
  sizeBytes: number;
  attachmentCount: number;
}

/** A regenerated attachment with its verified bytes and updated row. */
export interface RegeneratedAttachment {
  attachment: Attachment;
  bytes: Uint8Array;
}

/** One message's sanitized body derivatives, rebuilt under the current sanitizer. */
export interface SanitizedBody {
  textPlain: string | null;
  htmlSanitized: string | null;
}

export class IngestionService {
  private readonly sanitizer: HtmlSanitizer;

  constructor(
    private readonly db: MailHubDatabase,
    private readonly storage: Storage,
    sanitizer?: HtmlSanitizer,
  ) {
    this.sanitizer = sanitizer ?? new HtmlSanitizer();
  }

  /**
   * Store one original durably, then persist every derived record for it.
   * Repeating the call with the same bytes is safe: part rows keep their
   * identifiers and no second logical message appears.
   */
  async ingestOriginal(input: IngestOriginalInput): Promise<IngestResult> {
    requireUuid("account id", input.accountId);
    requireUuid("message id", input.messageId);
    if (input.bytes.byteLength === 0) {
      throw new IngestionError("invalid_request", "Original message bytes are empty.");
    }
    if (input.bytes.byteLength > MAX_MESSAGE_BYTES) {
      throw tooLarge(input.bytes.byteLength);
    }
    const staged = await this.stageOriginal({
      messageId: input.messageId,
      source: oneChunk(input.bytes),
      expectedSize: input.bytes.byteLength,
    });
    return this.applyStagedOriginal({ accountId: input.accountId, messageId: input.messageId, staged });
  }

  /**
   * Stream one original into durable storage without buffering it whole
   * (SPEC section 10: stream originals to disk). The write finishes and the
   * hash is known before the caller applies anything, so the staged bytes are
   * the record from this point on. A stream that crosses the maximum size or
   * ends without any bytes aborts the store's write before it renames
   * anything into place, so bytes already stored under the key stay
   * untouched and a later fetch of the same message can stage again.
   */
  async stageOriginal(input: StageOriginalInput): Promise<StagedOriginal> {
    requireUuid("message id", input.messageId);
    if (input.expectedSize !== undefined && input.expectedSize !== null && input.expectedSize > MAX_MESSAGE_BYTES) {
      throw tooLarge(input.expectedSize);
    }

    const storageKey = originalMessageKey(input.messageId);
    const stored = await this.storage.durable.putStream(storageKey, bounded(input.source));
    return { messageId: input.messageId, storageKey, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
  }

  /**
   * Parse one staged original and persist its derived records. The staged
   * hash and size must still match the stored bytes, so an object another
   * writer replaced between staging and this call is an error, never a guess.
   */
  async applyStagedOriginal(input: ApplyStagedInput): Promise<IngestResult> {
    requireUuid("account id", input.accountId);
    requireUuid("message id", input.messageId);
    if (input.staged.messageId !== input.messageId) {
      throw new IngestionError("invalid_request", "The staged original belongs to a different message.");
    }

    const original = await this.storage.durable.get(input.staged.storageKey);
    if (original.byteLength > MAX_MESSAGE_BYTES) {
      throw tooLarge(original.byteLength);
    }
    if (original.byteLength !== input.staged.sizeBytes || sha256Hex(original) !== input.staged.sha256) {
      throw new IngestionError("original_mismatch", "The stored original no longer matches its staged hash or size.");
    }

    const parsed = await parseMime(original);
    const derived = this.deriveBody(parsed);
    return this.commitParsed(
      input.accountId,
      input.messageId,
      parsed,
      derived,
      input.staged.storageKey,
      input.staged.sha256,
      input.staged.sizeBytes,
    );
  }

  /**
   * Commit one parsed original in a single transaction. Two workers can
   * ingest byte-identical copies for different provisional rows at once: the
   * unique (account, hash) index serializes them, the loser retries once, and
   * the retry takes the merge path.
   */
  private async commitParsed(
    accountId: string,
    messageId: string,
    parsed: ParsedMessage,
    derived: { textPlain: string | null; htmlSanitized: string | null; bodyText: string | null },
    storageKey: string,
    sha256: string,
    sizeBytes: number,
  ): Promise<IngestResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const row = await lockMessage(tx, accountId, messageId);
          const duplicate = await tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.accountId, accountId),
                eq(messages.originalSha256, sha256),
                ne(messages.id, messageId),
              ),
            )
            .limit(1);

          if (duplicate[0] !== undefined) {
            return this.mergeDuplicate(tx, accountId, row, duplicate[0].id, sha256, sizeBytes, parsed);
          }
          return this.applyIngested(tx, accountId, row, parsed, derived, storageKey, sha256, sizeBytes);
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
   * Rebuild one attachment's disposable copy from the verified original
   * (SPEC section 8). The original hash, the locator version, and the decoded
   * hash and size must all match; anything else is an error, never a guess.
   */
  async regenerateAttachment(attachmentId: string): Promise<RegeneratedAttachment> {
    requireUuid("attachment id", attachmentId);
    const rows = await this.db
      .select({ attachment: attachments, message: messages })
      .from(attachments)
      .innerJoin(messages, eq(attachments.messageId, messages.id))
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new IngestionError("not_found", "No attachment exists with this identifier.");
    }
    const { attachment, message } = row;
    if (attachment.locatorVersion !== LOCATOR_VERSION) {
      throw new IngestionError(
        "unsupported_locator",
        `Attachment locator version ${attachment.locatorVersion} is not supported; this version resolves ${LOCATOR_VERSION}.`,
      );
    }
    if (message.originalStorageKey === null || message.originalSha256 === null) {
      throw new IngestionError("original_missing", "The message original has not been stored yet.");
    }
    if (!(await this.storage.durable.verify(message.originalStorageKey, message.originalSha256))) {
      throw new IngestionError("original_mismatch", "The stored original no longer matches its recorded hash.");
    }

    const original = await this.storage.durable.get(message.originalStorageKey);
    const parsed = await parseMime(original);
    const part = parsed.attachments.find((candidate) => candidate.partPath === attachment.partPath);
    if (part === undefined) {
      throw new IngestionError(
        "locator_unresolved",
        `Part path ${attachment.partPath} resolved to nothing in the stored original.`,
      );
    }
    if (part.decodedSha256 !== attachment.decodedSha256 || part.sizeBytes !== attachment.sizeBytes) {
      throw new IngestionError("bytes_mismatch", "Regenerated bytes do not match the recorded decoded hash or size.");
    }

    const cacheKey = attachmentCacheKey(attachment.id);
    await this.storage.disposable.put(cacheKey, part.content);
    const updated = await this.db
      .update(attachments)
      .set({ storageKey: cacheKey, fetchedAt: new Date() })
      .where(eq(attachments.id, attachment.id))
      .returning();
    return { attachment: updated[0]!, bytes: part.content };
  }

  /**
   * Rebuild one message's sanitized body from its verified original under
   * the current sanitizer (SPEC section 8: the original is the record;
   * derivatives rebuild). The snippet and the body index derive from the
   * same sanitized text, so they move with the body in one transaction. A
   * row already stamped with the current version returns as it stands, so
   * concurrent readers rebuild at most once. `null` answers a message with
   * no body row; a stored body without a retrievable original is an error,
   * never a guess.
   */
  async refreshSanitizedBody(messageId: string): Promise<SanitizedBody | null> {
    requireUuid("message id", messageId);
    const rows = await this.db
      .select({ message: messages, body: bodies })
      .from(messages)
      .leftJoin(bodies, eq(bodies.messageId, messages.id))
      .where(eq(messages.id, messageId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new IngestionError("not_found", "No message exists with this identifier.");
    }
    if (row.body === null) {
      return null;
    }
    if (row.body.sanitizerVersion === SANITIZER_VERSION) {
      return { textPlain: row.body.textPlain, htmlSanitized: row.body.htmlSanitized };
    }
    const { message } = row;
    if (message.originalStorageKey === null || message.originalSha256 === null) {
      throw new IngestionError("original_missing", "The message original has not been stored yet.");
    }
    if (!(await this.storage.durable.verify(message.originalStorageKey, message.originalSha256))) {
      throw new IngestionError("original_mismatch", "The stored original no longer matches its recorded hash.");
    }

    const original = await this.storage.durable.get(message.originalStorageKey);
    const parsed = await parseMime(original);
    const derived = this.deriveBody(parsed);
    const indexText = truncate(normalizeIndexText(derived.bodyText ?? ""), BODY_INDEX_MAX_CHARS);
    await this.db.transaction(async (tx) => {
      await tx
        .update(bodies)
        .set({
          textPlain: derived.textPlain,
          htmlSanitized: derived.htmlSanitized,
          sanitizerVersion: SANITIZER_VERSION,
        })
        .where(eq(bodies.messageId, messageId));
      await tx
        .update(messages)
        .set({ snippet: makeSnippet(derived.bodyText), bodyIndexText: indexText })
        .where(eq(messages.id, messageId));
    });
    return { textPlain: derived.textPlain, htmlSanitized: derived.htmlSanitized };
  }

  /** Normalized body derivatives for the `bodies` row and the index text. */
  private deriveBody(parsed: ParsedMessage): { textPlain: string | null; htmlSanitized: string | null; bodyText: string | null } {
    const htmlSanitized = parsed.html === null ? null : this.sanitizer.sanitizeHtml(parsed.html);
    const htmlText = htmlSanitized === null ? null : this.sanitizer.htmlToText(htmlSanitized);
    const bodyText = parsed.textPlain ?? htmlText;
    return { textPlain: parsed.textPlain, htmlSanitized, bodyText };
  }

  /** Update one logical message with parsed and indexed content (SPEC section 8). */
  private async applyIngested(
    tx: MailHubTransaction,
    accountId: string,
    row: { id: string; sentAt: Date | null; messageId: string | null },
    parsed: ParsedMessage,
    derived: { textPlain: string | null; htmlSanitized: string | null; bodyText: string | null },
    storageKey: string,
    sha256: string,
    sizeBytes: number,
  ): Promise<IngestResult> {
    const indexText = truncate(normalizeIndexText(derived.bodyText ?? ""), BODY_INDEX_MAX_CHARS);

    await tx
      .update(messages)
      .set({
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        referenceIds: parsed.referenceIds,
        sender: parsed.sender,
        replyTo: parsed.replyTo,
        recipients: parsed.recipients,
        subject: parsed.subject,
        sentAt: parsed.sentAt ?? row.sentAt,
        snippet: makeSnippet(derived.bodyText),
        hasAttachments: parsed.attachments.length > 0,
        sizeBytes,
        fetchedBody: true,
        originalStorageKey: storageKey,
        originalSha256: sha256,
        senderText: normalizeIndexText(senderIndexText(parsed.sender)),
        recipientsText: normalizeIndexText(recipientsIndexText(parsed.recipients)),
        subjectText: normalizeIndexText(parsed.subject ?? ""),
        bodyIndexText: indexText,
      })
      .where(eq(messages.id, row.id));

    await tx
      .insert(bodies)
      .values({
        messageId: row.id,
        textPlain: derived.textPlain,
        htmlSanitized: derived.htmlSanitized,
        sanitizerVersion: SANITIZER_VERSION,
      })
      .onConflictDoUpdate({
        target: bodies.messageId,
        set: {
          textPlain: derived.textPlain,
          htmlSanitized: derived.htmlSanitized,
          sanitizerVersion: SANITIZER_VERSION,
        },
      });

    await upsertAttachments(tx, row.id, parsed.attachments);

    // The full parse can rewrite the grouping hint, so this row re-decides its
    // own parent link and every row that referenced the old or the new
    // identifier re-decides too (SPEC F2). The marks commit with the headers.
    await markThreadJobsDirty(tx, accountId, {
      messageIds: [row.id],
      identifiers: [row.messageId, parsed.messageId],
    });

    await tx.insert(events).values({
      actor: "system",
      type: "message.ingested",
      entityType: "message",
      entityId: row.id,
      payload: { sizeBytes, sha256, attachmentCount: parsed.attachments.length },
    });

    return {
      result: "ingested",
      messageId: row.id,
      removedMessageId: null,
      sha256,
      sizeBytes,
      attachmentCount: parsed.attachments.length,
    };
  }

  /**
   * Merge a byte-identical duplicate into the surviving logical message
   * (SPEC F2). Occurrences, child links, and reply references move across in
   * this transaction; the provisional row and its derived rows disappear.
   * The duplicate's stored original becomes unreferenced and waits for
   * garbage collection.
   */
  private async mergeDuplicate(
    tx: MailHubTransaction,
    accountId: string,
    provisional: { id: string; messageId: string | null },
    survivorId: string,
    sha256: string,
    sizeBytes: number,
    parsed: ParsedMessage,
  ): Promise<IngestResult> {
    const removedId = provisional.id;
    // A survivor whose own parent pointed at the provisional row would create
    // a cycle after the move; it becomes pending and reconciliation relinks it.
    await tx
      .update(messages)
      .set({ parentMessageId: null, threadLinkState: "pending" })
      .where(and(eq(messages.id, survivorId), eq(messages.parentMessageId, removedId)));

    await tx
      .update(messages)
      .set({ parentMessageId: survivorId })
      .where(and(eq(messages.parentMessageId, removedId), ne(messages.id, survivorId)));

    await tx.update(messageOccurrences).set({ messageId: survivorId }).where(eq(messageOccurrences.messageId, removedId));
    await tx.update(drafts).set({ replyParentId: survivorId }).where(eq(drafts.replyParentId, removedId));
    await tx
      .update(outboundMessages)
      .set({ replyParentId: survivorId })
      .where(eq(outboundMessages.replyParentId, removedId));

    await tx.delete(attachments).where(eq(attachments.messageId, removedId));
    await tx.delete(bodies).where(eq(bodies.messageId, removedId));
    await tx.delete(messages).where(eq(messages.id, removedId));

    // One holder of the identifier remains, so the survivor and every row that
    // referenced either holder re-decide: an ambiguous child can link now, and
    // the children that just moved across rejoin the survivor's thread (SPEC F2).
    await markThreadJobsDirty(tx, accountId, {
      messageIds: [survivorId],
      identifiers: [provisional.messageId, parsed.messageId],
    });

    await tx.insert(events).values({
      actor: "system",
      type: "message.merged",
      entityType: "message",
      entityId: survivorId,
      payload: { removedMessageId: removedId, sha256, sizeBytes },
    });

    return {
      result: "merged",
      messageId: survivorId,
      removedMessageId: removedId,
      sha256,
      sizeBytes,
      attachmentCount: parsed.attachments.length,
    };
  }
}

/** Lock one logical message row and confirm it belongs to the account. */
async function lockMessage(
  tx: MailHubTransaction,
  accountId: string,
  messageId: string,
): Promise<{ id: string; sentAt: Date | null; messageId: string | null }> {
  const rows = await tx
    .select({ id: messages.id, sentAt: messages.sentAt, messageId: messages.messageId })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId)))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new IngestionError("not_found", "No message of this account exists with that identifier.");
  }
  return row;
}

/**
 * Insert or refresh part rows keyed by locator. Existing identifiers are
 * reused, so repeated parsing never creates competing attachment IDs for the
 * same message and path (SPEC section 8). Part paths the parse no longer
 * reports are removed.
 */
async function upsertAttachments(tx: MailHubTransaction, messageId: string, parts: ParsedMessage["attachments"]): Promise<void> {
  for (const part of parts) {
    await tx
      .insert(attachments)
      .values({
        messageId,
        partPath: part.partPath,
        locatorVersion: LOCATOR_VERSION,
        decodedSha256: part.decodedSha256,
        contentId: part.contentId,
        disposition: part.disposition,
        filename: part.filename,
        contentType: part.contentType,
        sizeBytes: part.sizeBytes,
      })
      .onConflictDoUpdate({
        target: [attachments.messageId, attachments.partPath],
        set: {
          locatorVersion: LOCATOR_VERSION,
          decodedSha256: part.decodedSha256,
          contentId: part.contentId,
          disposition: part.disposition,
          filename: part.filename,
          contentType: part.contentType,
          sizeBytes: part.sizeBytes,
        },
      });
  }
  if (parts.length === 0) {
    await tx.delete(attachments).where(eq(attachments.messageId, messageId));
  } else {
    await tx
      .delete(attachments)
      .where(
        and(
          eq(attachments.messageId, messageId),
          notInArray(
            attachments.partPath,
            parts.map((part) => part.partPath),
          ),
        ),
      );
  }
}

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new IngestionError("invalid_request", `${kind} must be a UUID: ${id}`);
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/** The rejection every entry point shares for originals above the bound. */
function tooLarge(sizeBytes: number): IngestionError {
  return new IngestionError(
    "message_too_large",
    `The message is ${sizeBytes} bytes, above the ${MAX_MESSAGE_BYTES}-byte maximum this deployment parses.`,
  );
}

/** Present complete bytes to a streaming stage without copying them. */
async function* oneChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Pass chunks through while they stay inside the maximum message size, and
 * refuse a source that ends without any bytes. The first chunk that crosses
 * the bound throws mid-download, and an empty source throws at its end.
 * Either refusal stops the store's write before any partial or empty object
 * becomes visible, so the key keeps whatever it already held.
 */
async function* bounded(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let streamed = 0;
  for await (const chunk of source) {
    if (streamed + chunk.byteLength > MAX_MESSAGE_BYTES) {
      throw tooLarge(streamed + chunk.byteLength);
    }
    streamed += chunk.byteLength;
    yield chunk;
  }
  if (streamed === 0) {
    // A truncated server stream must not masquerade as this message's
    // original, and must not replace the bytes an earlier fetch stored.
    throw new IngestionError("invalid_request", "Original message bytes are empty.");
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
