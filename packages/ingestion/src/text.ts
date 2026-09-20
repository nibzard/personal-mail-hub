import type { AddressObject } from "mailparser";
import type { EmailAddress, Recipients } from "@mail-hub/database";

/** Address headers appear once, or as several objects when groups are used. */
export type AddressHeader = AddressObject | AddressObject[] | null | undefined;

/**
 * Text and header normalization shared by ingestion and, later, header import
 * and search. Search normalizes query text with these same functions, so the
 * index and the query always agree (SPEC F5).
 */

/** Search never needs more body text than this; long bodies truncate for indexing only. */
export const BODY_INDEX_MAX_CHARS = 200_000;

/** Snippets stay short for list rows. */
export const SNIPPET_MAX_CHARS = 200;

/** Dates outside this range are garbage, not sent times. */
const MIN_YEAR = 1970;
const MAX_YEAR = 2100;

const ADDRESS_PATTERN = /^[^\s@,;<>"()\\]+@[^\s@,;<>"()\\]+$/;

/**
 * One index-text normalization for senders, recipients, subjects, and bodies:
 * compatibility-form case folding, then whitespace collapsing. `pg_trgm`
 * prefix queries run against the result, so ingestion and queries must
 * produce identical strings.
 */
export function normalizeIndexText(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** One address as stored in message columns: trimmed, with `null` for absent names. */
export function toEmailAddress(entry: { address?: string | null; name?: string | null }): EmailAddress | null {
  const address = entry.address?.trim() ?? "";
  if (!isValidAddress(address)) {
    return null;
  }
  const name = entry.name?.trim() ?? "";
  return { address, name: name.length > 0 ? name : null };
}

/**
 * Valid addresses from one parsed header, in order. A header that yields no
 * valid address was absent, invalid, or empty; callers tell those apart from
 * the raw header.
 */
export function toEmailAddresses(header: AddressHeader): EmailAddress[] {
  const headers = Array.isArray(header) ? header : [header];
  const addresses: EmailAddress[] = [];
  for (const entry of headers.flatMap((object) => object?.value ?? [])) {
    const address = toEmailAddress(entry);
    if (address !== null) {
      addresses.push(address);
    }
  }
  return addresses;
}

/** Reject addresses without one `@` inside, with whitespace, or with header syntax inside. */
export function isValidAddress(address: string): boolean {
  return address.length > 0 && !address.includes(" ") && ADDRESS_PATTERN.test(address);
}

/**
 * Parse one raw `Date` header. The MIME parser substitutes the current time
 * for unreadable dates, so ingestion never trusts its parsed value; this
 * validator returns `null` instead and the stored send time stays untouched.
 */
export function parseDateHeader(raw: string | undefined | null): Date | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }
  return validateDateRange(new Date(value));
}

/** A date outside the plausible mail era is garbage, not a send time. */
export function validateDateRange(date: Date): Date | null {
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const year = date.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return null;
  }
  return date;
}

/** Visible recipient lists with invalid entries dropped; `null` when no header was present. */
export function toRecipients(headers: {
  to?: AddressHeader;
  cc?: AddressHeader;
  bcc?: AddressHeader;
}): Recipients | null {
  const to = toEmailAddresses(headers.to ?? undefined);
  const cc = toEmailAddresses(headers.cc ?? undefined);
  const bcc = toEmailAddresses(headers.bcc ?? undefined);
  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    return null;
  }
  const recipients: Recipients = { to };
  if (cc.length > 0) {
    recipients.cc = cc;
  }
  if (bcc.length > 0) {
    recipients.bcc = bcc;
  }
  return recipients;
}

/** Index text for a sender: display name and address, both searchable. */
export function senderIndexText(sender: EmailAddress | null): string {
  if (sender === null) {
    return "";
  }
  return sender.name === null ? sender.address : `${sender.name} ${sender.address}`;
}

/** Index text for recipient lists: names and addresses, deduplicated in order. */
export function recipientsIndexText(recipients: Recipients | null): string {
  if (recipients === null) {
    return "";
  }
  const parts: string[] = [];
  for (const address of [...recipients.to, ...(recipients.cc ?? []), ...(recipients.bcc ?? [])]) {
    parts.push(senderIndexText(address));
  }
  return parts.join(" ");
}

/**
 * Index text of addresses only, sender first (SPEC F5). `domain:` reads this
 * text, never the joined display text: a display name that carries
 * address-shaped text — a plain spoof or a fullwidth at-sign that NFKC folds
 * into one — must not satisfy a domain filter, and parsed display names
 * never enter this string.
 */
export function addressesIndexText(
  sender: EmailAddress | null,
  recipients: Recipients | null,
): string {
  const parts: string[] = [];
  if (sender !== null) {
    parts.push(sender.address);
  }
  if (recipients !== null) {
    for (const address of [...recipients.to, ...(recipients.cc ?? []), ...(recipients.bcc ?? [])]) {
      parts.push(address.address);
    }
  }
  return parts.join(" ");
}

/** One whitespace-collapsed snippet from body text, or `null` when no text exists. */
export function makeSnippet(text: string | null, maxChars = SNIPPET_MAX_CHARS): string | null {
  if (text === null) {
    return null;
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}
