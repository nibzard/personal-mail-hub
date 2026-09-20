import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStorage,
  dropTestDatabase,
  messages,
  runMigrations,
  type Storage,
} from "@mail-hub/database";
import { IngestionService, markThreadJobsDirty, type ThreadJobMarking } from "../src/index.ts";
import { mime } from "./fixtures.ts";

/**
 * The thread-job marks identifier changes leave behind (SPEC F2 "Message
 * identity and threading"). Extraction reads the raw stored headers and
 * tolerates comments folded around an identifier, so a row with
 * `<(note) <a@example.com>>` in `In-Reply-To` references
 * `<a@example.com>` the same as a clean one. Set `TEST_DATABASE_URL` to a
 * connection string whose user may create databases; a throwaway database
 * is created per run. Without the variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

/** The message whose arrival changes the holder set of `<a@example.com>`. */
function parentArrives(): Uint8Array {
  return mime([
    "From: parent@example.com",
    "To: someone@example.com",
    "Subject: Parent arrives",
    "Date: Mon, 07 Sep 2026 09:00:00 +0000",
    "Message-ID: <a@example.com>",
    "",
    "Parent body.",
  ]);
}

suite("markThreadJobsDirty", () => {
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

    root = await mkdtemp(join(tmpdir(), "mail-hub-thread-jobs-"));
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

  async function newAccount(): Promise<string> {
    const result = await pool.query(
      `insert into accounts (label, color, username, password_enc) values ($1, '#111111', $2, 'v1:ct') returning id`,
      [`acc-${randomUUID().slice(0, 8)}`, `u-${randomUUID().slice(0, 8)}@example.com`],
    );
    return result.rows[0].id;
  }

  /**
   * One stored message exactly as an earlier reconciliation pass left it:
   * decided, pending, and clean. The raw reference headers arrive as the
   * parses stored them.
   */
  async function storedMessage(
    accountId: string,
    fields: { inReplyTo?: string | null; referenceIds?: string[] } = {},
  ): Promise<string> {
    const [row] = await createDatabase(pool)
      .insert(messages)
      .values({
        accountId,
        inReplyTo: fields.inReplyTo ?? null,
        referenceIds: fields.referenceIds ?? [],
        threadLinkState: "pending",
        threadDirty: false,
      })
      .returning({ id: messages.id });
    return row!.id;
  }

  /** Commit one marking in its own transaction, as every caller does. */
  async function mark(accountId: string, marking: ThreadJobMarking): Promise<void> {
    await createDatabase(pool).transaction((tx) => markThreadJobsDirty(tx, accountId, marking));
  }

  async function isDirty(messageId: string): Promise<boolean> {
    const [row] = await createDatabase(pool)
      .select({ threadDirty: messages.threadDirty })
      .from(messages)
      .where(eq(messages.id, messageId));
    return row!.threadDirty;
  }

  it("re-marks a child whose folded In-Reply-To names the changed identifier", async () => {
    const accountId = await newAccount();
    // The header parse of `In-Reply-To: (note) <a@example.com>` stores this
    // raw text with no reference identifiers. An earlier pass decided the
    // row pending and cleaned its mark: no holder existed yet.
    const child = await storedMessage(accountId, { inReplyTo: "<(note) <a@example.com>>" });

    // The holder set of the identifier changed, so the child owes another
    // decision instead of staying pending forever.
    await mark(accountId, { identifiers: ["<a@example.com>"] });

    expect(await isDirty(child)).toBe(true);
  });

  it("re-marks a child whose folded References element names the changed identifier", async () => {
    const accountId = await newAccount();
    const child = await storedMessage(accountId, {
      referenceIds: ["<(note) <root@example.com>>"],
    });

    await mark(accountId, { identifiers: ["<root@example.com>"] });

    expect(await isDirty(child)).toBe(true);
  });

  it("still marks clean references and leaves unrelated rows alone", async () => {
    const accountId = await newAccount();
    const cleanReply = await storedMessage(accountId, { inReplyTo: "<a@example.com>" });
    const cleanReference = await storedMessage(accountId, {
      referenceIds: ["<earlier@example.com>", "<a@example.com>"],
    });
    const untouched = await storedMessage(accountId, { inReplyTo: "<b@example.com>" });

    await mark(accountId, { identifiers: ["<a@example.com>"] });

    expect(await isDirty(cleanReply)).toBe(true);
    expect(await isDirty(cleanReference)).toBe(true);
    expect(await isDirty(untouched)).toBe(false);
  });

  it("keeps a legal wildcard inside an identifier literal", async () => {
    const accountId = await newAccount();
    // `%` and `_` are legal inside a message identifier. Only the row that
    // names the identifier re-decides, not a sibling that shares the text
    // around its wildcards.
    const holder = await storedMessage(accountId, { inReplyTo: "<weird_100%@example.com>" });
    const sibling = await storedMessage(accountId, { inReplyTo: "<weird_1000@example.com>" });

    await mark(accountId, { identifiers: ["<weird_100%@example.com>"] });

    expect(await isDirty(holder)).toBe(true);
    expect(await isDirty(sibling)).toBe(false);
  });

  it("confines the marks to the changed account", async () => {
    const accountId = await newAccount();
    const otherAccountId = await newAccount();
    const child = await storedMessage(accountId, { inReplyTo: "<(note) <a@example.com>>" });
    const foreignChild = await storedMessage(otherAccountId, {
      inReplyTo: "<(note) <a@example.com>>",
    });

    await mark(accountId, { identifiers: ["<a@example.com>"] });

    expect(await isDirty(child)).toBe(true);
    expect(await isDirty(foreignChild)).toBe(false);
  });

  it("marks the rows the caller names directly", async () => {
    const accountId = await newAccount();
    const named = await storedMessage(accountId);

    await mark(accountId, { messageIds: [named] });

    expect(await isDirty(named)).toBe(true);
  });

  it("re-marks the folded child when ingestion announces the new holder", async () => {
    const accountId = await newAccount();
    // The child arrived first with its folded header; its pass left it
    // pending and clean because no holder of the identifier existed yet.
    const child = await storedMessage(accountId, { inReplyTo: "<(note) <a@example.com>>" });
    const parent = await storedMessage(accountId);

    await service.ingestOriginal({ accountId, messageId: parent, bytes: parentArrives() });

    // Ingestion marks its own row and every referencing row in one
    // transaction, so the next pass can link the folded child to the parent.
    expect(await isDirty(parent)).toBe(true);
    expect(await isDirty(child)).toBe(true);
  });
});
