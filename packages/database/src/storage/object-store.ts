import type { Readable } from "node:stream";

/**
 * Object storage contracts for the mail hub, from `SPEC.md` section 8.
 *
 * Two storage classes exist:
 *
 * - **Durable** objects are records: complete original MIME bytes, immutable
 *   uploads, and the exact submitted bytes of outbound mail. They live on a
 *   persistent volume, and a durable write finishes before the database
 *   transaction that references it commits.
 * - **Disposable** objects are derived caches: extracted attachment copies and
 *   other regenerable data. Losing them never loses information; content is
 *   rebuilt from a verified durable original.
 */

/** Identifies which volume an object belongs to. */
export type StorageClass = "durable" | "disposable";

/** Metadata recorded when an object is written. */
export interface StoredObjectMetadata {
  key: string;
  sha256: string;
  sizeBytes: number;
  storageClass: StorageClass;
}

/** Content-addressed byte storage for one storage class. */
export interface ObjectStore {
  readonly storageClass: StorageClass;

  /** Write a complete object and return its verified metadata. */
  put(key: string, bytes: Uint8Array): Promise<StoredObjectMetadata>;

  /** Write an object from streamed chunks. Never buffers the whole object. */
  putStream(key: string, chunks: AsyncIterable<Uint8Array>): Promise<StoredObjectMetadata>;

  /** Read a complete object. Throws `StorageError` with code `not_found` when absent. */
  get(key: string): Promise<Uint8Array>;

  /** Open a read stream for downloads. Throws `StorageError` with code `not_found` when absent. */
  createReadStream(key: string): Readable;

  /** Return metadata, or `null` when the object is absent. */
  stat(key: string): Promise<StoredObjectMetadata | null>;

  /** Recompute the hash from stored bytes and compare it with `expectedSha256`. */
  verify(key: string, expectedSha256: string): Promise<boolean>;

  /**
   * Remove an object. Returns whether the object existed.
   *
   * Garbage collection must only remove unreferenced objects after a grace
   * period longer than the backup window, and never active draft or send
   * assets (SPEC section 8). Reference tracking belongs to the caller.
   */
  remove(key: string): Promise<boolean>;
}

/** The two stores behind one root directory. */
export interface Storage {
  /** Originals, uploads, and outbound MIME bytes. Back this volume up. */
  readonly durable: ObjectStore;
  /** Regenerable caches. Lossy by design. */
  readonly disposable: ObjectStore;
}

export type StorageErrorCode = "invalid_key" | "not_found" | "io_failed";

/** Failure raised by object stores. `code` separates expected cases from bugs. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_KEY_LENGTH = 200;

/**
 * Accept only relative keys with safe segments, such as `originals/<uuid>.eml`.
 * Rejects absolute paths, traversal, hidden files, and sidecar suffixes.
 */
export function assertValidKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new StorageError("invalid_key", `Storage key length must be 1 to ${MAX_KEY_LENGTH}: ${key}`);
  }
  if (!KEY_PATTERN.test(key)) {
    throw new StorageError("invalid_key", `Storage key contains unsafe characters: ${key}`);
  }
  const segments = key.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.startsWith(".")) {
      throw new StorageError("invalid_key", `Storage key segment is reserved: ${segment}`);
    }
  }
  if (key.endsWith(".meta.json")) {
    throw new StorageError("invalid_key", "Storage key suffix .meta.json is reserved for metadata.");
  }
}
