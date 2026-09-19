import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  attachmentCacheKey,
  createDatabase,
  createStorage,
  dropTestDatabase,
  messages,
  runMigrations,
  type Storage,
} from "@mail-hub/database";
import { IngestionService } from "@mail-hub/ingestion";
import { ReadingService } from "../src/index.ts";
import { DECODED_FOOBAR, DECODED_SPAM, readerMessage, textOnlyMessage } from "./fixtures.ts";

/**
 * Reader acceptance against a real PostgreSQL and the filesystem store. Set
 * `TEST_DATABASE_URL` to a connection string whose user may create databases;
 * a throwaway database is created per run. Without the variable the suite
 * skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

suite("ReadingService", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let storage: Storage;
  let root: string;
  let ingestion: IngestionService;
  let reading: ReadingService;
  let regenerationCount: number;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);

    root = await mkdtemp(join(tmpdir(), "mail-hub-reading-"));
    storage = createStorage(root);
    ingestion = new IngestionService(createDatabase(pool), storage);
    // The wrapped regenerator counts calls so the tests can tell cache hits
    // from rebuilds without touching the reader's internals.
    regenerationCount = 0;
    reading = new ReadingService(createDatabase(pool), storage, async (attachmentId) => {
      regenerationCount += 1;
      return ingestion.regenerateAttachment(attachmentId);
    });
  });

  afterAll(async () => {
    await pool?.end();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  function maintenanceUrl(): string {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    return url.toString();
  }

  /** One ingested message, with the ingest result's message row id. */
  async function ingestedMessage(bytes: Uint8Array): Promise<string> {
    const db = createDatabase(pool);
    const account = await pool
      .query(
        `insert into accounts (label, color, username, password_enc) values ($1, '#111111', $2, 'v1:ct') returning id`,
        [`acc-${randomUUID().slice(0, 8)}`, `u-${randomUUID().slice(0, 8)}@example.com`],
      )
      .then((result) => result.rows[0]! as { id: string });
    const [message] = await db
      .insert(messages)
      .values({
        accountId: account.id,
        threadLinkState: "root",
        sentAt: new Date("2026-09-08T09:30:00Z"),
      })
      .returning();
    const result = await ingestion.ingestOriginal({
      accountId: account.id,
      messageId: message!.id,
      bytes,
    });
    expect(result.result).toBe("ingested");
    return message!.id;
  }

  it("serves the sanitized body and the visible headers", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const detail = await reading.readMessage(messageId);

    expect(detail.subject).toBe("September metrics");
    expect(detail.sender).toEqual({ address: "dana@example.com", name: "Dana Reporter" });
    expect(detail.recipients).toEqual({
      to: [{ address: "bob@example.com", name: "Bob" }],
      cc: [{ address: "carol@example.com", name: "Carol" }],
    });
    expect(detail.fetchedBody).toBe(true);
    expect(detail.textPlain).toBe("Metrics attached.");
    // The script is gone; the cid: reference survives for the reader to resolve.
    expect(detail.htmlSanitized).not.toContain("script");
    expect(detail.htmlSanitized).toContain('src="cid:chart@reports"');
  });

  it("marks only unique image Content-IDs as inline-resolvable", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const detail = await reading.readMessage(messageId);

    const byContentId = new Map(detail.attachments.map((part) => [part.contentId, part]));
    expect(byContentId.get("chart@reports")?.inlineResolvable).toBe(true);
    // Two parts hold twin@x, so a cid: reference to it stays a download item.
    expect(detail.attachments.filter((part) => part.contentId === "twin@x")).toHaveLength(2);
    expect(
      detail.attachments.filter((part) => part.contentId === "twin@x").every(
        (part) => !part.inlineResolvable,
      ),
    ).toBe(true);
    // A unique Content-ID on a non-image part never resolves inline.
    expect(byContentId.get("doc@pdf")?.inlineResolvable).toBe(false);
    expect(byContentId.get("doc@pdf")?.sizeBytes).toBe(DECODED_FOOBAR.byteLength);
  });

  it("reports a text-only message without an HTML derivative", async () => {
    const messageId = await ingestedMessage(textOnlyMessage());
    const detail = await reading.readMessage(messageId);

    expect(detail.fetchedBody).toBe(true);
    expect(detail.htmlSanitized).toBeNull();
    expect(detail.textPlain?.trim()).toBe("Just text.");
    expect(detail.attachments).toHaveLength(0);
  });

  it("serves verified cache bytes and rebuilds only when the cache misses", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const detail = await reading.readMessage(messageId);
    const chart = detail.attachments.find((part) => part.contentId === "chart@reports")!;

    // First open: no disposable copy exists yet, so the reader regenerates one
    // from the verified original.
    const first = await reading.openAttachment(messageId, chart.id);
    expect([...first.bytes]).toEqual([...DECODED_FOOBAR]);
    expect(first.attachment.id).toBe(chart.id);
    expect(regenerationCount).toBe(1);

    // Second open: the cached copy verifies, so nothing regenerates.
    const second = await reading.openAttachment(messageId, chart.id);
    expect([...second.bytes]).toEqual([...DECODED_FOOBAR]);
    expect(regenerationCount).toBe(1);

    // A lost cache object is a miss, not a failure (SPEC section 8).
    await storage.disposable.remove(attachmentCacheKey(chart.id));
    const third = await reading.openAttachment(messageId, chart.id);
    expect([...third.bytes]).toEqual([...DECODED_FOOBAR]);
    expect(regenerationCount).toBe(2);

    // A corrupt copy never reaches the reader; the hash check sends it to
    // regeneration instead.
    await storage.disposable.put(attachmentCacheKey(chart.id), DECODED_SPAM);
    const fourth = await reading.openAttachment(messageId, chart.id);
    expect([...fourth.bytes]).toEqual([...DECODED_FOOBAR]);
    expect(regenerationCount).toBe(3);

    // Every regeneration kept the attachment id and its recorded row.
    const row = (await createDatabase(pool).select().from(attachments).where(eq(attachments.id, chart.id)))[0]!;
    expect(row.storageKey).toBe(attachmentCacheKey(chart.id));
    expect(row.fetchedAt).not.toBeNull();
  });

  it("serves either twin of an ambiguous Content-ID by its own id", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const detail = await reading.readMessage(messageId);
    const twins = detail.attachments.filter((part) => part.contentId === "twin@x");
    const spamTwin = twins.find((part) => part.filename === "right.png")!;

    const opened = await reading.openAttachment(messageId, spamTwin.id);
    expect([...opened.bytes]).toEqual([...DECODED_SPAM]);
    expect(opened.attachment.inlineResolvable).toBe(false);
  });

  it("refuses an attachment id through another message", async () => {
    const readerId = await ingestedMessage(readerMessage());
    const otherId = await ingestedMessage(textOnlyMessage());
    const detail = await reading.readMessage(readerId);

    await expect(reading.openAttachment(otherId, detail.attachments[0]!.id)).rejects.toMatchObject({
      code: "not_found",
      httpStatus: 404,
    });
  });

  it("rejects unknown messages and malformed identifiers", async () => {
    await expect(reading.readMessage(randomUUID())).rejects.toMatchObject({
      code: "not_found",
      httpStatus: 404,
    });
    await expect(reading.readMessage("not-a-uuid")).rejects.toMatchObject({
      code: "invalid_request",
      httpStatus: 400,
    });
    const messageId = await ingestedMessage(textOnlyMessage());
    await expect(reading.openAttachment(messageId, "not-a-uuid")).rejects.toMatchObject({
      code: "invalid_request",
      httpStatus: 400,
    });
    await expect(reading.openAttachment(messageId, randomUUID())).rejects.toMatchObject({
      code: "not_found",
      httpStatus: 404,
    });
  });

  it("marks a header-only message as not fetched instead of guessing a body", async () => {
    const account = await pool
      .query(
        `insert into accounts (label, color, username, password_enc) values ($1, '#111111', $2, 'v1:ct') returning id`,
        [`acc-${randomUUID().slice(0, 8)}`, `u-${randomUUID().slice(0, 8)}@example.com`],
      )
      .then((result) => result.rows[0]! as { id: string });
    const [message] = await createDatabase(pool)
      .insert(messages)
      .values({ accountId: account.id, threadLinkState: "root" })
      .returning();

    const detail = await reading.readMessage(message!.id);
    expect(detail.fetchedBody).toBe(false);
    expect(detail.htmlSanitized).toBeNull();
    expect(detail.textPlain).toBeNull();
    expect(detail.attachments).toHaveLength(0);
  });
});
