import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  bodies,
  createDatabase,
  createStorage,
  events,
  folders,
  messageOccurrences,
  messages,
  originalMessageKey,
  runMigrations,
  attachmentCacheKey,
  threads,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import { IngestionService, MAX_MESSAGE_BYTES, parseMime } from "../src/index.ts";
import { DECODED_FOOBAR, nestedMessage, standardMessage } from "./fixtures.ts";

/**
 * Ingestion acceptance against a real PostgreSQL and the filesystem store.
 * Set `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

suite("IngestionService", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let storage: Storage;
  let root: string;
  let service: IngestionService;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);

    root = await mkdtemp(join(tmpdir(), "mail-hub-ingestion-"));
    storage = createStorage(root);
    service = new IngestionService(createDatabase(pool), storage);
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

  /** One provisional logical message exactly as header import leaves it. */
  async function provisionalMessage(internalDate = new Date("2026-09-07T10:16:00Z")) {
    const [account] = await pool
      .query(
        `insert into accounts (label, color, username, password_enc) values ($1, '#111111', $2, 'v1:ct') returning id`,
        [`acc-${randomUUID().slice(0, 8)}`, `u-${randomUUID().slice(0, 8)}@example.com`],
      )
      .then((result) => result.rows as { id: string }[]);
    const db = createDatabase(pool);
    const [folder] = await db
      .insert(folders)
      .values({ accountId: account!.id, name: "INBOX", role: "inbox", uidvalidity: 1 })
      .returning();
    const [thread] = await db
      .insert(threads)
      .values({ accountId: account!.id, subjectNorm: "quarterly report" })
      .returning();
    const [message] = await db
      .insert(messages)
      .values({ accountId: account!.id, threadId: thread!.id, threadLinkState: "root", sentAt: internalDate })
      .returning();
    return { account: account!, folder: folder!, thread: thread!, message: message! };
  }

  async function addOccurrence(accountId: string, folderId: string, messageId: string, uid: number) {
    const db = createDatabase(pool);
    const [occurrence] = await db
      .insert(messageOccurrences)
      .values({
        accountId,
        folderId,
        messageId,
        uidvalidity: 1,
        uid,
        internalDate: new Date("2026-09-07T10:16:00Z"),
      })
      .returning();
    return occurrence!;
  }

  it("stores the original durably before persisting derived records", async () => {
    const { account, message } = await provisionalMessage();
    const bytes = standardMessage();

    const result = await service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes });

    expect(result.result).toBe("ingested");
    expect(result.sha256).toHaveLength(64);
    expect(result.attachmentCount).toBe(1);
    // The durable object exists and verifies before the row says fetched.
    const key = originalMessageKey(message.id);
    await expect(storage.durable.verify(key, result.sha256)).resolves.toBe(true);

    const db = createDatabase(pool);
    const row = (await db.select().from(messages).where(eq(messages.id, message.id)))[0]!;
    expect(row.fetchedBody).toBe(true);
    expect(row.originalStorageKey).toBe(key);
    expect(row.originalSha256).toBe(result.sha256);
    expect(row.sizeBytes).toBe(bytes.byteLength);
  });

  it("indexes headers and bodies and writes a sanitized body row", async () => {
    const { account, message } = await provisionalMessage();
    await service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes: standardMessage() });

    const db = createDatabase(pool);
    const row = (await db.select().from(messages).where(eq(messages.id, message.id)))[0]!;
    expect(row.messageId).toBe("<quarterly@example.com>");
    expect(row.inReplyTo).toBe("<parent@example.com>");
    expect(row.referenceIds).toEqual(["<root@example.com>", "<parent@example.com>"]);
    expect(row.sender).toEqual({ address: "alice@example.com", name: "Alice Sender" });
    expect(row.replyTo).toEqual([{ address: "replies@example.com", name: null }]);
    expect(row.subject).toBe("Quarterly report");
    expect(row.sentAt).toEqual(new Date("2026-09-07T10:15:00.000Z"));
    expect(row.snippet).toBe("Numbers look great.");
    expect(row.hasAttachments).toBe(true);
    expect(row.senderText).toBe("alice sender alice@example.com");
    expect(row.recipientsText).toBe("bob bob@example.com carol@example.com dave dave@example.com");
    expect(row.subjectText).toBe("quarterly report");
    expect(row.bodyIndexText).toBe("numbers look great.");

    const body = (await db.select().from(bodies).where(eq(bodies.messageId, message.id)))[0]!;
    expect(body.textPlain).toBe("Numbers look great.");
    expect(body.htmlSanitized).toContain("Numbers look");
    expect(body.htmlSanitized).not.toContain("script");
    expect(body.sanitizerVersion).toMatch(/^dompurify@\d+\.\d+\.\d+\/config-\d+$/);

    // The generated search vector sees header and body terms together.
    const hit = await pool.query(`select id from messages where id = $1 and search @@ plainto_tsquery('simple', 'great')`, [message.id]);
    expect(hit.rows).toHaveLength(1);
  });

  it("persists verified attachment locators and reuses part rows on repeat parsing", async () => {
    const { account, message } = await provisionalMessage();
    const bytes = nestedMessage();
    await service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes });

    const db = createDatabase(pool);
    const first = await db.select().from(attachments).where(eq(attachments.messageId, message.id));
    const parsed = await parseMime(bytes);
    expect(first.map((row) => [row.partPath, row.contentType, row.sizeBytes, row.decodedSha256])).toEqual(
      parsed.attachments.map((part) => [
        part.partPath,
        part.contentType,
        part.sizeBytes,
        part.decodedSha256,
      ]),
    );
    expect(first.map((row) => [row.partPath, row.contentType])).toEqual([
      ["/2", "message/rfc822"],
      ["/2/1/2", "application/pdf"],
    ]);
    expect(first.every((row) => row.locatorVersion === 1)).toBe(true);

    // Repeated parsing of the same bytes keeps identifiers stable.
    await service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes });
    const second = await db.select().from(attachments).where(eq(attachments.messageId, message.id));
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(await db.select().from(bodies).where(eq(bodies.messageId, message.id))).toHaveLength(1);

    const eventRows = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "message.ingested"), eq(events.entityId, message.id)));
    expect(eventRows).toHaveLength(2);
    expect(eventRows.every((row) => row.actor === "system")).toBe(true);
  });

  it("merges a byte-identical duplicate into the surviving logical message", async () => {
    const { account, folder, message: first } = await provisionalMessage();
    const second = (
      await createDatabase(pool)
        .insert(messages)
        .values({ accountId: account.id, threadId: null, threadLinkState: "root" })
        .returning()
    )[0]!;
    const bytes = standardMessage();
    await addOccurrence(account.id, folder.id, first.id, 5);
    await addOccurrence(account.id, folder.id, second.id, 6);

    await service.ingestOriginal({ accountId: account.id, messageId: first.id, bytes });
    const merged = await service.ingestOriginal({ accountId: account.id, messageId: second.id, bytes });

    expect(merged.result).toBe("merged");
    expect(merged.messageId).toBe(first.id);
    expect(merged.removedMessageId).toBe(second.id);

    const db = createDatabase(pool);
    expect(await db.select().from(messages).where(eq(messages.id, second.id))).toHaveLength(0);
    const occurrences = await db
      .select()
      .from(messageOccurrences)
      .where(eq(messageOccurrences.messageId, first.id))
      .orderBy(messageOccurrences.uid);
    expect(occurrences.map((row) => row.uid)).toEqual([5, 6]);
    expect(await db.select().from(attachments).where(eq(attachments.messageId, second.id))).toHaveLength(0);

    const mergeEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.type, "message.merged"), eq(events.entityId, first.id)));
    expect(mergeEvents).toHaveLength(1);
    expect(mergeEvents[0]!.payload).toMatchObject({ removedMessageId: second.id });
  });

  it("regenerates an attachment from the verified original into disposable storage", async () => {
    const { account, message } = await provisionalMessage();
    await service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes: standardMessage() });

    const db = createDatabase(pool);
    const row = (await db.select().from(attachments).where(eq(attachments.messageId, message.id)))[0]!;
    const regenerated = await service.regenerateAttachment(row.id);
    expect(new Uint8Array(regenerated.bytes)).toEqual(DECODED_FOOBAR);
    expect(regenerated.attachment.storageKey).toBe(attachmentCacheKey(row.id));
    expect(regenerated.attachment.fetchedAt).not.toBeNull();
    await expect(storage.disposable.get(attachmentCacheKey(row.id))).resolves.toEqual(
      Buffer.from(DECODED_FOOBAR),
    );
  });

  it("rejects regeneration on unsupported locators and changed bytes", async () => {
    const { account, message } = await provisionalMessage();
    await service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes: standardMessage() });

    const db = createDatabase(pool);
    const row = (await db.select().from(attachments).where(eq(attachments.messageId, message.id)))[0]!;

    await db.update(attachments).set({ locatorVersion: 2 }).where(eq(attachments.id, row.id));
    await expect(service.regenerateAttachment(row.id)).rejects.toMatchObject({
      name: "IngestionError",
      code: "unsupported_locator",
    });

    await db.update(attachments).set({ locatorVersion: 1 }).where(eq(attachments.id, row.id));
    await db.update(attachments).set({ partPath: "/9/9" }).where(eq(attachments.id, row.id));
    await expect(service.regenerateAttachment(row.id)).rejects.toMatchObject({
      name: "IngestionError",
      code: "locator_unresolved",
    });

    await db.update(attachments).set({ partPath: "/2" }).where(eq(attachments.id, row.id));
    await db.update(attachments).set({ decodedSha256: "0".repeat(64) }).where(eq(attachments.id, row.id));
    await expect(service.regenerateAttachment(row.id)).rejects.toMatchObject({
      name: "IngestionError",
      code: "bytes_mismatch",
    });
  });

  it("rejects unknown messages, foreign accounts, and empty input", async () => {
    const { account, message } = await provisionalMessage();

    await expect(
      service.ingestOriginal({ accountId: account.id, messageId: randomUUID(), bytes: standardMessage() }),
    ).rejects.toMatchObject({ name: "IngestionError", code: "not_found" });

    const other = await provisionalMessage();
    await expect(
      service.ingestOriginal({ accountId: other.account.id, messageId: message.id, bytes: standardMessage() }),
    ).rejects.toMatchObject({ name: "IngestionError", code: "not_found" });

    await expect(
      service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes: new Uint8Array(0) }),
    ).rejects.toMatchObject({ name: "IngestionError", code: "invalid_request" });

    await expect(
      service.ingestOriginal({ accountId: account.id, messageId: "not-a-uuid", bytes: standardMessage() }),
    ).rejects.toMatchObject({ name: "IngestionError", code: "invalid_request" });

    await expect(service.regenerateAttachment(randomUUID())).rejects.toMatchObject({
      name: "IngestionError",
      code: "not_found",
    });
  });

  it("stages a streamed original and applies it in a second step", async () => {
    const { account, message } = await provisionalMessage();
    const bytes = standardMessage();
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 32);
      yield bytes.subarray(32);
    }

    const staged = await service.stageOriginal({
      messageId: message.id,
      source: chunks(),
      expectedSize: bytes.byteLength,
    });

    expect(staged).toMatchObject({
      messageId: message.id,
      storageKey: originalMessageKey(message.id),
      sizeBytes: bytes.byteLength,
    });
    await expect(storage.durable.verify(staged.storageKey, staged.sha256)).resolves.toBe(true);

    const result = await service.applyStagedOriginal({ accountId: account.id, messageId: message.id, staged });
    expect(result).toMatchObject({ result: "ingested", sha256: staged.sha256, sizeBytes: bytes.byteLength });

    const db = createDatabase(pool);
    const row = (await db.select().from(messages).where(eq(messages.id, message.id)))[0]!;
    expect(row.fetchedBody).toBe(true);
    expect(row.originalSha256).toBe(staged.sha256);
  });

  it("rejects an original the server already reported above the bound", async () => {
    const { message } = await provisionalMessage();

    await expect(
      service.stageOriginal({ messageId: message.id, source: emptyStream(), expectedSize: MAX_MESSAGE_BYTES + 1 }),
    ).rejects.toMatchObject({ name: "IngestionError", code: "message_too_large" });
    await expect(storage.durable.stat(originalMessageKey(message.id))).resolves.toBeNull();
  });

  it("aborts a stream that crosses the bound without storing a partial object", async () => {
    const { message } = await provisionalMessage();
    // One buffer past half the bound, streamed twice: the second chunk crosses.
    const half = new Uint8Array(Math.floor(MAX_MESSAGE_BYTES / 2) + 1);
    async function* oversized(): AsyncIterable<Uint8Array> {
      yield half;
      yield half;
    }

    await expect(
      service.stageOriginal({ messageId: message.id, source: oversized() }),
    ).rejects.toMatchObject({ name: "IngestionError", code: "message_too_large" });
    await expect(storage.durable.stat(originalMessageKey(message.id))).resolves.toBeNull();
  });

  it("rejects whole bytes above the bound before anything is stored", async () => {
    const { account, message } = await provisionalMessage();

    await expect(
      service.ingestOriginal({ accountId: account.id, messageId: message.id, bytes: new Uint8Array(MAX_MESSAGE_BYTES + 1) }),
    ).rejects.toMatchObject({ name: "IngestionError", code: "message_too_large" });
    await expect(storage.durable.stat(originalMessageKey(message.id))).resolves.toBeNull();
  });
});

/** A source that ends without yielding anything. */
async function* emptyStream(): AsyncIterable<Uint8Array> {}
