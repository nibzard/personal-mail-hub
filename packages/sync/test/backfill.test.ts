import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  attachments,
  bodies as bodiesTable,
  createDatabase,
  createStorage,
  folders,
  messageOccurrences,
  messages,
  runMigrations,
  type Folder,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import {
  ATTACHMENT_EDGE_PARTS,
  attachmentEdgeMetadata,
  base64NulBody,
  foldedReferencesParent,
  foldedReferencesReply,
  malformedHeaderLines,
  missingHeader,
  nestedAddressMetadata,
  nulAddressNeighbor as nulAddressMail,
  nulEverywhere,
  nulParent as corpusNulParent,
  plainValidNeighbor,
  validUnicodeNeighbor,
  type MalformedMail,
} from "@mail-hub/harness";
import { IngestionService } from "@mail-hub/ingestion";
import {
  BackfillService,
  BodyFetchService,
  ReconciliationService,
  SteadyStateService,
  SyncRunner,
  ThreadService,
  type BackfillBatchOutcome,
} from "../src/index.ts";
import { FakeMailboxSession, type FakeMessage } from "./fake-mailbox.ts";

/**
 * Backfill acceptance against a real PostgreSQL and the filesystem store
 * (SPEC section 12, "Sync, storage, and search acceptance"). Set
 * `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

/** Header lines shared by the mailbox fixtures. */
function messageHeaders(subject: string, extra: string[] = []): string {
  return [
    "From: Alice Sender <alice@example.com>",
    "To: Bob <bob@example.com>",
    `Subject: ${subject}`,
    "Date: Mon, 07 Sep 2026 10:15:00 +0000",
    `Message-ID: <${subject.toLowerCase().replaceAll(/\s+/g, "-")}@example.com>`,
    ...extra,
  ].join("\r\n");
}

/** One plain fixture message. */
function fixture(uid: number, subject: string, extra: string[] = []): FakeMessage {
  return {
    uid,
    headers: messageHeaders(subject, extra),
    body: `Body of ${subject}.`,
    flags: uid % 2 === 0 ? ["\\Seen"] : [],
    internalDate: new Date(Date.UTC(2026, 8, 7, 10, 0, 0) + uid * 60_000),
  };
}

/**
 * One corpus message loaded into the fake mailbox at a UID. The corpus
 * (T109) owns the malformed bytes; this helper only assigns the slot. The
 * incident fixtures it replaces lived here inline until T109 moved them to
 * `@mail-hub/harness`, so header import, ingestion, and backfill all pin
 * the same bytes.
 */
function corpusMessage(uid: number, mail: MalformedMail): FakeMessage {
  return {
    uid,
    headers: mail.headers,
    body: mail.body,
    internalDate: new Date(Date.UTC(2026, 8, 7, 10, 0, 0) + uid * 60_000),
  };
}

/** The NUL incident message from the corpus (docs/sync-repair-plan.md T105). */
function nulFixture(uid: number): FakeMessage {
  return corpusMessage(uid, nulEverywhere());
}

/** The parent with the matching raw-NUL Message-ID. */
function nulParent(uid: number): FakeMessage {
  return corpusMessage(uid, corpusNulParent());
}

/** The neighbor whose address tokens carry Q-encoded NUL. */
function nulAddressNeighbor(uid: number): FakeMessage {
  return corpusMessage(uid, nulAddressMail());
}

suite("BackfillService", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let storage: Storage;
  let root: string;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);

    root = await mkdtemp(join(tmpdir(), "mail-hub-sync-"));
    storage = createStorage(root);
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

  /** One account with named folders, ready to synchronize. */
  async function setupAccount(folderNames: string[]): Promise<{ accountId: string; folderIds: Map<string, Folder> }> {
    const db = createDatabase(pool);
    const [account] = await db
      .insert(accounts)
      .values({
        label: `acc-${randomUUID().slice(0, 8)}`,
        color: "#123456",
        username: `u-${randomUUID().slice(0, 8)}@example.com`,
        passwordEnc: "v1:ct",
      })
      .returning();
    const inserted = await db
      .insert(folders)
      .values(folderNames.map((name) => ({ accountId: account!.id, name })))
      .returning();
    const folderIds = new Map<string, Folder>();
    for (const folder of inserted) {
      folderIds.set(folder.name, folder);
    }
    return { accountId: account!.id, folderIds };
  }

  function services(windowSize = 200) {
    const db = createDatabase(pool);
    const ingestion = new IngestionService(db, storage);
    return {
      db,
      ingestion,
      backfill: new BackfillService(db, { windowSize }),
      bodies: new BodyFetchService(db, ingestion),
    };
  }

  /** Run batches until one reports complete, gathering outcomes. */
  async function drain(
    backfill: BackfillService,
    session: FakeMailboxSession,
    accountId: string,
    folder: Folder,
    maxBatches = 100,
  ): Promise<BackfillBatchOutcome[]> {
    const outcomes: BackfillBatchOutcome[] = [];
    for (let i = 0; i < maxBatches; i += 1) {
      const outcome = await backfill.runBatch(session, accountId, folder.id);
      outcomes.push(outcome);
      if (outcome.state === "complete" || outcome.state === "generation_changed") {
        break;
      }
      if (outcome.complete === true) {
        break;
      }
    }
    return outcomes;
  }

  async function folderRow(folderId: string) {
    const db = createDatabase(pool);
    const rows = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
    return rows[0]!;
  }

  async function occurrenceTuples(accountId: string, folderId: string) {
    const db = createDatabase(pool);
    return db
      .select({ uid: messageOccurrences.uid, unread: messageOccurrences.unread, flagged: messageOccurrences.flagged })
      .from(messageOccurrences)
      .where(and(eq(messageOccurrences.accountId, accountId), eq(messageOccurrences.folderId, folderId)))
      .orderBy(messageOccurrences.uid);
  }

  it("initializes checkpoints from UIDNEXT and imports the newest window first", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Oldest"), fixture(2, "Second"), fixture(4, "Fourth"), fixture(7, "Newest")]);

    const { backfill } = services(3);
    const initialization = await backfill.runBatch(session, accountId, folder.id);
    expect(initialization).toMatchObject({
      state: "initialized",
      upperUid: 7,
      beforeUid: 8,
      complete: false,
    });
    expect((await folderRow(folder.id)).arrivalScannedUid).toBe(7);

    // Window one covers UIDs 5 to 7: only 7 exists, the gap is normal.
    const first = await backfill.runBatch(session, accountId, folder.id);
    expect(first).toMatchObject({
      state: "imported",
      range: { low: 5, high: 7 },
      found: 1,
      imported: 1,
      beforeUid: 5,
      complete: false,
    });
    const importedSubject = await messageSubject(accountId, "Newest");
    expect(importedSubject).toBe("Newest");

    // Window two covers 2 to 4, window three the last UID.
    const second = await backfill.runBatch(session, accountId, folder.id);
    expect(second).toMatchObject({ range: { low: 2, high: 4 }, found: 2, imported: 2, beforeUid: 2 });
    const third = await backfill.runBatch(session, accountId, folder.id);
    expect(third).toMatchObject({ range: { low: 1, high: 1 }, found: 1, imported: 1, beforeUid: 1, complete: true });
    expect(await folderRow(folder.id)).toMatchObject({ backfillComplete: true, backfillBeforeUid: 1 });

    const tuples = await occurrenceTuples(accountId, folder.id);
    expect(tuples.map((tuple) => tuple.uid)).toEqual([1, 2, 4, 7]);
    // The fixture flags even UIDs as read.
    expect(tuples.map((tuple) => tuple.unread)).toEqual([true, false, false, true]);
  });

  it("resumes without gaps or duplicates after an interruption between batches", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load(
      "INBOX",
      Array.from({ length: 8 }, (_, index) => fixture(index + 1, `Resume ${index + 1}`)),
    );

    // A window size of 2 makes every batch small enough to interrupt.
    const first = services(2);
    await drainUntil(first.backfill, session, accountId, folder, 3);

    // Simulate the interruption: a fresh service instance continues later.
    const second = services(2);
    const outcomes = await drain(second.backfill, session, accountId, folder);
    expect(outcomes.at(-1)).toMatchObject({ complete: true });

    const tuples = await occurrenceTuples(accountId, folder.id);
    expect(tuples.map((tuple) => tuple.uid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const count = await countMessages(accountId);
    expect(count).toBe(8);
  });

  it("keeps backfill progress independent of new arrivals", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Old"), fixture(2, "Newer")]);

    const { backfill } = services(1);
    await backfill.runBatch(session, accountId, folder.id); // initialize
    await backfill.runBatch(session, accountId, folder.id); // import UID 2

    // An arrival lands above the captured bound while the rest imports.
    session.load("INBOX", [fixture(1, "Old"), fixture(2, "Newer"), fixture(3, "Arrival")]);
    session.uidNext = 4;
    await drain(backfill, session, accountId, folder);

    // The arrival stays for steady state; the boundary never covered it.
    const tuples = await occurrenceTuples(accountId, folder.id);
    expect(tuples.map((tuple) => tuple.uid)).toEqual([1, 2]);
    expect(await folderRow(folder.id)).toMatchObject({
      backfillComplete: true,
      backfillUpperUid: 2,
      arrivalScannedUid: 2,
    });
  });

  it("completes an empty folder at initialization", async () => {
    const { accountId, folderIds } = await setupAccount(["Archive"]);
    const folder = folderIds.get("Archive")!;
    const session = new FakeMailboxSession();
    session.load("Archive", []);
    session.uidNext = 1;

    const { backfill } = services();
    const outcome = await backfill.runBatch(session, accountId, folder.id);
    expect(outcome).toMatchObject({ state: "initialized", upperUid: 0, beforeUid: 1, complete: true });
    expect(await folderRow(folder.id)).toMatchObject({ backfillComplete: true, backfillUpperUid: 0 });
    expect(await countMessages(accountId)).toBe(0);
  });

  it("replays a restored boundary without duplicating occurrences", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "One"), fixture(2, "Two"), fixture(3, "Three")]);

    const { backfill, db } = services(2);
    await drain(backfill, session, accountId, folder);
    expect(await countMessages(accountId)).toBe(3);

    // A restore rewound the checkpoint to its initial value; the next run
    // re-covers the window and skips the committed occurrences.
    await db
      .update(folders)
      .set({ backfillBeforeUid: 4, backfillComplete: false })
      .where(eq(folders.id, folder.id));
    const replay = await backfill.runBatch(session, accountId, folder.id);
    expect(replay).toMatchObject({ state: "imported", imported: 0, skipped: 2, beforeUid: 2 });
    await drain(backfill, session, accountId, folder);
    expect(await countMessages(accountId)).toBe(3);
    expect((await occurrenceTuples(accountId, folder.id)).map((tuple) => tuple.uid)).toEqual([1, 2, 3]);
  });

  it("applies nothing when the folder generation changed", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "One"), fixture(2, "Two")]);

    const { backfill } = services(2);
    await backfill.runBatch(session, accountId, folder.id); // initialize

    // The server rebuilds the folder: a new UIDVALIDITY and reused UIDs.
    session.uidValidity = 2;
    const outcome = await backfill.runBatch(session, accountId, folder.id);
    expect(outcome).toMatchObject({
      state: "generation_changed",
      recorded: 1,
      observed: 2,
    });

    expect(await countMessages(accountId)).toBe(0);
    expect((await folderRow(folder.id)).backfillBeforeUid).toBe(3);
    const recorded = await syncEvents("sync.folder_generation_changed");
    expect(recorded).toBe(1);
  });

  it("discards a fetched window whose generation changed before the commit", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "One"), fixture(2, "Two")]);

    const { backfill } = services(2);
    await backfill.runBatch(session, accountId, folder.id); // initialize

    // The generation flips after the select, during the fetch.
    const originalFetchHeaders = session.fetchHeaders.bind(session);
    session.fetchHeaders = async (uids) => {
      const records = await originalFetchHeaders(uids);
      session.uidValidity = 2;
      return records;
    };
    const outcome = await backfill.runBatch(session, accountId, folder.id);
    expect(outcome).toMatchObject({ state: "generation_changed" });
    expect(await countMessages(accountId)).toBe(0);
    expect((await folderRow(folder.id)).backfillBeforeUid).toBe(3);
  });

  it("defers to the committed generation when a window's commit finds the folder moved", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Moved window one"), fixture(2, "Moved window two")]);

    const { backfill, db } = services(2);
    await backfill.runBatch(session, accountId, folder.id); // initialize

    // A competing cycle resets the folder while this window is in flight;
    // this session's generation is still the one it validated.
    const competing = new ReconciliationService(db);
    const originalFetchHeaders = session.fetchHeaders.bind(session);
    session.fetchHeaders = async (uids: number[]) => {
      const records = await originalFetchHeaders(uids);
      await competing.resetFolderGeneration(accountId, folder.id, 1, 2);
      return records;
    };

    // The window is discarded, and the reported change names the generation
    // this call validated against the committed one, so the guarded reset
    // recognizes the folder as already current.
    const outcome = await backfill.runBatch(session, accountId, folder.id);
    expect(outcome).toMatchObject({ state: "generation_changed", recorded: 1, observed: 2 });
    expect(await countMessages(accountId)).toBe(0);
    expect((await folderRow(folder.id)).uidvalidity).toBe(2);
  });

  it("indexes header text in the import transaction and keeps bodies pending", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Header only")]);

    const { backfill, db } = services();
    await drain(backfill, session, accountId, folder);

    const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
    const message = rows[0]!;
    expect(message.fetchedBody).toBe(false);
    expect(message.snippet).toBeNull();
    expect(message.senderText).toBe("alice sender alice@example.com");
    expect(message.recipientsText).toBe("bob bob@example.com");
    expect(message.subjectText).toBe("header only");
    expect(message.bodyIndexText).toBe("");
    expect(message.threadLinkState).toBe("pending");

    // Header matches work before the body arrives (SPEC F5).
    const hit = await pool.query(
      "select count(*)::int as count from messages where search @@ plainto_tsquery('simple', 'header only')",
    );
    expect(hit.rows[0].count).toBeGreaterThanOrEqual(1);
  });

  it("fetches bodies in the background and stores originals before marking fetched", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "First body"), fixture(2, "Second body")]);

    const { backfill, bodies, db } = services(1);
    await drain(backfill, session, accountId, folder);

    const pending = await bodies.pendingBodies(accountId, 10);
    expect(pending.map((job) => job.uid).sort((a, b) => b - a)).toEqual([2, 1]);

    for (const job of pending) {
      const outcome = await bodies.fetchBody(session, accountId, job);
      expect(outcome.state).toBe("fetched");
    }

    const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
    for (const message of rows) {
      expect(message.fetchedBody).toBe(true);
      expect(message.snippet).toContain("Body of");
      expect(message.originalStorageKey).not.toBeNull();
      expect(await storage.durable.verify(message.originalStorageKey!, message.originalSha256!)).toBe(true);
    }
    const bodyRows = await db
      .select({ messageId: bodiesTable.messageId })
      .from(bodiesTable)
      .innerJoin(messages, eq(messages.id, bodiesTable.messageId))
      .where(eq(messages.accountId, accountId));
    expect(bodyRows).toHaveLength(2);
    expect(await bodies.pendingBodies(accountId, 10)).toEqual([]);
  });

  it("merges byte-identical copies one account holds in two folders", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX", "Archive"]);
    const inbox = folderIds.get("INBOX")!;
    const archive = folderIds.get("Archive")!;
    const shared = fixture(5, "Shared bytes");
    const session = new FakeMailboxSession();
    session.load("INBOX", [shared]);
    session.load("Archive", [{ ...shared, uid: 9, flags: ["\\Seen", "\\Flagged"] }]);

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, inbox);
    await drain(backfill, session, accountId, archive);
    expect(await countMessages(accountId)).toBe(2);

    const outcomes = [];
    for (const job of await bodies.pendingBodies(accountId, 10)) {
      outcomes.push(await bodies.fetchBody(session, accountId, job));
    }
    const fetched = outcomes.filter((outcome) => outcome.state === "fetched");
    expect(fetched).toHaveLength(2);
    expect(fetched.filter((outcome) => outcome.removedMessageId !== null)).toHaveLength(1);

    // One surviving logical message owns both occurrences with their own flags.
    expect(await countMessages(accountId)).toBe(1);
    const tuples = await pool.query(
      "select f.name, o.unread, o.flagged from message_occurrences o join folders f on f.id = o.folder_id where o.account_id = $1 order by f.name",
      [accountId],
    );
    expect(tuples.rows).toEqual([
      { name: "Archive", unread: false, flagged: true },
      { name: "INBOX", unread: true, flagged: false },
    ]);
    expect(await bodies.pendingBodies(accountId, 10)).toEqual([]);
  });

  it("refuses to fetch a body against another folder generation", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Generation guard")]);

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, folder);
    const [job] = await bodies.pendingBodies(accountId, 1);
    expect(job).toBeDefined();

    session.uidValidity = 99;
    const outcome = await bodies.fetchBody(session, accountId, job!);
    expect(outcome).toMatchObject({ state: "generation_changed", recorded: 1, observed: 99 });

    // The message stays a pending body job; nothing was ingested.
    expect(await bodies.pendingBodies(accountId, 1)).toHaveLength(1);
  });

  it("reports a missing original without losing the pending job", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Soon expunged")]);

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, folder);
    const [job] = await bodies.pendingBodies(accountId, 1);

    session.load("INBOX", []);
    const outcome = await bodies.fetchBody(session, accountId, job!);
    expect(outcome).toMatchObject({ state: "missing" });
    expect(await bodies.pendingBodies(accountId, 1)).toHaveLength(1);
  });

  it("runs one bounded account cycle per connection and finishes the account", async () => {
    const { accountId } = await setupAccount(["INBOX", "Archive"]);
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Cycle one"), fixture(2, "Cycle two")]);
    session.load("Archive", [fixture(3, "Cycle archived")]);

    const { backfill, bodies } = services(1);
    // Archive spends four windows at this size: initialize, one UID, two gaps.
    const runner = new SyncRunner(createDatabase(pool), backfill, bodies, new ThreadService(createDatabase(pool)), new SteadyStateService(createDatabase(pool)), new ReconciliationService(createDatabase(pool)), { batchesPerFolder: 4 });
    const first = await runner.runAccountCycle(session, accountId);
    expect(first).toMatchObject({
      folders: 2,
      generationChanges: 0,
      imported: 3,
      bodiesFetched: 3,
    });
    expect(session.selections[0]).toBe("Archive");

    // A settled account costs one read and no remote work.
    const second = await runner.runAccountCycle(session, accountId);
    expect(second).toMatchObject({ folders: 0, batches: 0, imported: 0, bodiesFetched: 0 });
    expect(await countMessages(accountId)).toBe(3);
    expect(await bodies.pendingBodies(accountId, 10)).toEqual([]);
  });

  it("imports mail whose derived text carries NUL bytes and keeps the original bytes", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [nulParent(1), nulFixture(2), nulAddressNeighbor(3)]);

    const { backfill, bodies, db } = services();
    await drain(backfill, session, accountId, folder);

    // The poisoned window imported beside a clean neighbor: header-derived
    // text is NUL-free and keeps a replacement character where the NUL stood.
    expect(await countMessages(accountId)).toBe(3);
    const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
    const poisoned = rows.find((row) => row.subject?.includes("\uFFFD"))!;
    expect(poisoned.subject).toBe("raw\uFFFDnul and encoded\uFFFDnul");
    expect(poisoned.sender).toEqual({ address: "nul@example.com", name: "Name\uFFFDX" });
    expect(poisoned.messageId).toContain("\uFFFD");
    expect(poisoned.inReplyTo).toContain("\uFFFD");
    expect(poisoned.referenceIds.join(" ")).toContain("\uFFFD");
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("\\u0000");
    }

    const neighbor = rows.find((row) => row.subject === "Neighbor with poisoned addresses")!;
    expect(neighbor.sender).toBeNull();
    expect(neighbor.recipients).toBeNull();
    expect(neighbor.senderText).toBe("");

    // Body ingestion derives NUL-free text, snippet, index, and filenames.
    const jobs = await bodies.pendingBodies(accountId, 10);
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect((await bodies.fetchBody(session, accountId, job)).state).toBe("fetched");
    }
    const refetched = (await db.select().from(messages).where(eq(messages.id, poisoned.id)))[0]!;
    expect(refetched.snippet).toContain("body\uFFFDnul");
    expect(refetched.bodyIndexText).toContain("body\uFFFDnul");
    const bodyRow = (await db.select().from(bodiesTable).where(eq(bodiesTable.messageId, poisoned.id)))[0]!;
    expect(bodyRow.textPlain).toContain("body\uFFFDnul");
    const partRows = await db.select().from(attachments).where(eq(attachments.messageId, poisoned.id));
    expect(partRows.map((part) => part.filename)).toEqual(["file\uFFFDname.pdf"]);
    expect(JSON.stringify({ refetched, bodyRow, partRows })).not.toContain("\\u0000");

    // The stored original keeps its raw NUL bytes and its recorded hash.
    const original = await storage.durable.get(refetched.originalStorageKey!);
    expect(new TextDecoder().decode(original)).toContain("\u0000");
    expect(await storage.durable.verify(refetched.originalStorageKey!, refetched.originalSha256!)).toBe(true);

    // Thread linking still matches the sanitized identifiers on both sides:
    // the reply's parent carries the same NUL in its Message-ID.
    await new ThreadService(db).reconcileAccount(accountId);
    const relinked = (await db.select().from(messages).where(eq(messages.id, poisoned.id)))[0]!;
    const parent = (await db.select().from(messages).where(eq(messages.messageId, relinked.inReplyTo!)))[0]!;
    expect(parent).toBeDefined();
    expect(relinked).toMatchObject({ threadLinkState: "linked", parentMessageId: parent.id });
    expect(relinked.threadId).toBe(parent.threadId);

    // A replayed window imports nothing and duplicates no row.
    await drain(backfill, session, accountId, folder);
    expect(await countMessages(accountId)).toBe(3);
  });

  it("imports the malformed corpus beside valid neighbors without silent loss", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    // One window, malformed fixtures interleaved with valid neighbors: the
    // acceptance case of T109. Every message must appear — imported with
    // safe derived values — and no neighbor may stall behind a defect.
    session.load("INBOX", [
      corpusMessage(1, plainValidNeighbor()),
      corpusMessage(2, corpusNulParent()),
      corpusMessage(3, nulEverywhere()),
      corpusMessage(4, nulAddressMail()),
      corpusMessage(5, base64NulBody()),
      corpusMessage(6, missingHeader("subject")),
      corpusMessage(7, malformedHeaderLines()),
      corpusMessage(8, foldedReferencesParent()),
      corpusMessage(9, foldedReferencesReply()),
      corpusMessage(10, nestedAddressMetadata()),
      corpusMessage(11, attachmentEdgeMetadata()),
      corpusMessage(12, validUnicodeNeighbor()),
    ]);

    const { backfill, bodies, db } = services();
    await drain(backfill, session, accountId, folder);

    // No silent message loss: the whole window imported, once each.
    expect(await countMessages(accountId)).toBe(12);
    expect(await occurrenceTuples(accountId, folder.id)).toHaveLength(12);

    // Nothing that reaches the database carries a NUL: rows, bodies, parts.
    const rows = await db.select().from(messages).where(eq(messages.accountId, accountId));
    expect(JSON.stringify(rows)).not.toContain("\\u0000");

    const jobs = await bodies.pendingBodies(accountId, 20);
    expect(jobs).toHaveLength(12);
    for (const job of jobs) {
      expect((await bodies.fetchBody(session, accountId, job)).state).toBe("fetched");
    }
    const bodyRows = await db.select().from(bodiesTable);
    // Ordered by part path so the positional pairing with the known parts
    // below never depends on the database's scan order.
    const partRows = await db.select().from(attachments).orderBy(attachments.partPath);
    expect(JSON.stringify({ bodyRows, partRows })).not.toContain("\\u0000");

    const bySubject = (needle: string) => rows.find((row) => row.subject?.includes(needle))!;

    // The base64-encoded NUL reaches derived body text as the replacement
    // character, in the snippet and the search derivative alike.
    const base64 = (await db.select().from(messages).where(eq(messages.messageId, "<base64-nul@example.com>")))[0]!;
    expect(base64.snippet).toContain("x�y");
    expect(base64.bodyIndexText).toContain("x�y");

    // A missing subject is absence, not a failure: the message imported and
    // its body work completed.
    const noSubject = (await db.select().from(messages).where(eq(messages.messageId, "<present-id@example.com>")))[0]!;
    expect(noSubject.subject).toBeNull();
    expect(noSubject.subjectText).toBe("");
    expect(noSubject.snippet).toContain("Body of the message");

    // Attachment metadata edges: filenames decode (both RFC 2231 shapes),
    // a nameless part stores none, and hashes cover the decoded bytes.
    const edges = (await db.select().from(messages).where(eq(messages.messageId, "<attachment-edges@example.com>")))[0]!;
    const edgeParts = partRows.filter((part) => part.messageId === edges.id);
    expect(edgeParts.map((part) => part.filename)).toEqual(
      ATTACHMENT_EDGE_PARTS.map((part) => part.filename),
    );
    for (const [index, expected] of ATTACHMENT_EDGE_PARTS.entries()) {
      const part = edgeParts[index]!;
      const bytes = new TextEncoder().encode(expected.marker);
      expect(part.sizeBytes).toBe(bytes.byteLength);
      expect(part.decodedSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }

    // Valid Unicode survives the whole pipeline byte-for-byte, and the
    // normalized search derivative keeps every character. Read the row
    // fresh: the body fetch fills the body derivatives after import.
    const unicodeId = bySubject("Zusammenfassung").id;
    const unicode = (await db.select().from(messages).where(eq(messages.id, unicodeId)))[0]!;
    expect(unicode.subject).toBe("Zusammenfassung — Prüfung");
    expect(unicode.subjectText).toBe("zusammenfassung — prüfung");
    expect(unicode.bodyIndexText).toContain("café 日本語 🌊 stays as written");

    // Thread reconciliation links through folded references and through
    // sanitized NUL identifiers alike.
    await new ThreadService(db).reconcileAccount(accountId);
    const folded = (await db.select().from(messages).where(eq(messages.messageId, "<folded-reply@example.com>")))[0]!;
    const foldedParent = (await db.select().from(messages).where(eq(messages.messageId, "<folded-parent@example.com>")))[0]!;
    expect(folded.threadLinkState).toBe("linked");
    expect(folded.parentMessageId).toBe(foldedParent.id);
    expect(folded.threadId).toBe(foldedParent.threadId);

    // Group members from the nested-address fixture stay visible in the
    // stored recipients, NUL in the display name replaced.
    const nested = bySubject("Nested address metadata");
    expect(nested.recipients).toEqual({
      to: [
        { address: "alice@example.com", name: null },
        { address: "member@example.com", name: "Team�" + "Member" },
      ],
      cc: [
        { address: "ed@example.com", name: "Ed" },
        { address: "carol@example.com", name: null },
      ],
    });

    // A replayed window imports nothing and duplicates no row.
    await drain(backfill, session, accountId, folder);
    expect(await countMessages(accountId)).toBe(12);
    expect(await occurrenceTuples(accountId, folder.id)).toHaveLength(12);
  });

  it("rolls back a window that fails mid-transaction, then imports on retry", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "After the poisoned one"), nulFixture(2)]);

    const { backfill, bodies } = services();
    const folderRow = async () =>
      (await pool.query("select * from folders where id = $1", [folder.id])).rows[0]!;
    const initialization = await backfill.runBatch(session, accountId, folder.id);
    expect(initialization).toMatchObject({ state: "initialized" });
    const before = await folderRow();

    // The window imports newest first, so corrupting the oldest record's
    // header block makes the failure land inside the transaction, after the
    // first import ran its statements — the incident's failure class, not a
    // fetch failure. One shot only; the retry fetches cleanly.
    const originalFetchHeaders = session.fetchHeaders.bind(session);
    let corrupt = true;
    session.fetchHeaders = async (uids: number[]) => {
      const records = await originalFetchHeaders(uids);
      if (!corrupt) {
        return records;
      }
      corrupt = false;
      return [...records.slice(0, -1), { ...records.at(-1)!, rawHeaders: null as unknown as Uint8Array }];
    };
    await expect(backfill.runBatch(session, accountId, folder.id)).rejects.toThrow("byteLength");

    // The transaction rolled back both the imported row and the checkpoint
    // write, so nothing imported and the folder row is untouched.
    expect(await folderRow()).toEqual(before);
    expect(await countMessages(accountId)).toBe(0);

    // The retry of the same batch imports everything exactly once, and its
    // body jobs resolve once without repeated work.
    await drain(backfill, session, accountId, folder);
    expect(await countMessages(accountId)).toBe(2);
    const occurrences = await pool.query(
      "select count(*)::int as count from message_occurrences where folder_id = $1",
      [folder.id],
    );
    expect(occurrences.rows[0].count).toBe(2);
    expect((await folderRow()).backfill_complete).toBe(true);
    const jobs = await bodies.pendingBodies(accountId, 10);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect((await bodies.fetchBody(session, accountId, job)).state).toBe("fetched");
    }
    expect(await bodies.pendingBodies(accountId, 10)).toEqual([]);
  });

  async function countMessages(accountId: string): Promise<number> {
    const rows = await pool.query("select count(*)::int as count from messages where account_id = $1", [accountId]);
    return rows.rows[0].count;
  }

  async function messageSubject(accountId: string, subject: string): Promise<string | null> {
    const rows = await pool.query("select subject from messages where account_id = $1 and subject = $2", [
      accountId,
      subject,
    ]);
    return rows.rows[0]?.subject ?? null;
  }

  async function syncEvents(type: string): Promise<number> {
    const rows = await pool.query("select count(*)::int as count from events where type = $1", [type]);
    return rows.rows[0].count;
  }

  /** Run batches until `count` outcomes exist or the folder completes. */
  async function drainUntil(
    backfill: BackfillService,
    session: FakeMailboxSession,
    accountId: string,
    folder: Folder,
    count: number,
  ): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const outcome = await backfill.runBatch(session, accountId, folder.id);
      if (
        outcome.state === "complete" ||
        outcome.state === "generation_changed" ||
        ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete)
      ) {
        return;
      }
    }
  }
});
