import { access, mkdir, mkdtemp, open, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachmentCacheKey,
  createStorage,
  originalMessageKey,
  outboundMimeKey,
  StorageError,
  sweepTempFiles,
  TEMP_FILE_STALE_MS,
  uploadKey,
  type ObjectStore,
  type Storage,
} from "../src/index.ts";

const BINARY_BYTES = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let root: string;
let storage: Storage;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mail-hub-storage-"));
  storage = createStorage(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function expectRejectedKey(store: ObjectStore, key: string): Promise<void> {
  await expect(store.put(key, new Uint8Array(1))).rejects.toMatchObject({
    name: "StorageError",
    code: "invalid_key",
  });
}

describe("durable object store", () => {
  const key = originalMessageKey("11111111-1111-4111-8111-111111111111");

  it("writes and reads back exact bytes with verified metadata", async () => {
    const metadata = await storage.durable.put(key, BINARY_BYTES);
    expect(metadata).toEqual({
      key,
      sha256: sha256Hex(BINARY_BYTES),
      sizeBytes: BINARY_BYTES.byteLength,
      storageClass: "durable",
    });
    await expect(storage.durable.get(key)).resolves.toEqual(Buffer.from(BINARY_BYTES));
  });

  it("reports metadata from stat", async () => {
    await expect(storage.durable.stat(key)).resolves.toEqual({
      key,
      sha256: sha256Hex(BINARY_BYTES),
      sizeBytes: BINARY_BYTES.byteLength,
      storageClass: "durable",
    });
  });

  it("verifies content by recomputed hash", async () => {
    await expect(storage.durable.verify(key, sha256Hex(BINARY_BYTES))).resolves.toBe(true);
    await expect(storage.durable.verify(key, "0".repeat(64))).resolves.toBe(false);
  });

  it("streams writes without buffering the whole object", async () => {
    const streamKey = originalMessageKey("22222222-2222-4222-8222-222222222222");
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield BINARY_BYTES.subarray(0, 4);
      yield BINARY_BYTES.subarray(4);
    }
    const metadata = await storage.durable.putStream(streamKey, chunks());
    expect(metadata.sizeBytes).toBe(BINARY_BYTES.byteLength);
    expect(metadata.sha256).toBe(sha256Hex(BINARY_BYTES));
    await expect(storage.durable.get(streamKey)).resolves.toEqual(Buffer.from(BINARY_BYTES));
  });

  it("reports a failing caller stream as its own error and keeps stored bytes", async () => {
    const refusal = new Error("policy refusal");
    async function* failing(): AsyncIterable<Uint8Array> {
      yield BINARY_BYTES.subarray(0, 4);
      throw refusal;
    }
    await expect(storage.durable.putStream(key, failing())).rejects.toBe(refusal);
    // The failed write never became visible: the object under the key keeps
    // the bytes the earlier test stored and verified.
    await expect(storage.durable.verify(key, sha256Hex(BINARY_BYTES))).resolves.toBe(true);
  });

  it("leaves no temp file behind when the caller's stream fails", async () => {
    const refusal = new Error("policy refusal");
    async function* refusing(): AsyncIterable<Uint8Array> {
      throw refusal;
    }
    const refusalKey = originalMessageKey("99999998-9999-4999-8999-999999999998");
    await expect(storage.durable.putStream(refusalKey, refusing())).rejects.toBe(refusal);
    const objectDir = dirname(join(root, "durable", ...refusalKey.split("/")));
    const entries = await readdir(objectDir);
    expect(entries.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("loops past short filesystem writes and publishes complete bytes", async () => {
    const shortKey = originalMessageKey("99999999-9999-4999-8999-999999999999");
    // Node does not export the FileHandle class at runtime, so reach the
    // shared prototype every store handle inherits from through a probe.
    type HandleBufferWrite = (
      this: FileHandle,
      buffer: Uint8Array,
      offset?: number,
      length?: number,
    ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    const probePath = join(root, ".write-probe");
    const probe = await open(probePath, "w");
    const handlePrototype = Object.getPrototypeOf(probe) as { write: HandleBufferWrite };
    const realWrite = handlePrototype.write;
    // Bend every handle write to land only half of its bytes, the shape of a
    // short write on a nearly full disk. The store must keep writing until
    // the object and its sidecar hold every byte the hash was taken over.
    handlePrototype.write = async function (buffer, offset, length) {
      const start = offset ?? 0;
      const end = start + (length ?? buffer.byteLength - start);
      const middle = start + Math.ceil((end - start) / 2);
      return await realWrite.call(this, buffer, start, middle - start);
    };
    try {
      const metadata = await storage.durable.put(shortKey, BINARY_BYTES);
      expect(metadata.sizeBytes).toBe(BINARY_BYTES.byteLength);
      expect(metadata.sha256).toBe(sha256Hex(BINARY_BYTES));
      await expect(storage.durable.get(shortKey)).resolves.toEqual(Buffer.from(BINARY_BYTES));
      await expect(storage.durable.verify(shortKey, metadata.sha256)).resolves.toBe(true);
      await expect(storage.durable.stat(shortKey)).resolves.toMatchObject({
        sha256: sha256Hex(BINARY_BYTES),
        sizeBytes: BINARY_BYTES.byteLength,
      });
    } finally {
      handlePrototype.write = realWrite;
      await probe.close();
      await rm(probePath, { force: true });
    }
  });

  it("recomputes metadata when the sidecar is lost", async () => {
    await rm(`${join(root, "durable", ...key.split("/"))}.meta.json`, { force: true });
    await expect(storage.durable.stat(key)).resolves.toMatchObject({
      sha256: sha256Hex(BINARY_BYTES),
      sizeBytes: BINARY_BYTES.byteLength,
    });
  });

  it("exposes a readable stream for downloads", async () => {
    const stream = storage.durable.createReadStream(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(BINARY_BYTES));
  });

  it("fails with not_found for absent objects", async () => {
    const absent = originalMessageKey("33333333-3333-4333-8333-333333333333");
    await expect(storage.durable.get(absent)).rejects.toMatchObject({
      name: "StorageError",
      code: "not_found",
    });
    await expect(storage.durable.stat(absent)).resolves.toBeNull();
    expect(() => storage.durable.createReadStream(absent)).toThrow(StorageError);
  });

  it("removes objects and reports their absence", async () => {
    await expect(storage.durable.remove(key)).resolves.toBe(true);
    await expect(storage.durable.remove(key)).resolves.toBe(false);
    await expect(storage.durable.stat(key)).resolves.toBeNull();
  });
});

describe("disposable object store", () => {
  it("is isolated from the durable store under the same key", async () => {
    const key = attachmentCacheKey("44444444-4444-4444-8444-444444444444");
    await storage.disposable.put(key, BINARY_BYTES);
    const other = new Uint8Array([9, 9, 9]);
    await storage.durable.put(key, other);
    await expect(storage.disposable.get(key)).resolves.toEqual(Buffer.from(BINARY_BYTES));
    await expect(storage.durable.get(key)).resolves.toEqual(Buffer.from(other));
    expect(storage.disposable.storageClass).toBe("disposable");
    expect(storage.durable.storageClass).toBe("durable");
  });

  it("regenerates a deleted cache object from scratch", async () => {
    const key = attachmentCacheKey("55555555-5555-4555-8555-555555555555");
    await storage.disposable.put(key, BINARY_BYTES);
    await storage.disposable.remove(key);
    await expect(storage.disposable.stat(key)).resolves.toBeNull();
    const rewritten = await storage.disposable.put(key, BINARY_BYTES);
    expect(rewritten.sha256).toBe(sha256Hex(BINARY_BYTES));
  });
});

describe("key safety", () => {
  it("rejects traversal, absolute, and reserved keys", async () => {
    await expectRejectedKey(storage.durable, "../escape.eml");
    await expectRejectedKey(storage.durable, "/etc/passwd");
    await expectRejectedKey(storage.durable, "a//b");
    await expectRejectedKey(storage.durable, "a/../b");
    await expectRejectedKey(storage.durable, ".hidden");
    await expectRejectedKey(storage.durable, "object.eml.meta.json");
    await expectRejectedKey(storage.durable, "");
  });

  it("keeps written objects inside the storage root", async () => {
    const key = uploadKey("66666666-6666-4666-8666-666666666666");
    await storage.durable.put(key, BINARY_BYTES);
    const stored = await readFile(join(root, "durable", ...key.split("/")));
    expect(stored).toEqual(Buffer.from(BINARY_BYTES));
  });

  it("refuses non-uuid identifiers in key builders", () => {
    expect(() => originalMessageKey("not-a-uuid")).toThrow(TypeError);
    expect(() => outboundMimeKey("../../etc")).toThrow(TypeError);
    expect(() => uploadKey("")).toThrow(TypeError);
    expect(() => attachmentCacheKey("nope")).toThrow(TypeError);
  });

  it("produces distinct keys per object kind", () => {
    const id = "77777777-7777-4777-8777-777777777777";
    expect(new Set([originalMessageKey(id), outboundMimeKey(id), uploadKey(id), attachmentCacheKey(id)]).size)
      .toBe(4);
  });

  it("detects manual tampering through verify", async () => {
    const key = outboundMimeKey("88888888-8888-4888-8888-888888888888");
    const metadata = await storage.durable.put(key, new TextEncoder().encode("Subject: hi\r\n\r\nbody\r\n"));
    const objectPath = join(root, "durable", ...key.split("/"));
    await writeFile(objectPath, new TextEncoder().encode("tampered"));
    await expect(storage.durable.verify(key, metadata.sha256)).resolves.toBe(false);
  });
});

describe("temp file sweep", () => {
  it("clears crash debris and keeps temp files a live write may still fill", async () => {
    const dir = join(root, "durable", "uploads");
    await mkdir(dir, { recursive: true });
    const debris = join(dir, ".tmp-crashed-write");
    const inFlight = join(dir, ".tmp-live-write");
    await writeFile(debris, new TextEncoder().encode("left by a crash"));
    await writeFile(inFlight, new TextEncoder().encode("still streaming"));
    const stale = new Date(Date.now() - 2 * TEMP_FILE_STALE_MS);
    await utimes(debris, stale, stale);

    await expect(sweepTempFiles(root)).resolves.toBe(1);
    await expect(access(debris)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(inFlight)).resolves.toBeUndefined();

    // Once a skipped file ages past the bound, the next sweep collects it.
    await utimes(inFlight, stale, stale);
    await expect(sweepTempFiles(root)).resolves.toBe(1);
    await expect(access(inFlight)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never removes stored objects or their sidecars", async () => {
    const key = uploadKey("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const metadata = await storage.durable.put(key, BINARY_BYTES);
    const objectDir = dirname(join(root, "durable", ...key.split("/")));
    await writeFile(join(objectDir, ".tmp-crashed-write"), new TextEncoder().encode("debris"));

    // A zero bound makes every temp file debris, and still nothing else moves.
    await expect(sweepTempFiles(root, { olderThanMs: 0 })).resolves.toBe(1);

    await expect(storage.durable.get(key)).resolves.toEqual(Buffer.from(BINARY_BYTES));
    await expect(storage.durable.verify(key, metadata.sha256)).resolves.toBe(true);
    const sidecar = await readFile(`${join(root, "durable", ...key.split("/"))}.meta.json`);
    expect(JSON.parse(sidecar.toString())).toMatchObject({ key, sha256: metadata.sha256 });
  });
});
