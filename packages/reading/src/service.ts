import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  attachments,
  bodies,
  messages,
  type Attachment,
  type EmailAddress,
  type MailHubDatabase,
  type Storage,
} from "@mail-hub/database";
import { ContentExtractor, type CleanView } from "@mail-hub/content";
import {
  MESSAGE_CLASSES,
  type MessageClass,
  type MessageClassificationView,
  type SuggestionSource,
} from "@mail-hub/contracts";
import { SANITIZER_VERSION } from "@mail-hub/ingestion/sanitize";
import type { SanitizedBody } from "@mail-hub/ingestion";
import { ReadingError } from "./errors.ts";

/**
 * The safe message reader (SPEC F3 and sections 8 and 9). Reads serve only
 * sanitized derivatives, never the stored original bytes: a derivative the
 * current sanitizer did not produce rebuilds from the verified original
 * before it is served, and every download carries bytes the decoded hash
 * verified — from the disposable cache or from a regeneration over the
 * verified original.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The extraction surface the reader needs for clean view. `ContentExtractor`
 * satisfies it; the type keeps tests free to substitute their own.
 */
export type CleanViewExtractor = Pick<ContentExtractor, "extractCleanView">;

/**
 * Rebuilds one attachment's disposable copy from the verified original
 * (SPEC section 8). The ingestion service implements this; the type keeps the
 * reader independent of it. The returned row is the one the bytes verified
 * against: a concurrent re-ingest can rewrite the part between the reader's
 * snapshot and the rebuild while the attachment id stays.
 */
export type AttachmentRegenerator = (
  attachmentId: string,
) => Promise<{ attachment: Attachment; bytes: Uint8Array }>;

/**
 * Rebuilds one message's sanitized body from the verified durable original
 * and persists the fresh derivative (SPEC section 8). The ingestion service
 * implements this; the type keeps the reader independent of it.
 */
export type SanitizedBodyRefresher = (messageId: string) => Promise<SanitizedBody | null>;

/** One attachment as the reader shows it. */
export interface MessageAttachment {
  id: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number;
  contentId: string | null;
  disposition: string | null;
  /**
   * True when exactly one part of this message holds this Content-ID and the
   * part is an image, so a `cid:` reference may resolve to it. Ambiguous
   * identifiers stay download items (SPEC F3).
   */
  inlineResolvable: boolean;
}

/** One message in full, as the reader shows it. */
export interface MessageDetail {
  id: string;
  accountId: string;
  threadId: string | null;
  subject: string | null;
  sender: EmailAddress | null;
  /** Visible recipients; blind copies never leave the stored header. */
  recipients: { to: EmailAddress[]; cc: EmailAddress[] } | null;
  sentAt: Date | null;
  /** False while only headers exist; the reader says so instead of guessing. */
  fetchedBody: boolean;
  /** Sanitized HTML derivative; the original bytes are never sent. */
  htmlSanitized: string | null;
  textPlain: string | null;
  attachments: MessageAttachment[];
  /** The visible, non-routing classification suggestion (SPEC F8). */
  classification: MessageClassificationView;
}

/** One download: the attachment view and its verified decoded bytes. */
export interface OpenedAttachment {
  attachment: MessageAttachment;
  bytes: Uint8Array;
}

/** The derived clean view of one message (SPEC F3). */
export interface CleanViewDetail {
  /** The extracted, sanitized HTML, or the sanitized original on fallback. */
  html: string;
  /** Which path produced the HTML. */
  source: CleanView["source"];
}

export class ReadingService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly storage: Storage,
    private readonly regenerate: AttachmentRegenerator,
    private readonly refreshSanitizedBody: SanitizedBodyRefresher,
    private readonly extractor: CleanViewExtractor = new ContentExtractor(),
  ) {}

  /** The full detail of one message, with sanitized body derivatives. */
  async readMessage(messageId: string): Promise<MessageDetail> {
    requireUuid("message id", messageId);
    const rows = await this.db
      .select({ message: messages, body: bodies })
      .from(messages)
      .leftJoin(bodies, eq(bodies.messageId, messages.id))
      .where(eq(messages.id, messageId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ReadingError("not_found", "No message exists with this identifier.");
    }
    const parts = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, messageId))
      .orderBy(asc(attachments.partPath));
    const recipients = row.message.recipients ?? null;
    return {
      id: row.message.id,
      accountId: row.message.accountId,
      threadId: row.message.threadId,
      subject: row.message.subject,
      sender: row.message.sender ?? null,
      recipients:
        recipients === null
          ? null
          : { to: recipients.to, cc: recipients.cc ?? [] },
      sentAt: row.message.sentAt,
      fetchedBody: row.message.fetchedBody,
      htmlSanitized: await this.currentSanitizedHtml(
        row.message.id,
        row.body?.htmlSanitized ?? null,
        row.body?.sanitizerVersion ?? null,
      ),
      textPlain: row.body?.textPlain ?? null,
      attachments: withInlineResolution(parts),
      classification: classificationOf(row.message),
    };
  }

  /**
   * The derived clean view of one message (SPEC F3): Defuddle extraction of
   * the sanitized body, sanitized again before it leaves. The result is a
   * derived rendering computed on request; nothing is stored, and the
   * sanitized original stays available one toggle away. A message without a
   * sanitized HTML body has nothing to extract from.
   */
  async readCleanView(messageId: string): Promise<CleanViewDetail> {
    requireUuid("message id", messageId);
    const rows = await this.db
      .select({ htmlSanitized: bodies.htmlSanitized, sanitizerVersion: bodies.sanitizerVersion })
      .from(messages)
      .leftJoin(bodies, eq(bodies.messageId, messages.id))
      .where(eq(messages.id, messageId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ReadingError("not_found", "No message exists with this identifier.");
    }
    const htmlSanitized = await this.currentSanitizedHtml(
      messageId,
      row.htmlSanitized,
      row.sanitizerVersion,
    );
    if (htmlSanitized === null) {
      throw new ReadingError(
        "invalid_request",
        "This message has no sanitized HTML body to extract a clean view from.",
      );
    }
    const view = await this.extractor.extractCleanView(htmlSanitized);
    return { html: view.html, source: view.source };
  }

  /**
   * The sanitized HTML to serve: the stored derivative when its sanitizer
   * version is current, or a rebuild from the durable original when it is
   * stale — including an unknown version (SPEC section 8). The plain-text
   * part never passes through the sanitizer, so only an HTML derivative
   * can go stale. The refresh persists its result, so one rebuild serves
   * every later read. A refresh that cannot complete — a missing or
   * mismatched original, a parse failure after a partial restore — is one
   * step that can never fail the read: the stored derivative is itself
   * sanitized output, never the original, so it serves while the failure
   * is logged for the operator.
   */
  private async currentSanitizedHtml(
    messageId: string,
    htmlSanitized: string | null,
    sanitizerVersion: string | null,
  ): Promise<string | null> {
    if (htmlSanitized === null || sanitizerVersion === SANITIZER_VERSION) {
      return htmlSanitized;
    }
    let refreshed: SanitizedBody | null;
    try {
      refreshed = await this.refreshSanitizedBody(messageId);
    } catch (cause) {
      console.warn(
        `Sanitized body refresh failed for message ${messageId}; serving the stored derivative: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return htmlSanitized;
    }
    return refreshed?.htmlSanitized ?? htmlSanitized;
  }

  /**
   * Serves one attachment's decoded bytes after verifying them against the
   * recorded hash and size. A missing or mismatched cache copy regenerates
   * from the verified original; the attachment id never changes (SPEC section 8).
   */
  async openAttachment(messageId: string, attachmentId: string): Promise<OpenedAttachment> {
    requireUuid("message id", messageId);
    requireUuid("attachment id", attachmentId);
    // Scoping by message also enforces that a Content-ID resolves inline parts
    // of this message only; another message's attachment id answers not_found.
    const parts = await this.db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, messageId))
      .orderBy(asc(attachments.partPath));
    const views = withInlineResolution(parts);
    const position = parts.findIndex((part) => part.id === attachmentId);
    if (position === -1) {
      throw new ReadingError(
        "not_found",
        "No attachment of this message exists with this identifier.",
      );
    }
    const stored = parts[position]!;
    const cached =
      stored.storageKey === null ? null : await this.readVerifiedCache(stored);
    if (cached !== null) {
      return { attachment: views[position]!, bytes: cached };
    }
    const regenerated = await this.regenerate(attachmentId);
    // The bytes verified against the row the regeneration read, which a
    // concurrent re-ingest may have renamed since the snapshot above; the
    // served name and media type come from that row, and the inline decision
    // from the snapshot stays — only the reader sees every part of the
    // message, so only it can make that call.
    return {
      attachment: {
        ...views[position]!,
        filename: regenerated.attachment.filename,
        contentType: regenerated.attachment.contentType,
      },
      bytes: regenerated.bytes,
    };
  }

  /**
   * Reads the disposable copy and verifies it. Any unreadable or mismatched
   * cache counts as a miss: regeneration rebuilds it or fails loudly, and the
   * reader never serves unverified bytes.
   */
  private async readVerifiedCache(attachment: Attachment): Promise<Uint8Array | null> {
    let bytes: Uint8Array;
    try {
      bytes = await this.storage.disposable.get(attachment.storageKey!);
    } catch {
      return null;
    }
    if (sha256Hex(bytes) !== attachment.decodedSha256 || bytes.byteLength !== attachment.sizeBytes) {
      return null;
    }
    return bytes;
  }
}

/** Adds the inline-resolution decision to every attachment row of one message. */
function withInlineResolution(parts: Attachment[]): MessageAttachment[] {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const contentId = part.contentId;
    if (contentId !== null) {
      counts.set(contentId, (counts.get(contentId) ?? 0) + 1);
    }
  }
  return parts.map((part) => ({
    id: part.id,
    filename: part.filename,
    contentType: part.contentType,
    sizeBytes: part.sizeBytes,
    contentId: part.contentId,
    disposition: part.disposition,
    inlineResolvable:
      part.contentId !== null &&
      counts.get(part.contentId) === 1 &&
      isImageContentType(part.contentType),
  }));
}

function isImageContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.trim().toLowerCase().startsWith("image/");
}

/**
 * The suggestion one message row carries: the denormalized Jev answer, the
 * precedence level that produced it, and the yes/no flags. It is advice for
 * the reader, never a routing decision (SPEC F8).
 */
function classificationOf(message: typeof messages.$inferSelect): MessageClassificationView {
  const metadata = message.metadata;
  const source = metadata.classSource;
  return {
    classHint:
      typeof message.classHint === "string" && (MESSAGE_CLASSES as readonly string[]).includes(message.classHint)
        ? (message.classHint as MessageClass)
        : null,
    source: typeof source === "string" && isSuggestionSource(source) ? source : null,
    asksAction: message.asksAction ?? null,
    asksReply: message.asksReply ?? null,
    timeSensitive: message.timeSensitive ?? null,
  };
}

function isSuggestionSource(value: string): value is SuggestionSource {
  return value === "manual" || value === "override" || value === "rule" || value === "jev";
}

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new ReadingError("invalid_request", `${kind} must be a UUID: ${id}`);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
