import type { MessageAddress, MessageRecipients } from "@mail-hub/contracts";
import type { AccountIdentity, EmailAddress, Recipients } from "@mail-hub/database";
import { ComposeError } from "./errors.ts";

/**
 * Input validation for composing (SPEC F6). Every rule runs before anything
 * reaches the database, so stored drafts stay well formed and identity
 * choices always name a configured identity of the holding account.
 */

const NAME_MAX = 128;
const SUBJECT_MAX = 998;
/** Shared so the derived reply quote can respect the same ceiling. */
export const MARKDOWN_MAX = 1_000_000;
const FILENAME_MAX = 255;
const CONTENT_TYPE_MAX = 255;
const LIST_MAX = 100;

/** One upload may not exceed this size. The route body limit matches it. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/;
const CONTENT_TYPE_PATTERN = /^[-a-z0-9.]+\/[-a-z0-9.+*]+$/;

/**
 * Resolve the From identity of a draft (SPEC F6). An absent choice takes the
 * account's default identity; an explicit choice must name one configured
 * identity of the account, matched without case. The configured pair is
 * stored verbatim, so display names follow the account settings.
 */
export function resolveIdentity(
  configured: AccountIdentity[],
  requested?: { address: string } | null,
): EmailAddress {
  if (configured.length === 0) {
    throw new ComposeError(
      "identity_invalid",
      "This account has no send identities. Add one in account settings before composing.",
    );
  }
  if (requested === undefined || requested === null) {
    const defaultIdentity = configured.find((identity) => identity.isDefault) ?? configured[0]!;
    return { address: defaultIdentity.address, name: defaultIdentity.name };
  }
  const address = normalizeEmailAddress(requested.address);
  const match = configured.find((identity) => identity.address === address);
  if (match === undefined) {
    throw new ComposeError(
      "identity_invalid",
      `The address ${address} is not a configured identity of this account.`,
    );
  }
  return { address: match.address, name: match.name };
}

/** Normalize one recipient list of a draft. */
export function normalizeRecipients(input?: MessageRecipients | null): Recipients {
  if (input === undefined || input === null) {
    return { to: [], cc: [], bcc: [] };
  }
  return {
    to: normalizeAddressList(input.to, "To"),
    cc: normalizeAddressList(input.cc, "Cc"),
    bcc: normalizeAddressList(input.bcc, "Bcc"),
  };
}

/** Normalize a list of addresses, rejecting duplicates within one list. */
function normalizeAddressList(input: MessageAddress[] | undefined, field: string): EmailAddress[] {
  if (input === undefined || input === null) {
    return [];
  }
  if (input.length > LIST_MAX) {
    throw new ComposeError("invalid_request", `The ${field} list may hold at most ${LIST_MAX} addresses.`);
  }
  const seen = new Set<string>();
  const addresses: EmailAddress[] = [];
  for (const item of input) {
    const address = normalizeEmailAddress(item.address);
    if (seen.has(address)) {
      throw new ComposeError(
        "invalid_request",
        `The address ${address} appears more than once in the ${field} list.`,
      );
    }
    seen.add(address);
    addresses.push({ address, name: normalizeAddressName(item.name) });
  }
  return addresses;
}

/** Normalize one email address. */
export function normalizeEmailAddress(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(trimmed)) {
    throw new ComposeError(
      "invalid_request",
      `The address ${trimmed === "" ? "(empty)" : trimmed} is not a valid email address.`,
    );
  }
  return trimmed;
}

/** Normalize an optional display name. Derived names fall back to `null` when invalid. */
export function normalizeAddressName(input: string | null | undefined): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length > NAME_MAX || CONTROL_PATTERN.test(trimmed)) {
    throw new ComposeError(
      "invalid_request",
      `A display name must hold 1 to ${NAME_MAX} characters without controls.`,
    );
  }
  return trimmed;
}

/** Normalize a draft subject. An absent or blank subject clears the field. */
export function normalizeSubject(input?: string | null): string | null {
  if (input === undefined || input === null) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length > SUBJECT_MAX || CONTROL_PATTERN.test(trimmed)) {
    throw new ComposeError(
      "invalid_request",
      `A subject must hold 1 to ${SUBJECT_MAX} characters without controls.`,
    );
  }
  return trimmed;
}

/**
 * Normalize draft Markdown. The source is the record and stays verbatim;
 * only its length is bounded (SPEC F6).
 */
export function normalizeMarkdown(input?: string | null): string {
  if (input === undefined || input === null) {
    return "";
  }
  if (input.length > MARKDOWN_MAX) {
    throw new ComposeError(
      "invalid_request",
      `Draft Markdown must hold at most ${MARKDOWN_MAX} characters.`,
    );
  }
  return input;
}

/** Normalize an upload's file name. */
export function normalizeFilename(input: string): string {
  const trimmed = input.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > FILENAME_MAX ||
    trimmed === "." ||
    trimmed === ".." ||
    CONTROL_PATTERN.test(trimmed)
  ) {
    throw new ComposeError(
      "invalid_request",
      `An attachment file name must hold 1 to ${FILENAME_MAX} characters without controls.`,
    );
  }
  return trimmed;
}

/** Normalize an upload's media type. Parameters after `;` are dropped. */
export function normalizeContentType(input: string | null | undefined): string {
  const mediaType = (input ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType === "") {
    return "application/octet-stream";
  }
  if (mediaType.length > CONTENT_TYPE_MAX || !CONTENT_TYPE_PATTERN.test(mediaType)) {
    throw new ComposeError("invalid_request", "An attachment media type must be a valid content type.");
  }
  return mediaType;
}

/** Validate upload bytes before any durable write. */
export function validateUploadBytes(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) {
    throw new ComposeError("invalid_request", "Attachment bytes are empty.");
  }
  if (bytes.byteLength > UPLOAD_MAX_BYTES) {
    throw new ComposeError(
      "invalid_request",
      `An attachment may hold at most ${UPLOAD_MAX_BYTES} bytes.`,
    );
  }
}
