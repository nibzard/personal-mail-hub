import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  assertValidKey,
  StorageError,
  type ObjectStore,
  type Storage,
  type StorageClass,
  type StoredObjectMetadata,
} from "./object-store.ts";

const SIDECAR_SUFFIX = ".meta.json";
const TEMP_PREFIX = ".tmp-";

/**
 * How long a temp file must have sat untouched before a sweep may remove
 * it. A live write holds its temp file only while one object streams to
 * disk, so a file this old is debris from a crashed write, not a write
 * another process is still filling.
 */
export const TEMP_FILE_STALE_MS = 60 * 60 * 1000;

/**
 * The free-space pause threshold for durable writes (SPEC section 10): a
 * disk that cannot hold one more object must surface as one clear pause,
 * not as per-object write failures. 512 MiB leaves room for the largest
 * accepted message plus metadata. Deployment configuration can override it
 * through `STORAGE_MIN_FREE_BYTES`.
 */
export const DEFAULT_DURABLE_MIN_FREE_BYTES = 512 * 1024 * 1024;

/**
 * Read the pause threshold from `STORAGE_MIN_FREE_BYTES`. A blank value
 * keeps the default; a value that is not a non-negative integer is a
 * configuration error the process must refuse to start under.
 */
export function durableMinFreeBytesFromEnv(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") {
    return DEFAULT_DURABLE_MIN_FREE_BYTES;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`STORAGE_MIN_FREE_BYTES must be a non-negative integer byte count, not '${trimmed}'.`);
  }
  return parsed;
}

/** Filesystem object store for one storage class under one root directory. */
class FsObjectStore implements ObjectStore {
  readonly storageClass: StorageClass;
  private readonly root: string;
  private readonly minFreeBytes: number;

  constructor(root: string, storageClass: StorageClass, minFreeBytes = 0) {
    this.root = root;
    this.storageClass = storageClass;
    this.minFreeBytes = minFreeBytes;
  }

  /** Durable objects fsync before their write resolves, so referencing transactions commit after them. */
  private get durable(): boolean {
    return this.storageClass === "durable";
  }

  async put(key: string, bytes: Uint8Array): Promise<StoredObjectMetadata> {
    return this.writeObject(key, bytes);
  }

  async putStream(key: string, chunks: AsyncIterable<Uint8Array>): Promise<StoredObjectMetadata> {
    return this.writeObject(key, chunks);
  }

  async get(key: string): Promise<Uint8Array> {
    const filePath = this.pathFor(key);
    try {
      return await readFile(filePath);
    } catch (cause) {
      throw classifyReadError(key, cause);
    }
  }

  createReadStream(key: string): Readable {
    const filePath = this.pathFor(key);
    // Existence is checked up front for a clean error; later input or output
    // failures still surface on the stream itself.
    if (!existsSync(filePath)) {
      throw new StorageError("not_found", `Object not found: ${key}`);
    }
    return createReadStream(filePath);
  }

  async stat(key: string): Promise<StoredObjectMetadata | null> {
    const filePath = this.pathFor(key);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (cause) {
      if (isENOENT(cause)) {
        return null;
      }
      throw classifyReadError(key, cause);
    }
    const recorded = await this.readSidecar(`${filePath}${SIDECAR_SUFFIX}`, fileStat.size);
    if (recorded !== null) {
      return { key, sha256: recorded.sha256, sizeBytes: recorded.sizeBytes, storageClass: this.storageClass };
    }
    // Recovery path for a lost or stale sidecar: recompute from stored bytes.
    const bytes = await this.get(key);
    return {
      key,
      sha256: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      storageClass: this.storageClass,
    };
  }

  async verify(key: string, expectedSha256: string): Promise<boolean> {
    const bytes = await this.get(key);
    return sha256Hex(bytes) === expectedSha256;
  }

  async remove(key: string): Promise<boolean> {
    const filePath = this.pathFor(key);
    let removed = false;
    try {
      await unlink(filePath);
      removed = true;
    } catch (cause) {
      if (!isENOENT(cause)) {
        throw new StorageError("io_failed", `Failed to remove object ${key}: ${errorText(cause)}`);
      }
    }
    await unlink(`${filePath}${SIDECAR_SUFFIX}`).catch(() => undefined);
    if (removed && this.durable) {
      await fsyncDirectory(dirname(filePath));
    }
    return removed;
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    return join(this.root, ...key.split("/"));
  }

  /**
   * Refuse a durable write before it starts when the volume is too full
   * (SPEC section 10). A refused write leaves nothing behind: no temp file,
   * no partial object, no sidecar. Disposable writes skip the check; losing
   * one costs nothing. When the measurement itself fails — a filesystem
   * without the call, a root that cannot be created — the write proceeds and
   * the short-write assert still guards the bytes.
   */
  private async assertWritable(): Promise<void> {
    if (!this.durable || this.minFreeBytes <= 0) {
      return;
    }
    let available: number;
    try {
      // The root may not exist yet on a fresh installation; create it so the
      // measurement sees the real volume instead of skipping the check.
      await mkdir(this.root, { recursive: true }).catch(() => undefined);
      available = await freeBytes(this.root);
    } catch {
      return;
    }
    if (available < this.minFreeBytes) {
      throw new StorageError(
        "insufficient_space",
        `The storage volume holds ${available} free bytes, below the ${this.minFreeBytes} byte pause threshold; the durable write was refused before it started.`,
      );
    }
  }

  private async writeObject(
    key: string,
    source: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<StoredObjectMetadata> {
    await this.assertWritable();
    const finalPath = this.pathFor(key);
    const dir = dirname(finalPath);
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
    const hash = createHash("sha256");
    let sizeBytes = 0;

    const handle = await open(tempPath, "wx");
    try {
      if (source instanceof Uint8Array) {
        hash.update(source);
        sizeBytes += source.byteLength;
        await writeAll(handle, source);
      } else {
        for await (const chunk of source) {
          hash.update(chunk);
          sizeBytes += chunk.byteLength;
          await writeAll(handle, chunk);
        }
      }
      if (this.durable) {
        await handle.sync();
      }
      await handle.close();
    } catch (cause) {
      await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      if (!fromStorageLayer(cause)) {
        // The caller's stream failed on its own terms — for example a size
        // policy aborting an oversized download. Report that failure as
        // itself, so it stays distinguishable from an input or output fault.
        throw cause;
      }
      throw new StorageError("io_failed", `Failed to write object ${key}: ${errorText(cause)}`);
    }

    // The object becomes visible only through an atomic rename from the same
    // directory, so readers never observe a partial write.
    await rename(tempPath, finalPath);

    const metadata: StoredObjectMetadata = {
      key,
      sha256: hash.digest("hex"),
      sizeBytes,
      storageClass: this.storageClass,
    };
    await this.writeSidecar(`${finalPath}${SIDECAR_SUFFIX}`, metadata);
    if (this.durable) {
      await fsyncDirectory(dir);
    }
    return metadata;
  }

  private async writeSidecar(sidecarPath: string, metadata: StoredObjectMetadata): Promise<void> {
    const dir = dirname(sidecarPath);
    const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
    const handle = await open(tempPath, "wx");
    try {
      await writeAll(handle, new TextEncoder().encode(JSON.stringify(metadata)));
      if (this.durable) {
        await handle.sync();
      }
      await handle.close();
    } catch (cause) {
      await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw new StorageError("io_failed", `Failed to write object metadata: ${errorText(cause)}`);
    }
    await rename(tempPath, sidecarPath);
  }

  private async readSidecar(
    sidecarPath: string,
    sizeBytes: number,
  ): Promise<{ sha256: string; sizeBytes: number } | null> {
    try {
      const raw = await readFile(sidecarPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredObjectMetadata>;
      if (
        typeof parsed.sha256 === "string" &&
        typeof parsed.sizeBytes === "number" &&
        Number.isSafeInteger(parsed.sizeBytes) &&
        parsed.sizeBytes === sizeBytes
      ) {
        return { sha256: parsed.sha256, sizeBytes: parsed.sizeBytes };
      }
      return null;
    } catch {
      return null;
    }
  }
}

/** Create the durable and disposable stores under one storage root. */
export function createStorage(
  root: string,
  options: { durableMinFreeBytes?: number } = {},
): Storage {
  if (root.length === 0) {
    throw new TypeError("Storage root path is required.");
  }
  return {
    durable: new FsObjectStore(join(root, "durable"), "durable", options.durableMinFreeBytes ?? 0),
    disposable: new FsObjectStore(join(root, "cache"), "disposable"),
  };
}

/**
 * Free bytes available to unprivileged writes on the filesystem that holds
 * `path`. Callers use it to report disk state beside the pause threshold.
 */
export async function freeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

/**
 * Remove temp files that crashed writes left behind, and return how many
 * were removed. Every failure path a write survives removes its own temp
 * file, so what remains belongs to a process that died mid-write; the
 * durable tree would keep that debris and the nightly backup would copy
 * it. A temp file younger than the staleness bound stays, because another
 * process may still be filling it. A crash can resurrect a removed file;
 * the next sweep collects it again, so directories are not fsynced.
 */
export async function sweepTempFiles(
  root: string,
  options: { olderThanMs?: number } = {},
): Promise<number> {
  const olderThanMs = options.olderThanMs ?? TEMP_FILE_STALE_MS;
  let removed = 0;
  async function sweepDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await sweepDir(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith(TEMP_PREFIX)) {
        continue;
      }
      try {
        const fileStat = await stat(entryPath);
        if (Date.now() - fileStat.mtimeMs < olderThanMs) {
          continue;
        }
        await unlink(entryPath);
        removed += 1;
      } catch {
        // The file raced another sweep or refuses to read; the next sweep
        // retries it.
      }
    }
  }
  await sweepDir(root);
  return removed;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isENOENT(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

/** Whether a write failure came from this store or the filesystem it uses. */
function fromStorageLayer(cause: unknown): boolean {
  if (cause instanceof StorageError) {
    return true;
  }
  // Node reports filesystem faults as system errors with these fields.
  return (
    typeof cause === "object" &&
    cause !== null &&
    "errno" in cause &&
    "syscall" in cause
  );
}

function classifyReadError(key: string, cause: unknown): StorageError {
  if (isENOENT(cause)) {
    return new StorageError("not_found", `Object not found: ${key}`);
  }
  return new StorageError("io_failed", `Failed to read object ${key}: ${errorText(cause)}`);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Write the whole buffer. The filesystem can report a short write — for
 * example on a nearly full disk — and a truncated object must never become
 * visible under a full-size hash, so advance by what landed and write the
 * rest.
 */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new StorageError("io_failed", "Object write made no progress");
    }
    offset += bytesWritten;
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
