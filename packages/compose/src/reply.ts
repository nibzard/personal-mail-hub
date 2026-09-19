import type { AccountIdentity, EmailAddress, Recipients } from "@mail-hub/database";
import { ComposeError } from "./errors.ts";
import { normalizeAddressName, normalizeEmailAddress, normalizeSubject } from "./validation.ts";

/**
 * Reply addressing and frozen reply headers (SPEC F6).
 *
 * Every rule here derives from one selected parent message alone; nothing is
 * inferred from the rest of the thread. Untrusted headers decide nothing on
 * their own: `Reply-To` and `From` fill the recipient lists only through the
 * rules below, and delivery headers never select an identity.
 */

/**
 * A bracketed message identifier: `<` then any run without whitespace or
 * brackets, then `>`. This matches the exact strings the header parse and the
 * full parse both store, so a reply and the threading pass compare the same
 * text (`packages/sync/src/threads.ts`).
 */
const MESSAGE_ID_PATTERN = /<[^\s<>]+>/g;

/** The stored addressing headers one reply derives from. */
export interface ReplyParentHeaders {
  sender: EmailAddress | null;
  /** `null` when the header is absent; an empty array when it was invalid or empty. */
  replyTo: EmailAddress[] | null;
  recipients: Recipients | null;
}

/** The frozen wire references of one reply draft. */
export interface FrozenReplyReferences {
  /** The parent's single valid `Message-ID`, or `null` when unavailable. */
  inReplyTo: string | null;
  /** The parent's ancestor identifiers followed by its own, when available. */
  referenceIds: string[];
}

/**
 * The valid identifiers of one raw header value, in order, deduplicated. An
 * identifier without brackets is not valid and never enters the result.
 */
export function extractValidMessageIds(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.length === 0) {
    return [];
  }
  const ids: string[] = [];
  for (const match of raw.matchAll(MESSAGE_ID_PATTERN)) {
    const id = match[0]!;
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Freeze the reply headers of one parent (SPEC F6). `In-Reply-To` becomes the
 * parent's single valid `Message-ID`. `References` becomes the parent's valid
 * `References`, or when it has none its single valid `In-Reply-To`, followed by
 * the parent's own identifier. Unavailable identifiers are omitted, never
 * invented.
 */
export function freezeReplyReferences(parent: {
  messageId: string | null;
  inReplyTo: string | null;
  referenceIds: string[];
}): FrozenReplyReferences {
  const ownIds = extractValidMessageIds(parent.messageId);
  const parentMessageId = ownIds.length === 1 ? ownIds[0]! : null;
  const references = dedupeIds(parent.referenceIds.flatMap((id) => extractValidMessageIds(id)));
  const replyIds = extractValidMessageIds(parent.inReplyTo);
  const ancestors = references.length > 0 ? references : replyIds.length === 1 ? [replyIds[0]!] : [];
  const chain = parentMessageId === null ? ancestors : dedupeIds([...ancestors, parentMessageId]);
  return { inReplyTo: parentMessageId, referenceIds: chain };
}

/** One address key: identities and recipient lists compare without case. */
function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Resolve the From identity of one reply (SPEC F6). Your own sent message
 * reuses its sender identity. Received mail preselects one identity only when
 * exactly one configured identity of the account matches the parent's visible
 * To or Cc; zero matches means a blind copy or an unknown alias, and several
 * mean an ambiguous alias. Untrusted delivery headers never select here
 * because only To and Cc are consulted.
 */
export function preselectReplyIdentity(
  parent: ReplyParentHeaders,
  configured: AccountIdentity[],
): AccountIdentity | null {
  const senderKey = parent.sender === null ? null : addressKey(parent.sender.address);
  const own = senderKey === null ? undefined : configured.find((i) => addressKey(i.address) === senderKey);
  if (own !== undefined) {
    return own;
  }
  const visible = new Set(
    [...(parent.recipients?.to ?? []), ...(parent.recipients?.cc ?? [])].map((entry) =>
      addressKey(entry.address),
    ),
  );
  const matches = configured.filter((identity) => visible.has(addressKey(identity.address)));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Derive the recipient lists of one reply (SPEC F6).
 *
 * Reply uses the parent's valid `Reply-To` addresses, or its `From` when the
 * header is absent; a malformed or empty header requires correction. Reply all
 * adds the parent's visible To and Cc addresses to Cc. Your own sent message
 * reuses its visible recipients. Duplicates, configured identities, and Bcc
 * addresses never survive into the result; an empty result requires an
 * explicit choice.
 */
export function deriveReplyRecipients(
  parent: ReplyParentHeaders,
  identities: AccountIdentity[],
  mode: "reply" | "reply_all",
): Recipients {
  const own = new Set(identities.map((identity) => addressKey(identity.address)));
  const senderIsOwn = parent.sender !== null && own.has(addressKey(parent.sender.address));

  if (senderIsOwn) {
    const visible = parent.recipients ?? { to: [], cc: [] };
    const to = usableAddresses(visible.to, own);
    const cc = usableAddresses(visible.cc ?? [], own, to);
    requireRecipients([...to, ...cc]);
    return { to, cc };
  }

  const primary = primaryRecipients(parent);
  const to = usableAddresses(primary, own);
  if (mode === "reply") {
    requireRecipients(to);
    return { to, cc: [] };
  }
  const visible = parent.recipients ?? { to: [], cc: [] };
  const cc = usableAddresses([...visible.to, ...(visible.cc ?? [])], own, to);
  requireRecipients([...to, ...cc]);
  return { to, cc };
}

/**
 * The primary recipients of one reply: the parent's valid `Reply-To`
 * addresses, or its `From` when the header is absent. A malformed or empty
 * `Reply-To`, recorded as an empty list, requires recipient correction.
 */
function primaryRecipients(parent: ReplyParentHeaders): EmailAddress[] {
  if (parent.replyTo === null) {
    return parent.sender === null ? [] : [parent.sender];
  }
  if (parent.replyTo.length === 0) {
    throw new ComposeError(
      "recipients_required",
      "The parent message has a malformed or empty Reply-To header; correct the recipients before sending.",
    );
  }
  return parent.replyTo;
}

/** Reject an empty derived recipient set: an explicit choice is required. */
function requireRecipients(addresses: EmailAddress[]): void {
  if (addresses.length === 0) {
    throw new ComposeError(
      "recipients_required",
      "No recipients remain after removing duplicates and this account's identities; choose the recipients explicitly.",
    );
  }
}

/**
 * Convert derived addresses into draft form, in order, without duplicates.
 * Configured identities of the account are removed, addresses already placed
 * in an earlier list are dropped, and an address that cannot be sent to
 * requires correction. A display name that breaks the draft rules is dropped
 * rather than losing the address.
 */
function usableAddresses(
  entries: EmailAddress[],
  own: Set<string>,
  earlier: EmailAddress[] = [],
): EmailAddress[] {
  const seen = new Set(earlier.map((entry) => entry.address));
  const addresses: EmailAddress[] = [];
  for (const entry of entries) {
    const address = derivedAddress(entry);
    if (own.has(address) || seen.has(address)) {
      continue;
    }
    seen.add(address);
    addresses.push({ address, name: derivedName(entry) });
  }
  return addresses;
}

/** One derived address in draft form: trimmed and lowercased, or a correction. */
function derivedAddress(entry: EmailAddress): string {
  try {
    return normalizeEmailAddress(entry.address);
  } catch {
    throw new ComposeError(
      "recipients_required",
      "The parent message names a recipient address that cannot be sent to; correct the recipients.",
    );
  }
}

/** One derived display name, or `null` when it breaks the draft rules. */
function derivedName(entry: EmailAddress): string | null {
  if (entry.name === null) {
    return null;
  }
  try {
    return normalizeAddressName(entry.name);
  } catch {
    return null;
  }
}

/**
 * The subject of one reply draft: the parent's subject with an `Re:` prefix
 * unless it already carries one. A subject that cannot be stored becomes
 * absent rather than blocking the reply.
 */
export function replySubject(parentSubject: string | null): string | null {
  if (parentSubject === null) {
    return null;
  }
  const trimmed = parentSubject.trim();
  if (trimmed === "") {
    return null;
  }
  const prefixed = /^re:\s*/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
  try {
    return normalizeSubject(prefixed);
  } catch {
    return null;
  }
}

/** Deduplicate identifiers in order, keeping the first occurrence. */
function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique;
}
