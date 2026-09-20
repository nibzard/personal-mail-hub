import type { AccountIdentity, FolderRole, SmtpSecurityMode } from "@mail-hub/database";
import type { DiscoveredFolder } from "@mail-hub/contracts";
import { AccountError } from "./errors.ts";

/**
 * Input validation for account management (SPEC F1). Every rule runs before
 * anything reaches the database, so stored accounts stay well formed and the
 * connection tests in SPEC F1 receive clean settings.
 */

/** IMAP special-use attributes the role mapper understands. */
const ROLE_BY_SPECIAL_USE: Record<string, FolderRole> = {
  "\\Archive": "archive",
  "\\Drafts": "drafts",
  "\\Junk": "junk",
  "\\Sent": "sent",
  "\\Trash": "trash",
};

/** The folder name IMAP reserves for the inbox, matched without case. */
const INBOX_NAME = "inbox";

const LABEL_MAX = 64;
const NAME_MAX = 128;
const USERNAME_MAX = 255;
const PASSWORD_MAX = 4096;
const FOLDER_NAME_MAX = 512;
const IDENTITIES_MAX = 64;
const FOLDERS_MAX = 1024;

const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
// The local part is one dot-atom (RFC 5321): dots only separate atoms, so a
// leading, trailing, or doubled dot never passes. The lookahead keeps the
// 64-character ceiling on the whole local part.
const EMAIL_PATTERN =
  /^(?=.{1,64}@)[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** A discovered folder after normalization, with the roles its hints name. */
export interface NormalizedFolder {
  name: string;
  roles: FolderRole[];
}

/** Normalize an account label. */
export function normalizeLabel(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > LABEL_MAX) {
    throw new AccountError("invalid_request", `The account label must hold 1 to ${LABEL_MAX} characters.`);
  }
  return trimmed;
}

/** Normalize an account color to the `#rrggbb` form used by interface dots. */
export function normalizeColor(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!COLOR_PATTERN.test(trimmed)) {
    throw new AccountError("invalid_request", "The account color must be a hex color, for example #2563eb.");
  }
  return trimmed;
}

/** Normalize an IMAP or SMTP host name. */
export function normalizeHost(input: string, field: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  const looksLikeIpv4 = IPV4_PATTERN.test(trimmed);
  if (
    trimmed === "" ||
    trimmed.length > 253 ||
    !(HOSTNAME_PATTERN.test(trimmed) || (looksLikeIpv4 && octetsOf(trimmed).every((part) => part <= 255)))
  ) {
    throw new AccountError("invalid_request", `The ${field} must be a valid host name or address.`);
  }
  return trimmed;
}

/** Normalize a port number. */
export function normalizePort(input: number, field: string): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > 65_535) {
    throw new AccountError("invalid_request", `The ${field} must be an integer between 1 and 65535.`);
  }
  return input;
}

/** Validate the SMTP security mode. Plaintext and optional upgrades do not exist. */
export function normalizeSmtpSecurity(input: string): SmtpSecurityMode {
  if (input === "starttls_required" || input === "implicit_tls") {
    return input;
  }
  throw new AccountError(
    "invalid_request",
    "The SMTP security mode must be starttls_required or implicit_tls.",
  );
}

/** Normalize the mailbox username. */
export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > USERNAME_MAX || CONTROL_PATTERN.test(trimmed)) {
    throw new AccountError("invalid_request", `The username must hold 1 to ${USERNAME_MAX} characters without controls.`);
  }
  return trimmed;
}

/** Validate a mailbox password before it is sealed. */
export function validatePassword(input: string): string {
  if (input.length === 0 || input.length > PASSWORD_MAX) {
    throw new AccountError("invalid_request", `The password must hold 1 to ${PASSWORD_MAX} characters.`);
  }
  return input;
}

/**
 * Validate one send-identity list. Addresses must be distinct, and a
 * non-empty list must name exactly one default (SPEC F1).
 */
export function normalizeIdentities(
  input: { address: string; name?: string | null; isDefault: boolean }[],
): AccountIdentity[] {
  if (input.length > IDENTITIES_MAX) {
    throw new AccountError("invalid_request", `An account may hold at most ${IDENTITIES_MAX} send identities.`);
  }
  const seen = new Set<string>();
  const identities: AccountIdentity[] = [];
  let defaults = 0;
  for (const item of input) {
    const address = normalizeEmailAddress(item.address);
    if (seen.has(address)) {
      throw new AccountError(
        "invalid_request",
        `The identity ${address} appears more than once. Give each identity one address.`,
      );
    }
    seen.add(address);
    if (item.isDefault === true) {
      defaults += 1;
    }
    identities.push({ address, name: normalizeIdentityName(item.name), isDefault: item.isDefault === true });
  }
  if (identities.length > 0 && defaults !== 1) {
    throw new AccountError(
      "invalid_request",
      "The identity list must name exactly one default identity.",
    );
  }
  return identities;
}

/** Normalize one send-identity address. */
export function normalizeEmailAddress(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(trimmed)) {
    throw new AccountError(
      "invalid_request",
      `The address ${trimmed === "" ? "(empty)" : trimmed} is not a valid email address.`,
    );
  }
  return trimmed;
}

/** Normalize an optional identity display name. */
function normalizeIdentityName(input: string | null | undefined): string | null {
  if (input === null || input === undefined) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length > NAME_MAX || CONTROL_PATTERN.test(trimmed)) {
    throw new AccountError(
      "invalid_request",
      `An identity name must hold at most ${NAME_MAX} characters without controls.`,
    );
  }
  return trimmed;
}

/**
 * The key one folder name identifies a folder by. RFC 3501 reserves the
 * inbox name without case, so every spelling of it names the one mailbox;
 * every other folder name identifies itself exactly.
 */
export function folderKey(name: string): string {
  return name.toLowerCase() === INBOX_NAME ? INBOX_NAME : name;
}

/**
 * Normalize one discovery run. Duplicate names reject: a server reports each
 * folder path once, so a repeat means the client data is wrong. The reserved
 * inbox name compares without case (RFC 3501), so two spellings of it count
 * as the same folder.
 */
export function normalizeDiscoveredFolders(input: DiscoveredFolder[]): NormalizedFolder[] {
  if (input.length > FOLDERS_MAX) {
    throw new AccountError("invalid_request", `One discovery run may report at most ${FOLDERS_MAX} folders.`);
  }
  const seen = new Set<string>();
  const folders: NormalizedFolder[] = [];
  for (const item of input) {
    const name = normalizeFolderName(item.name);
    if (seen.has(folderKey(name))) {
      throw new AccountError(
        "invalid_request",
        `The folder ${name} appears more than once in the discovery result.`,
      );
    }
    seen.add(folderKey(name));
    folders.push({ name, roles: rolesOf(item, name) });
  }
  return folders;
}

/** Roles one discovered folder hints at: its special-use attributes plus the reserved inbox name. */
function rolesOf(item: DiscoveredFolder, name: string): FolderRole[] {
  const roles = new Set<FolderRole>();
  if (name.toLowerCase() === INBOX_NAME) {
    roles.add("inbox");
  }
  for (const attribute of item.specialUse ?? []) {
    const role = ROLE_BY_SPECIAL_USE[attribute];
    if (role !== undefined) {
      roles.add(role);
    }
  }
  return [...roles];
}

/** Normalize one IMAP folder path. */
export function normalizeFolderName(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > FOLDER_NAME_MAX || CONTROL_PATTERN.test(trimmed)) {
    throw new AccountError("invalid_request", `A folder name must hold 1 to ${FOLDER_NAME_MAX} characters without controls.`);
  }
  return trimmed;
}

function octetsOf(address: string): number[] {
  return address.split(".").map((part) => Number.parseInt(part, 10));
}
