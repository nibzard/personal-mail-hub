import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStorage,
  DEFAULT_DURABLE_MIN_FREE_BYTES,
  freeBytes,
  type Storage,
} from "../src/index.ts";

/*
 * The free-space pause (SPEC section 10): a durable write must refuse to
 * start when the volume holds less than the configured threshold, and the
 * refusal must leave nothing behind. Disposable writes never pause, because
 * losing one costs nothing.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mail-hub-freespace-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("durable free-space pause", () => {
  it("refuses a durable write under the threshold and leaves nothing behind", async () => {
    // A threshold no volume can satisfy forces the pause for the test.
    const storage: Storage = createStorage(root, { durableMinFreeBytes: Number.MAX_SAFE_INTEGER });
    const key = "originals/22222222-2222-4222-8222-222222222222.eml";

    await expect(storage.durable.put(key, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      name: "StorageError",
      code: "insufficient_space",
    });
    // A refused write must not leave a temp file or a partial object.
    await expect(readdir(join(root, "durable", "originals"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storage.durable.stat(key)).resolves.toBeNull();
  });

  it("keeps writing when the volume holds more than the threshold", async () => {
    const storage: Storage = createStorage(root, { durableMinFreeBytes: 1 });
    const key = "originals/33333333-3333-4333-8333-333333333333.eml";

    await expect(storage.durable.put(key, new Uint8Array([4, 5]))).resolves.toMatchObject({
      key,
      sizeBytes: 2,
    });
  });

  it("does not pause disposable writes under the threshold", async () => {
    const storage: Storage = createStorage(root, { durableMinFreeBytes: Number.MAX_SAFE_INTEGER });
    const key = "attachments/44444444-4444-4444-8444-444444444444.bin";

    await expect(storage.disposable.put(key, new Uint8Array([6]))).resolves.toMatchObject({ key });
  });

  it("reports a positive free-byte count for a real directory", async () => {
    await expect(freeBytes(root)).resolves.toBeGreaterThan(0);
  });

  it("keeps the default threshold positive", () => {
    expect(DEFAULT_DURABLE_MIN_FREE_BYTES).toBeGreaterThan(0);
  });
});
