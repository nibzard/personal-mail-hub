import { createHash, randomBytes } from "node:crypto";

/**
 * Random tokens and their stored hashes. Enrollment grants and sessions
 * store only the SHA-256 of the token (SPEC section 9).
 */

/** Generate a 256-bit random token, base64url-encoded. */
export function generateToken(): string {
  return toBase64Url(randomBytes(32));
}

/** Hash a token for storage. Only hashes are persisted. */
export function hashToken(token: string): string {
  return toBase64Url(createHash("sha256").update(token, "utf8").digest());
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
