import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
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

/** Filesystem object store for one storage class under one root directory. */
class FsObjectStore implements ObjectStore {
  readonly storageClass: StorageClass;
  private readonly root: string;

  constructor(root: string, storageClass: StorageClass) {
    this.root = root;
    this.storageClass = storageClass;
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

  private async writeObject(
    key: string,
    source: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<StoredObjectMetadata> {
    const finalPath = this.pathFor(key);
    const dir = dirname(finalPath);
    await mkdir(dir, { recursive: true });
    const tempPath = join(dir, `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    let sizeBytes = 0;

    const handle = await open(tempPath, "wx");
    try {
      if (source instanceof Uint8Array) {
        hash.update(source);
        sizeBytes += source.byteLength;
        await handle.write(source);
      } else {
        for await (const chunk of source) {
          hash.update(chunk);
          sizeBytes += chunk.byteLength;
          await handle.write(chunk);
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
    const tempPath = join(dir, `.tmp-${randomUUID()}`);
    const handle = await open(tempPath, "wx");
    try {
      await handle.write(JSON.stringify(metadata));
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
export function createStorage(root: string): Storage {
  if (root.length === 0) {
    throw new TypeError("Storage root path is required.");
  }
  return {
    durable: new FsObjectStore(join(root, "durable"), "durable"),
    disposable: new FsObjectStore(join(root, "cache"), "disposable"),
  };
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

async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
