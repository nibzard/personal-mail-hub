import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  attachments,
  attachmentCacheKey,
  bodies,
  createDatabase,
  createStorage,
  dropTestDatabase,
  messages,
  runMigrations,
  type Storage,
} from "@mail-hub/database";
import { IngestionService, SANITIZER_VERSION } from "@mail-hub/ingestion";
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
  let refreshCount: number;

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
    // from rebuilds without touching the reader's internals; the wrapped
    // refresher does the same for stale sanitized derivatives.
    regenerationCount = 0;
    refreshCount = 0;
    reading = new ReadingService(
      createDatabase(pool),
      storage,
      async (attachmentId) => {
        regenerationCount += 1;
        return ingestion.regenerateAttachment(attachmentId);
      },
      async (messageId) => {
        refreshCount += 1;
        return ingestion.refreshSanitizedBody(messageId);
      },
    );
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

  it("exposes the denormalized classification as a visible suggestion", async () => {
    const messageId = await ingestedMessage(readerMessage());

    // Before any answer: every field is null, so the reader renders nothing.
    expect((await reading.readMessage(messageId)).classification).toEqual({
      classHint: null,
      source: null,
      asksAction: null,
      asksReply: null,
      timeSensitive: null,
    });

    // Once an answer lands on the row, the same detail carries it (SPEC F8).
    const db = createDatabase(pool);
    await db
      .update(messages)
      .set({
        classHint: "newsletter",
        asksAction: false,
        asksReply: false,
        timeSensitive: true,
        metadata: { classSource: "jev" },
      })
      .where(eq(messages.id, messageId));
    expect((await reading.readMessage(messageId)).classification).toEqual({
      classHint: "newsletter",
      source: "jev",
      asksAction: false,
      asksReply: false,
      timeSensitive: true,
    });
  });

  it("derives the clean view from the sanitized body on request", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const view = await reading.readCleanView(messageId);

    // Extraction is derived, never stored: the same call answers again with
    // the same shape, and both HTML paths are sanitized derivatives.
    expect(view.source).toBe("extracted");
    expect(view.html).not.toContain("script");
    expect(view.html).toContain("cid:chart@reports");
    const again = await reading.readCleanView(messageId);
    expect(again).toEqual(view);
  });

  it("rebuilds a stale sanitized derivative from the original before serving it", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const db = createDatabase(pool);
    // A row sanitized under an older policy: stale output carrying a stale
    // version stamp. The current sanitizer removes the script on rebuild.
    await db
      .update(bodies)
      .set({
        htmlSanitized: "<p>September metrics</p><script>steal()</script>",
        sanitizerVersion: "dompurify@0.0.1/config-0",
      })
      .where(eq(bodies.messageId, messageId));

    const detail = await reading.readMessage(messageId);
    expect(detail.htmlSanitized).not.toContain("<script");
    // The served HTML came from the stored original, not the stale row.
    expect(detail.htmlSanitized).toContain('src="cid:chart@reports"');

    const row = (await db.select().from(bodies).where(eq(bodies.messageId, messageId)))[0]!;
    expect(row.sanitizerVersion).toBe(SANITIZER_VERSION);
    expect(row.htmlSanitized).not.toContain("<script");

    // Clean view extracts from the rebuilt derivative, never the stale one.
    const view = await reading.readCleanView(messageId);
    expect(view.html).not.toContain("<script");

    // The stored stamp is current now, so later reads rebuild nothing.
    expect(refreshCount).toBe(1);
    await reading.readMessage(messageId);
    await reading.readCleanView(messageId);
    expect(refreshCount).toBe(1);
  });

  it("serves the stored derivative when the refresh cannot complete", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const db = createDatabase(pool);
    // A stale derivative with a marker the original never produces, plus an
    // original a partial restore lost: the rebuild must throw, while the row
    // still holds sanitized output that can serve.
    await db
      .update(bodies)
      .set({
        htmlSanitized: "<p>stale derivative</p>",
        sanitizerVersion: "dompurify@0.0.1/config-0",
      })
      .where(eq(bodies.messageId, messageId));
    await db
      .update(messages)
      .set({ originalStorageKey: null, originalSha256: null })
      .where(eq(messages.id, messageId));

    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warnings.push(args.join(" "));
    });
    try {
      const failing = new ReadingService(
        createDatabase(pool),
        storage,
        (attachmentId) => ingestion.regenerateAttachment(attachmentId),
        (id) => ingestion.refreshSanitizedBody(id),
      );

      // Only htmlSanitized depends on the refresh; every other field serves
      // from the row, and the stored derivative stands in for the rebuild.
      const detail = await failing.readMessage(messageId);
      expect(detail.subject).toBe("September metrics");
      expect(detail.attachments).not.toHaveLength(0);
      expect(detail.htmlSanitized).toBe("<p>stale derivative</p>");

      // Clean view takes the same fallback instead of a generic failure.
      const view = await failing.readCleanView(messageId);
      expect(view.html).toContain("stale derivative");
    } finally {
      warn.mockRestore();
    }
    expect(warnings.join("\n")).toContain(messageId);
  });

  it("rejects clean view for a message without a sanitized HTML body", async () => {
    const messageId = await ingestedMessage(textOnlyMessage());
    await expect(reading.readCleanView(messageId)).rejects.toMatchObject({
      code: "invalid_request",
    });
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

  it("serves the row the regenerated bytes verified against", async () => {
    const messageId = await ingestedMessage(readerMessage());
    const detail = await reading.readMessage(messageId);
    const chart = detail.attachments.find((part) => part.contentId === "chart@reports")!;

    // A re-ingest that renames the part commits between the reader's snapshot
    // and the regeneration. The bytes verify against the later row, so the
    // served name and media type must come from that row, not the snapshot.
    const raced = new ReadingService(
      createDatabase(pool),
      storage,
      async (attachmentId) => {
        await createDatabase(pool)
          .update(attachments)
          .set({ filename: "chart-v2.png", contentType: "image/webp" })
          .where(eq(attachments.id, attachmentId));
        return ingestion.regenerateAttachment(attachmentId);
      },
      (id) => ingestion.refreshSanitizedBody(id),
    );

    const opened = await raced.openAttachment(messageId, chart.id);
    expect(opened.attachment.id).toBe(chart.id);
    expect(opened.attachment.filename).toBe("chart-v2.png");
    expect(opened.attachment.contentType).toBe("image/webp");
    expect([...opened.bytes]).toEqual([...DECODED_FOOBAR]);
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
