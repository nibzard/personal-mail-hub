import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  folders,
  messageOccurrences,
  messages,
  runMigrations,
  threads,
} from "../src/index.ts";

/**
 * Migration acceptance against a real PostgreSQL. Set `TEST_DATABASE_URL` to a
 * connection string whose user may create databases; a throwaway database is
 * created per run. Without the variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const EXPECTED_TABLES = [
  "accounts",
  "action_items",
  "actions",
  "attachments",
  "bodies",
  "conversation_state",
  "decisions",
  "draft_uploads",
  "drafts",
  "events",
  "folders",
  "message_occurrences",
  "messages",
  "outbound_messages",
  "outbound_uploads",
  "sender_overrides",
  "service_state",
  "settings",
  "threads",
  "uploads",
];

function maintenanceUrl(): string {
  const url = new URL(testDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

suite("database migrations", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`drop database ${databaseName} with (force)`);
    await admin.end();
  });

  it("creates every specified table", async () => {
    const result = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);
  });

  it("installs pg_trgm", async () => {
    const result = await pool.query<{ extname: string }>(
      "select extname from pg_extension where extname = 'pg_trgm'",
    );
    expect(result.rows.map((row) => row.extname)).toEqual(["pg_trgm"]);
  });

  it("applies migrations idempotently", async () => {
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });

  it("feeds the generated search vector from header index text", async () => {
    const db = createDatabase(pool);
    const [account] = await db
      .insert(accounts)
      .values({ label: "test", color: "#2563eb", username: "user@example.com", passwordEnc: "v1:ct" })
      .returning();
    const [folder] = await db
      .insert(folders)
      .values({ accountId: account!.id, name: "INBOX", role: "inbox", uidvalidity: 1 })
      .returning();
    const [thread] = await db
      .insert(threads)
      .values({ accountId: account!.id, subjectNorm: "quarterly report" })
      .returning();
    await db.insert(messages).values({
      accountId: account!.id,
      threadId: thread!.id,
      threadLinkState: "root",
      senderText: "alice@example.com",
      subjectText: "Quarterly report",
      bodyIndexText: "",
    });

    const hits = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from messages where search @@ plainto_tsquery('simple', 'quarterly report')`,
    );
    expect(hits.rows[0]?.count).toBe(1);

    // The occurrence keeps its folder generation identity.
    await db.insert(messageOccurrences).values({
      accountId: account!.id,
      messageId: (
        await db.select({ id: messages.id }).from(messages).where(eq(messages.subjectText, "Quarterly report"))
      )[0]!.id,
      folderId: folder!.id,
      uidvalidity: 1,
      uid: 1,
      internalDate: new Date(),
    });
  });

  it("rejects a linked thread state without a parent", async () => {
    const db = createDatabase(pool);
    const row = (await db.select({ id: messages.id }).from(messages).limit(1))[0]!;
    await expect(
      db.update(messages).set({ threadLinkState: "linked" }).where(eq(messages.id, row.id)),
    ).rejects.toMatchObject({ cause: { constraint: "messages_thread_link_state_parent_check" } });
  });
});
