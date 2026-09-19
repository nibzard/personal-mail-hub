import { createHash } from "node:crypto";
import { simpleParser, type Attachment, type ParsedMail } from "mailparser";
import type { EmailAddress, Recipients } from "@mail-hub/database";
import { IngestionError } from "./errors.ts";
import { parseDateHeader, toEmailAddress, toEmailAddresses, toRecipients } from "./text.ts";

/**
 * MIME parsing for stored originals (SPEC section 8).
 *
 * Parsing never stores anything: it turns bytes into the normalized shape the
 * ingestion service persists. Originals stay the record; everything here is a
 * regenerable derivative.
 *
 * Attachment locators, version 1:
 *
 * - `/` addresses the MIME root. Append one-based child positions for each
 *   multipart level, for example `/2/1`.
 * - A nested `message/rfc822` payload is child `1` of its wrapper, so parts
 *   inside an embedded message continue under `/2/1`.
 * - The path describes the original structure before sanitizing or
 *   extraction; it is not an IMAP UID.
 */

/** Locator version this module writes and resolves. */
export const LOCATOR_VERSION = 1 as const;

/** Embedded messages nest rarely; deeper wrappers stay undivided attachments. */
const MAX_EMBEDDED_DEPTH = 5;

/** Content types whose payload is itself a MIME message. */
const EMBEDDED_MESSAGE_TYPES = new Set(["message/rfc822", "message/global"]);

/** One verified attachment locator with its decoded bytes. */
export interface LocatedPart {
  /** Position in the original MIME tree, for example `/2/1`. */
  partPath: string;
  /** Decoded bytes as transfer encoding removes them. */
  content: Uint8Array;
  decodedSha256: string;
  sizeBytes: number;
  filename: string | null;
  contentType: string;
  /** Content-ID without angle brackets. Not a unique key. */
  contentId: string | null;
  /** `attachment` or `inline` when the part declared one. */
  disposition: string | null;
}

/** One parsed original, normalized to the message and body columns. */
export interface ParsedMessage {
  /** Grouping hint from `Message-ID`; `null` when absent. */
  messageId: string | null;
  inReplyTo: string | null;
  referenceIds: string[];
  sender: EmailAddress | null;
  /** `null` when the header is absent; an empty array when it was invalid or empty. */
  replyTo: EmailAddress[] | null;
  recipients: Recipients | null;
  subject: string | null;
  sentAt: Date | null;
  textPlain: string | null;
  /** Raw HTML part, before sanitizing. */
  html: string | null;
  attachments: LocatedPart[];
}

/**
 * The parser's part identifier and disposition fields postdate the published
 * type definitions; the pinned mailparser version provides both at runtime.
 */
type ParsedAttachment = Attachment & { partId?: string | null };

/**
 * Parse complete MIME bytes into the normalized message shape.
 *
 * `skipImageLinks` keeps `cid:` references in the HTML as they are. The
 * parser's own inlining would pick the first part of a duplicated Content-ID,
 * which SPEC section 8 forbids; the reader resolves inline images against the
 * attachment list instead.
 */
export async function parseMime(bytes: Uint8Array): Promise<ParsedMessage> {
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(toBuffer(bytes), { skipImageLinks: true });
  } catch (cause) {
    throw new IngestionError(
      "parse_failed",
      `The stored original could not be parsed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const attachments: LocatedPart[] = [];
  await collectAttachments(parsed, "/", attachments, 0);

  const replyToHeaderPresent = parsed.headers.has("reply-to");
  const references = parsed.references;
  return {
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    referenceIds: Array.isArray(references) ? references : typeof references === "string" ? [references] : [],
    sender: toEmailAddress(parsed.from?.value[0] ?? { address: null, name: null }),
    replyTo: replyToHeaderPresent ? toEmailAddresses(parsed.replyTo) : null,
    recipients: toRecipients({ to: parsed.to, cc: parsed.cc, bcc: parsed.bcc }),
    subject: parsed.subject ?? null,
    sentAt: parseDateHeader(rawDateHeader(parsed)),
    textPlain: parsed.text ?? null,
    html: parsed.html === false ? null : parsed.html ?? null,
    attachments,
  };
}

/** Address one leaf part inside the message rooted at `base`. */
function partPathFor(base: string, partId: string | null): string {
  if (partId === null || partId.length === 0) {
    return base;
  }
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}${partId.replaceAll(".", "/")}`;
}

/**
 * Collect every attachment of one message tree. An embedded message wrapper
 * is itself a located part; its payload's parts continue below `<wrapper>/1`.
 */
async function collectAttachments(
  message: ParsedMail,
  base: string,
  into: LocatedPart[],
  depth: number,
): Promise<void> {
  for (const part of (message.attachments ?? []) as ParsedAttachment[]) {
    const attachment = part;
    const partPath = partPathFor(base, attachment.partId ?? null);
    into.push({
      partPath,
      content: attachment.content,
      decodedSha256: sha256Hex(attachment.content),
      sizeBytes: attachment.content.byteLength,
      filename: attachment.filename ?? null,
      contentType: attachment.contentType,
      contentId: attachment.cid ?? null,
      disposition: attachment.contentDisposition ?? null,
    });

    const isEmbeddedMessage =
      EMBEDDED_MESSAGE_TYPES.has(attachment.contentType.toLowerCase()) && depth < MAX_EMBEDDED_DEPTH;
    if (isEmbeddedMessage) {
      try {
        const embedded = await simpleParser(attachment.content);
        await collectAttachments(embedded, `${partPath}/1`, into, depth + 1);
      } catch {
        // An unreadable payload does not invalidate the wrapper: it stays one
        // downloadable part, and regeneration verifies it by hash.
      }
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The parser reads Node buffers; copying only when the input is not one. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

/**
 * The raw `Date` header text. The parsed header map substitutes the current
 * time for unreadable dates, so only this raw line decides whether a send
 * time is real.
 */
function rawDateHeader(parsed: ParsedMail): string | null {
  const entry = (parsed.headerLines ?? []).find((line) => line.key === "date");
  if (entry === undefined) {
    return null;
  }
  const separator = entry.line.indexOf(":");
  return separator === -1 ? null : entry.line.slice(separator + 1).trim();
}
