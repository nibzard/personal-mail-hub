import { simpleParser, type ParsedMail } from "mailparser";
import type { EmailAddress, Recipients } from "@mail-hub/database";
import {
  addressesIndexText,
  normalizeIndexText,
  parseDateHeader,
  recipientsIndexText,
  replaceNul,
  replaceNulOption,
  senderIndexText,
  toEmailAddress,
  toEmailAddresses,
  toRecipients,
} from "@mail-hub/ingestion";

/**
 * Header import (SPEC F2 backfill step 3).
 *
 * One header block is the raw `BODY.PEEK[HEADER.FIELDS (...)]` answer for a
 * UID. This module turns it into exactly the columns the header import
 * transaction writes, using the same normalization the full parse applies, so
 * a message looks identical before and after its body is fetched. A block
 * that cannot be parsed imports with empty headers: content is never
 * discarded because a header was unreadable.
 */

/** The provisional columns one imported header block produces. */
export interface ImportedHeaders {
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
  /** Index text enters the search vector in the header import transaction. */
  senderText: string;
  recipientsText: string;
  addressesText: string;
  subjectText: string;
}

/** An imported header block with every field absent. */
const EMPTY_HEADERS: ImportedHeaders = {
  messageId: null,
  inReplyTo: null,
  referenceIds: [],
  sender: null,
  replyTo: null,
  recipients: null,
  subject: null,
  sentAt: null,
  senderText: "",
  recipientsText: "",
  addressesText: "",
  subjectText: "",
};

/**
 * Parse one raw header block into provisional message columns. The block may
 * be empty when a server returned nothing; that still imports the message.
 */
export async function parseHeaderBlock(rawHeaders: Uint8Array): Promise<ImportedHeaders> {
  if (rawHeaders.byteLength === 0) {
    return EMPTY_HEADERS;
  }

  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(Buffer.isBuffer(rawHeaders) ? rawHeaders : Buffer.from(rawHeaders));
  } catch {
    // An unreadable header never discards the message: import it empty and
    // let the body fetch fill what it can (SPEC F2 identity rules).
    return EMPTY_HEADERS;
  }

  const references = parsed.references;
  const sender = toEmailAddress(parsed.from?.value[0] ?? { address: null, name: null });
  const recipients = toRecipients({ to: parsed.to, cc: parsed.cc, bcc: parsed.bcc });
  // Identifiers and display text replace NUL the same way the full parse does
  // (T105), so a message looks identical before and after its body is fetched
  // and thread linking still matches either side.
  const subject = replaceNulOption(parsed.subject);
  return {
    messageId: replaceNulOption(parsed.messageId),
    inReplyTo: replaceNulOption(parsed.inReplyTo),
    referenceIds: (Array.isArray(references) ? references : typeof references === "string" ? [references] : []).map(
      replaceNul,
    ),
    sender,
    replyTo: parsed.headers.has("reply-to") ? toEmailAddresses(parsed.replyTo) : null,
    recipients,
    subject,
    sentAt: parseDateHeader(rawHeaderValue(parsed, "date")),
    senderText: normalizeIndexText(senderIndexText(sender)),
    recipientsText: normalizeIndexText(recipientsIndexText(recipients)),
    addressesText: normalizeIndexText(addressesIndexText(sender, recipients)),
    subjectText: normalizeIndexText(subject ?? ""),
  };
}

/**
 * The raw text of one header, as written on the wire. The parsed header map
 * substitutes the current time for unreadable dates, so only the raw line
 * decides whether a send time is real — the same rule ingestion applies.
 */
function rawHeaderValue(parsed: ParsedMail, field: string): string | null {
  const entry = (parsed.headerLines ?? []).find((line) => line.key === field);
  if (entry === undefined) {
    return null;
  }
  const separator = entry.line.indexOf(":");
  return separator === -1 ? null : entry.line.slice(separator + 1).trim();
}
