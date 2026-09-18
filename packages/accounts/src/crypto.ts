import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AccountError } from "./errors.ts";

/**
 * Mailbox credential encryption (SPEC section 9).
 *
 * Passwords are sealed with AES-256-GCM under `CREDENTIALS_KEY` from the
 * environment. The key never enters the database and is backed up separately:
 * losing it loses the stored credentials. Each encryption draws a fresh
 * 96-bit initialization vector, and the GCM tag covers the ciphertext and a
 * fixed context label, so a stored envelope cannot be edited or moved between
 * fields without failing decryption.
 */

/** Bound into every envelope as additional authenticated data. */
const CONTEXT = "mail-hub:credentials:v1";

/** Current envelope format. Bumping this invalidates stored credentials. */
const ENVELOPE_VERSION = "v1";

/** AES-256 requires a 256-bit key. */
const KEY_LENGTH_BYTES = 32;

/** GCM standard initialization-vector length. */
const IV_LENGTH_BYTES = 12;

/** Seals and opens mailbox credentials. */
export interface CredentialCipher {
  /** Encrypt a password into its storable envelope. */
  encrypt(plaintext: string): string;
  /** Decrypt a stored envelope. Rejects edited or foreign envelopes. */
  decrypt(envelope: string): string;
}

/**
 * Parse `CREDENTIALS_KEY` from raw configuration. Accepts 32 bytes encoded as
 * base64, base64url, or hex. Returns `null` when the value is absent or
 * unusable; callers keep account management closed instead of guessing.
 */
export function parseCredentialsKey(raw: string | null | undefined): Uint8Array | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  for (const decode of [decodeBase64, decodeHex]) {
    const bytes = decode(trimmed);
    if (bytes !== null && bytes.length === KEY_LENGTH_BYTES) {
      return bytes;
    }
  }
  return null;
}

/** Build the cipher for one parsed key. */
export function createCredentialCipher(key: Uint8Array): CredentialCipher {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new AccountError(
      "credential_invalid",
      "The credentials key must be 32 bytes for AES-256-GCM.",
    );
  }
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(CONTEXT, "utf8"));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        ENVELOPE_VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    decrypt(envelope: string): string {
      const parts = envelope.split(".");
      if (
        parts.length !== 4 ||
        parts[0] !== ENVELOPE_VERSION ||
        parts.slice(1).some((part) => part === "")
      ) {
        throw new AccountError(
          "credential_invalid",
          "A stored mailbox credential is malformed. Re-enter the account password.",
        );
      }
      const iv = decodeBase64(parts[1]!);
      const tag = decodeBase64(parts[2]!);
      const ciphertext = decodeBase64(parts[3]!);
      if (
        iv === null ||
        iv.length !== IV_LENGTH_BYTES ||
        tag === null ||
        tag.length !== 16 ||
        ciphertext === null
      ) {
        throw new AccountError(
          "credential_invalid",
          "A stored mailbox credential is malformed. Re-enter the account password.",
        );
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
        decipher.setAAD(Buffer.from(CONTEXT, "utf8"));
        decipher.setAuthTag(Buffer.from(tag));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // A failed tag check means the envelope changed or the key differs.
        // The message stays generic: it never names which one, and the
        // plaintext stays unknown either way.
        throw new AccountError(
          "credential_invalid",
          "A stored mailbox credential could not be opened with CREDENTIALS_KEY. " +
            "Check the key, then re-enter the account password.",
        );
      }
    },
  };
}

function decodeBase64(value: string): Uint8Array | null {
  // Accepts both the standard and the URL-safe alphabet, with optional padding.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    return null;
  }
  const buffer = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  // Node.js ignores undecodable tails; an empty result means the input
  // carried no complete byte at all.
  return buffer.length === 0 ? null : new Uint8Array(buffer);
}

function decodeHex(value: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    return null;
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}
