import { assertValidKey } from "./object-store.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(kind: string, id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw new TypeError(`${kind} must be a UUID: ${id}`);
  }
  return id;
}

/**
 * Storage key layout shared by all object stores. Keys are stable opaque
 * strings; the database stores them exactly as produced here.
 *
 * Durable keys:
 *
 * - `originals/<message id>.eml` — complete MIME bytes of one logical message.
 * - `outbound/<outbound id>.eml` — exact bytes submitted over SMTP.
 * - `uploads/<upload id>.bin` — one immutable uploaded file.
 *
 * Disposable keys:
 *
 * - `attachments/<attachment id>.bin` — extracted copy of one attachment,
 *   regenerated from a verified durable original.
 */

/** Durable key for the complete original MIME bytes of a message. */
export function originalMessageKey(messageId: string): string {
  const key = `originals/${requireUuid("message id", messageId)}.eml`;
  assertValidKey(key);
  return key;
}

/** Durable key for the exact MIME bytes submitted for one outbound message. */
export function outboundMimeKey(outboundId: string): string {
  const key = `outbound/${requireUuid("outbound id", outboundId)}.eml`;
  assertValidKey(key);
  return key;
}

/** Durable key for one immutable upload. */
export function uploadKey(uploadId: string): string {
  const key = `uploads/${requireUuid("upload id", uploadId)}.bin`;
  assertValidKey(key);
  return key;
}

/** Disposable key for the extracted copy of one attachment. */
export function attachmentCacheKey(attachmentId: string): string {
  const key = `attachments/${requireUuid("attachment id", attachmentId)}.bin`;
  assertValidKey(key);
  return key;
}
