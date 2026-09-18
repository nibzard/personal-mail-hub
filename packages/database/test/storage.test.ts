import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachmentCacheKey,
  createStorage,
  originalMessageKey,
  outboundMimeKey,
  StorageError,
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
