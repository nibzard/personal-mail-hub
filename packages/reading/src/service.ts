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
import { ReadingError } from "./errors.ts";

/**
 * The safe message reader (SPEC F3 and sections 8 and 9). Reads serve only
 * sanitized derivatives, never the stored original bytes, and every download
 * carries bytes the decoded hash verified — from the disposable cache or from
 * a regeneration over the verified original.
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
 * reader independent of it.
 */
export type AttachmentRegenerator = (attachmentId: string) => Promise<{ bytes: Uint8Array }>;

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
      htmlSanitized: row.body?.htmlSanitized ?? null,
      textPlain: row.body?.textPlain ?? null,
      attachments: withInlineResolution(parts),
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
      .select({ htmlSanitized: bodies.htmlSanitized })
      .from(messages)
      .leftJoin(bodies, eq(bodies.messageId, messages.id))
      .where(eq(messages.id, messageId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ReadingError("not_found", "No message exists with this identifier.");
    }
    if (row.htmlSanitized === null) {
      throw new ReadingError(
        "invalid_request",
        "This message has no sanitized HTML body to extract a clean view from.",
      );
    }
    const view = await this.extractor.extractCleanView(row.htmlSanitized);
    return { html: view.html, source: view.source };
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
    return { attachment: views[position]!, bytes: regenerated.bytes };
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

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new ReadingError("invalid_request", `${kind} must be a UUID: ${id}`);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
