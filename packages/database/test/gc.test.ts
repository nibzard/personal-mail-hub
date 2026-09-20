import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectUnreferencedDurableObjects,
  createDatabase,
  createStorage,
  DURABLE_GC_GRACE_MS,
  dropTestDatabase,
  GC_PAUSE_DIR,
  originalMessageKey,
  outboundMimeKey,
  runMigrations,
  uploadKey,
  accounts,
  uploads,
} from "../src/index.ts";

/**
 * Durable-object collection against a real PostgreSQL and a real storage
 * tree. Set `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Backdate one file so a grace-period check needs no waiting. */
async function backdate(path: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await utimes(path, past, past);
}

suite("durable object collection", () => {
  const databaseName = `mail_hub_gc_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let root: string;

  beforeAll(async () => {
    const maintenance = new URL(testDatabaseUrl!);
    maintenance.pathname = "/postgres";
    const admin = new Pool({ connectionString: maintenance.toString() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const testUrl = new URL(testDatabaseUrl!);
    testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString() });
    await runMigrations(pool);
    root = await mkdtemp(join(tmpdir(), "mail-hub-gc-"));
  });

  afterAll(async () => {
    await pool?.end();
    const maintenance = new URL(testDatabaseUrl!);
    maintenance.pathname = "/postgres";
    const admin = new Pool({ connectionString: maintenance.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  it("removes only unreferenced objects past the grace period", async () => {
    const db = createDatabase(pool);
    const storage = createStorage(root);

    const [account] = await db
      .insert(accounts)
      .values({
        label: "gc test",
        color: "#000000",
        username: "gc@example.test",
        passwordEnc: "not-a-real-credential",
      })
      .returning();

    // Referenced through the uploads table: must survive.
    const keptUploadKey = uploadKey(randomUUID());
    await storage.durable.put(keptUploadKey, new Uint8Array(10));
    await db.insert(uploads).values({
      accountId: account!.id,
      filename: "kept.bin",
      contentType: "application/octet-stream",
      sizeBytes: 10,
      storageKey: keptUploadKey,
      sha256: "0".repeat(64),
    });

    // Unreferenced but fresh: the grace period keeps it.
    const freshKey = originalMessageKey(randomUUID());
    await storage.durable.put(freshKey, new Uint8Array(20));

    // Unreferenced and stale: collected, sidecar and all.
    const staleOriginalKey = originalMessageKey(randomUUID());
    await storage.durable.put(staleOriginalKey, new Uint8Array(30));
    const staleOutboundKey = outboundMimeKey(randomUUID());
    await storage.durable.put(staleOutboundKey, new Uint8Array(40));
    await backdate(join(root, "durable", staleOriginalKey), DURABLE_GC_GRACE_MS + DAY_MS);
    await backdate(join(root, "durable", staleOutboundKey), DURABLE_GC_GRACE_MS + DAY_MS);

    const summary = await collectUnreferencedDurableObjects({ root, db });

    expect(summary.paused).toBe(false);
    expect(summary.considered).toBe(4);
    expect(summary.removed).toBe(2);
    expect(summary.retainedByGrace).toBe(1);
    expect(summary.bytesFreed).toBe(70);

    await expect(storage.durable.stat(keptUploadKey)).resolves.toMatchObject({ key: keptUploadKey });
    await expect(storage.durable.stat(freshKey)).resolves.toMatchObject({ key: freshKey });
    await expect(storage.durable.stat(staleOriginalKey)).resolves.toBeNull();
    await expect(storage.durable.stat(staleOutboundKey)).resolves.toBeNull();
    // The sidecar went with its object; the store refuses .meta.json keys by
    // design, so the check reads the filesystem directly.
    expect(existsSync(join(root, "durable", `${staleOriginalKey}.meta.json`))).toBe(false);
  });

  it("removes nothing while the backup holds the collection pause", async () => {
    const db = createDatabase(pool);
    const storage = createStorage(root);
    const key = originalMessageKey(randomUUID());
    await storage.durable.put(key, new Uint8Array(50));
    await backdate(join(root, "durable", key), DURABLE_GC_GRACE_MS + DAY_MS);

    await mkdir(join(root, GC_PAUSE_DIR));
    try {
      const summary = await collectUnreferencedDurableObjects({ root, db });
      expect(summary.paused).toBe(true);
      expect(summary.removed).toBe(0);
      expect(summary.considered).toBe(0);
      await expect(storage.durable.stat(key)).resolves.toMatchObject({ key });
    } finally {
      await rm(join(root, GC_PAUSE_DIR), { recursive: true, force: true });
    }
  });
});
