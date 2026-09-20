import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  createStorage,
  folders,
  messageOccurrences,
  messages,
  originalMessageKey,
  runMigrations,
  type Folder,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import { IngestionError, IngestionService, MAX_MESSAGE_BYTES } from "@mail-hub/ingestion";
import {
  BackfillService,
  BodyFetchService,
  FOLDER_INVENTORY_EVENT,
  FOLDER_POLLED_EVENT,
  INBOX_POLL_INTERVAL_MS,
  OTHER_FOLDER_POLL_INTERVAL_MS,
  ReconciliationService,
  SteadyStateService,
  SyncRunner,
  ThreadService,
} from "../src/index.ts";
import { FakeMailboxSession, type FakeMessage } from "./fake-mailbox.ts";

/**
 * Steady-state and reconciliation acceptance against a real PostgreSQL and the
 * filesystem store (SPEC F2 and section 12). Set `TEST_DATABASE_URL` to a
 * connection string whose user may create databases; a throwaway database is
 * created per run. Without the variable the suite skips.
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
function fixture(uid: number, subject: string, flags: string[] = []): FakeMessage {
  return {
    uid,
    headers: messageHeaders(subject),
    body: `Body of ${subject}.`,
    flags,
    internalDate: new Date(Date.UTC(2026, 8, 7, 10, 0, 0) + uid * 60_000),
  };
}

suite("SteadyStateService and ReconciliationService", () => {
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

    root = await mkdtemp(join(tmpdir(), "mail-hub-steady-"));
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
  async function setupAccount(
    folderSpecs: Array<{ name: string; role?: "inbox" }>,
  ): Promise<{ accountId: string; folderIds: Map<string, Folder> }> {
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
      .values(folderSpecs.map((spec) => ({ accountId: account!.id, name: spec.name, role: spec.role })))
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
      steady: new SteadyStateService(db),
      reconcile: new ReconciliationService(db),
    };
  }

  /** Run backfill batches until the folder completes. */
  async function drain(
    backfill: BackfillService,
    session: FakeMailboxSession,
    accountId: string,
    folder: Folder,
  ): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const outcome = await backfill.runBatch(session, accountId, folder.id);
      if (
        outcome.state === "generation_changed" ||
        ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete) ||
        outcome.state === "complete"
      ) {
        return;
      }
    }
    throw new Error("The backfill drain did not finish the folder.");
  }

  async function folderRow(folderId: string): Promise<Folder> {
    const rows = await createDatabase(pool).select().from(folders).where(eq(folders.id, folderId)).limit(1);
    return rows[0]!;
  }

  async function occurrenceRows(accountId: string, folderId: string) {
    return createDatabase(pool)
      .select()
      .from(messageOccurrences)
      .where(and(eq(messageOccurrences.accountId, accountId), eq(messageOccurrences.folderId, folderId)))
      .orderBy(messageOccurrences.uidvalidity, messageOccurrences.uid);
  }

  async function countMessages(accountId: string): Promise<number> {
    const rows = await pool.query("select count(*)::int as count from messages where account_id = $1", [accountId]);
    return rows.rows[0].count;
  }

  /** Events of one type for one entity, so parallel tests never collide. */
  async function eventsOf(type: string, entityId: string) {
    const rows = await pool.query("select payload from events where type = $1 and entity_id = $2 order by at", [
      type,
      entityId,
    ]);
    return rows.rows.map((row) => row.payload as Record<string, unknown>);
  }

  it("captures the arrival bound and imports arrivals above the scanned checkpoint", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Steady one"), fixture(2, "Steady two")]);

    const { backfill, steady } = services();
    await drain(backfill, session, accountId, folder);
    expect((await folderRow(folder.id)).arrivalScannedUid).toBe(2);

    // Two arrivals land above the captured bound before the first poll.
    session.load(
      "INBOX",
      [
        fixture(1, "Steady one"),
        fixture(2, "Steady two"),
        fixture(3, "Steady three", ["\\Seen"]),
        fixture(5, "Steady five"),
      ],
    );

    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({
      state: "polled",
      bound: 5,
      found: 2,
      imported: 2,
      skipped: 0,
      flagsObserved: 4,
      flagsChanged: 0,
      expunged: 0,
    });
    // The bound commits with the rows (SPEC F2 steady state).
    expect((await folderRow(folder.id)).arrivalScannedUid).toBe(5);

    const uids = (await occurrenceRows(accountId, folder.id)).map((row) => row.uid);
    expect(uids).toEqual([1, 2, 3, 5]);

    // A repeated poll re-covers nothing and duplicates nothing.
    const repeat = await steady.pollFolder(session, accountId, folder.id);
    expect(repeat).toMatchObject({ state: "polled", bound: 5, found: 0, imported: 0, expunged: 0 });
    expect(await countMessages(accountId)).toBe(4);
    const polled = await eventsOf(FOLDER_POLLED_EVENT, folder.id);
    expect(polled).toHaveLength(2);
    expect(polled.at(-1)).toMatchObject({ bound: 5, imported: 0 });
  });

  it("imports a downtime backlog in bounded batches with the same totals", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Backlog one"), fixture(2, "Backlog two")]);

    const { backfill } = services();
    await drain(backfill, session, accountId, folder);

    // Seven arrivals land during downtime; the poll owes them all at once.
    session.load(
      "INBOX",
      Array.from({ length: 9 }, (_, index) => fixture(index + 1, `Backlog ${index + 1}`)),
    );

    // Every remote read stays inside its batch bound while the poll runs.
    const headerWindows: number[][] = [];
    const flagWindows: number[][] = [];
    const originalFetchHeaders = session.fetchHeaders.bind(session);
    const originalFetchFlags = session.fetchFlags.bind(session);
    session.fetchHeaders = async (uids: number[]) => {
      headerWindows.push([...uids]);
      return originalFetchHeaders(uids);
    };
    session.fetchFlags = async (uids: number[]) => {
      flagWindows.push([...uids]);
      return originalFetchFlags(uids);
    };

    const batched = new SteadyStateService(createDatabase(pool), { arrivalBatch: 3, flagBatch: 2 });
    const poll = await batched.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({
      state: "polled",
      bound: 9,
      found: 7,
      imported: 7,
      flagsObserved: 9,
      flagsChanged: 0,
      expunged: 0,
    });
    expect((await folderRow(folder.id)).arrivalScannedUid).toBe(9);

    // Header windows never exceed the arrival batch; flag pages never exceed
    // the flag batch, and the occurrences were read page by page.
    expect(headerWindows.length).toBe(3);
    expect(headerWindows.map((uids) => uids.length)).toEqual([3, 3, 1]);
    expect(flagWindows.length).toBe(5);
    expect(flagWindows.every((uids) => uids.length <= 2)).toBe(true);
    expect(await countMessages(accountId)).toBe(9);
  });

  it("skips oversized messages at import and never lists them as body jobs", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Huge one"), fixture(2, "Small two")]);

    // The server reports the first message above the maximum size.
    const originalFetchHeaders = session.fetchHeaders.bind(session);
    session.fetchHeaders = async (uids: number[]) => {
      const records = await originalFetchHeaders(uids);
      return records.map((record) =>
        record.uid === 1 ? { ...record, sizeBytes: MAX_MESSAGE_BYTES + 1 } : record,
      );
    };

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, folder);

    const db = createDatabase(pool);
    const rows = await db
      .select({ id: messages.id, subject: messages.subject, sizeBytes: messages.sizeBytes, fetchedBody: messages.fetchedBody })
      .from(messages)
      .where(eq(messages.accountId, accountId))
      .orderBy(messages.subject);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sizeBytes: MAX_MESSAGE_BYTES + 1, fetchedBody: false });

    // The decision is on the audit trail exactly once, with the bound named.
    const skipped = await eventsOf("message.body_skipped", rows[0]!.id);
    expect(skipped).toEqual([{ accountId, folderId: folder.id, uid: 1, sizeBytes: MAX_MESSAGE_BYTES + 1, maxBytes: MAX_MESSAGE_BYTES }]);

    // Only the message inside the bound stays a body job.
    expect(await bodies.pendingBodyCount(accountId)).toBe(1);
    expect((await bodies.pendingBodies(accountId, 10)).map((job) => job.uid)).toEqual([2]);
  });

  it("skips a body whose server size drifted past the bound", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Drifts large")]);

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, folder);
    const job = (await bodies.pendingBodies(accountId, 10))[0]!;

    // The stored size was inside the bound; the download now reports more.
    let discarded = false;
    const originalStreamOriginal = session.streamOriginal.bind(session);
    session.streamOriginal = async (uid: number) => {
      const download = await originalStreamOriginal(uid);
      return download === null
        ? null
        : {
            ...download,
            expectedSize: MAX_MESSAGE_BYTES + 1,
            discard: () => {
              discarded = true;
            },
          };
    };

    const outcome = await bodies.fetchBody(session, accountId, job);
    expect(outcome).toMatchObject({ state: "skipped_oversized", sizeBytes: MAX_MESSAGE_BYTES + 1 });
    // The oversized download was stopped without draining it.
    expect(discarded).toBe(true);

    // The observed size moved onto the row, so the job stops qualifying, and
    // the skip is on the audit trail.
    const db = createDatabase(pool);
    const [row] = await db
      .select({ id: messages.id, sizeBytes: messages.sizeBytes, fetchedBody: messages.fetchedBody })
      .from(messages)
      .where(eq(messages.accountId, accountId));
    expect(row).toMatchObject({ sizeBytes: MAX_MESSAGE_BYTES + 1, fetchedBody: false });
    expect(await eventsOf("message.body_skipped", row!.id)).toEqual([
      { accountId, sizeBytes: MAX_MESSAGE_BYTES + 1, maxBytes: MAX_MESSAGE_BYTES },
    ]);
    expect(await bodies.pendingBodyCount(accountId)).toBe(0);
    // Nothing was stored for the skipped original.
    expect(row!.id).toBeDefined();
    await expect(storage.durable.stat(originalMessageKey(row!.id))).resolves.toBeNull();
  });

  it("marks absent occurrences expunged while keeping the message and its original", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Keep me"), fixture(2, "Server drops me")]);

    const { backfill, bodies, steady } = services();
    await drain(backfill, session, accountId, folder);
    for (const job of await bodies.pendingBodies(accountId, 10)) {
      await bodies.fetchBody(session, accountId, job);
    }
    const stored = await createDatabase(pool)
      .select({ id: messages.id, key: messages.originalStorageKey, sha: messages.originalSha256 })
      .from(messages)
      .where(eq(messages.accountId, accountId));
    expect(stored).toHaveLength(2);

    // The server expunges UID 2 before the next poll.
    session.load("INBOX", [fixture(1, "Keep me")]);
    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "polled", expunged: 1, flagsObserved: 1 });

    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows.map((row) => [row.uid, row.expungedAt !== null, row.invalidatedAt !== null])).toEqual([
      [1, false, false],
      [2, true, false],
    ]);

    // Originals are the record: the message and its bytes survive the expunge.
    expect(await countMessages(accountId)).toBe(2);
    for (const message of stored) {
      expect(await storage.durable.verify(message.key!, message.sha!)).toBe(true);
    }
  });

  it("refreshes changed flags with revision bumps and leaves stable rows alone", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Flag one", []), fixture(2, "Flag two", ["\\Seen"]), fixture(3, "Flag three", [])]);

    const { backfill, steady } = services();
    await drain(backfill, session, accountId, folder);

    // UID 1 becomes read, UID 2 becomes starred; UID 3 does not move.
    session.load("INBOX", [
      fixture(1, "Flag one", ["\\Seen"]),
      fixture(2, "Flag two", ["\\Seen", "\\Flagged"]),
      fixture(3, "Flag three", []),
    ]);
    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "polled", flagsObserved: 3, flagsChanged: 2 });

    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows.map((row) => [row.uid, row.unread, row.flagged, row.revision])).toEqual([
      [1, false, false, 2],
      [2, false, true, 2],
      [3, true, false, 1],
    ]);

    // A second poll with the same server state changes nothing: a stable
    // occurrence keeps its revision, so queued action targets stay fresh.
    const repeat = await steady.pollFolder(session, accountId, folder.id);
    expect(repeat).toMatchObject({ flagsChanged: 0 });
    const after = await occurrenceRows(accountId, folder.id);
    expect(after.map((row) => row.revision)).toEqual([2, 2, 1]);
  });

  it("refuses to poll against another folder generation and applies nothing", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Before reset"), fixture(2, "Also before")]);

    const { backfill, steady } = services();
    await drain(backfill, session, accountId, folder);

    // The server rebuilt the folder: a new generation and a reused UID space.
    session.uidValidity = 7;
    session.load("INBOX", [fixture(1, "Rebuilt mailbox")]);
    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "generation_changed", recorded: 1, observed: 7 });

    expect(await countMessages(accountId)).toBe(2);
    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.expungedAt === null && row.invalidatedAt === null)).toBe(true);
    expect((await folderRow(folder.id)).arrivalScannedUid).toBe(2);
    expect(await eventsOf(FOLDER_POLLED_EVENT, folder.id)).toEqual([]);
  });

  it("resets a changed generation: occurrences invalidated, checkpoints cleared, originals kept", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Old generation one"), fixture(2, "Old generation two")]);

    const { backfill, bodies, steady, reconcile, db } = services();
    await drain(backfill, session, accountId, folder);
    for (const job of await bodies.pendingBodies(accountId, 10)) {
      await bodies.fetchBody(session, accountId, job);
    }
    const originals = await db
      .select({ key: messages.originalStorageKey, sha: messages.originalSha256 })
      .from(messages)
      .where(eq(messages.accountId, accountId));
    expect(originals).toHaveLength(2);

    await steady.pollFolder(session, accountId, folder.id); // stamps the poll marker
    session.uidValidity = 2;
    session.load("INBOX", [fixture(1, "New generation one"), fixture(4, "New generation four")]);

    const reset = await reconcile.resetFolderGeneration(accountId, folder.id, 1, 2);
    expect(reset).toMatchObject({ state: "reset", recorded: 1, observed: 2, invalidated: 2 });
    expect(await folderRow(folder.id)).toMatchObject({
      uidvalidity: 2,
      backfillUpperUid: null,
      backfillBeforeUid: null,
      backfillComplete: false,
      arrivalScannedUid: 0,
    });

    // Stored originals survive the reset (SPEC F2 reconciliation).
    expect(await countMessages(accountId)).toBe(2);
    for (const original of originals) {
      expect(await storage.durable.verify(original.key!, original.sha!)).toBe(true);
    }

    // Backfill walks the new generation; old occurrences stay retained but invalid.
    await drain(backfill, session, accountId, folder);
    expect(await countMessages(accountId)).toBe(4);
    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows.map((row) => [row.uidvalidity, row.uid, row.invalidatedAt !== null])).toEqual([
      [1, 1, true],
      [1, 2, true],
      [2, 1, false],
      [2, 4, false],
    ]);
    const resetEvents = await eventsOf("sync.folder_generation_reset", folder.id);
    expect(resetEvents).toHaveLength(1);
    expect(resetEvents[0]).toMatchObject({ recorded: 1, observed: 2, invalidated: 2 });

    // A repeated reset for the same observed generation is a no-op.
    const again = await reconcile.resetFolderGeneration(accountId, folder.id, 1, 2);
    expect(again).toMatchObject({ state: "already_current", uidvalidity: 2 });
  });

  it("refuses a reset another cycle's commit already overtook", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Overtake old one"), fixture(2, "Overtake old two")]);

    const { backfill, reconcile } = services();
    await drain(backfill, session, accountId, folder);

    // One cycle applies the change it observed: generation 1 becomes 2.
    const applied = await reconcile.resetFolderGeneration(accountId, folder.id, 1, 2);
    expect(applied).toMatchObject({ state: "reset", recorded: 1, observed: 2, invalidated: 2 });

    // An overlapping cycle still holds the older observation 1 -> 3. The
    // folder holds neither its recorded 1 nor its observed 3, so the reset
    // must not rewind the generation the first cycle committed.
    const stale = await reconcile.resetFolderGeneration(accountId, folder.id, 1, 3);
    expect(stale).toMatchObject({ state: "superseded", uidvalidity: 2 });
    expect((await folderRow(folder.id)).uidvalidity).toBe(2);
    expect(await eventsOf("sync.folder_generation_reset", folder.id)).toHaveLength(1);
  });

  it("keeps a competing cycle's reset when its generation overtook the poll", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Overtake old one"), fixture(2, "Overtake old two")]);

    const mine = services();
    await drain(mine.backfill, session, accountId, folder);

    // The server moves to generation 2 before this cycle polls.
    session.uidValidity = 2;
    session.load("INBOX", [fixture(1, "Overtake mid one"), fixture(2, "Overtake mid two")]);

    // During the poll's selection the server moves again, to generation 3,
    // and a fresher cycle resets the folder and backfills generation 3.
    const theirs = services();
    const fresher = new FakeMailboxSession();
    fresher.uidValidity = 3;
    fresher.load("INBOX", [fixture(1, "Overtake new one"), fixture(2, "Overtake new two")]);
    const originalSelect = session.select.bind(session);
    let armed = true;
    session.select = async (name: string) => {
      const state = await originalSelect(name);
      if (armed) {
        armed = false;
        session.uidValidity = 3;
        session.load("INBOX", [fixture(1, "Overtake new one"), fixture(2, "Overtake new two")]);
        await theirs.reconcile.resetFolderGeneration(accountId, folder.id, 1, 3);
        await drain(theirs.backfill, fresher, accountId, folder);
      }
      return state;
    };

    const runner = new SyncRunner(
      createDatabase(pool),
      mine.backfill,
      mine.bodies,
      new ThreadService(createDatabase(pool)),
      mine.steady,
      mine.reconcile,
    );
    const summary = await runner.runAccountCycle(session, accountId);

    // The poll's observation (1 -> 2) was overtaken: no reset rewound the
    // folder, and the generation the fresher cycle committed stays usable.
    expect(summary).toMatchObject({ generationChanges: 1, resets: 0, bodiesFetched: 2, folderErrors: 0 });
    expect((await folderRow(folder.id)).uidvalidity).toBe(3);
    expect(await eventsOf("sync.folder_generation_reset", folder.id)).toHaveLength(1);
    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows.map((row) => [row.uidvalidity, row.uid, row.invalidatedAt !== null, row.expungedAt !== null])).toEqual([
      [1, 1, true, false],
      [1, 2, true, false],
      [3, 1, false, false],
      [3, 2, false, false],
    ]);
    expect(await eventsOf("sync.status", accountId)).toHaveLength(1);
  });

  it("reports the committed generation when a poll's commit finds the folder moved", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    const one = fixture(1, "Moved commit one");
    const two = fixture(2, "Moved commit two");
    session.load("INBOX", [one, two]);

    const { backfill, steady } = services();
    await drain(backfill, session, accountId, folder);

    // An arrival is due, and a competing cycle resets the folder to
    // generation 2 after this poll fetched the arrival.
    session.load("INBOX", [one, two, fixture(3, "Moved commit three")]);
    const { reconcile: competing } = services();
    const originalRevalidate = session.revalidate.bind(session);
    let armed = true;
    session.revalidate = async () => {
      const state = await originalRevalidate();
      if (armed) {
        armed = false;
        await competing.resetFolderGeneration(accountId, folder.id, 1, 2);
      }
      return state;
    };

    // The poll discards its rows and names the committed generation as the
    // observed one, so the guarded reset recognizes the folder as current.
    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "generation_changed", recorded: 1, observed: 2 });
    expect((await folderRow(folder.id)).uidvalidity).toBe(2);
    expect(await countMessages(accountId)).toBe(2);
    expect(await eventsOf(FOLDER_POLLED_EVENT, folder.id)).toEqual([]);
  });

  it("never judges an arrival above the expunge snapshot bound", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    const one = fixture(1, "Bound one");
    const two = fixture(2, "Bound two");
    session.load("INBOX", [one, two]);

    const { backfill, steady, db } = services();
    await drain(backfill, session, accountId, folder);

    // A concurrent cycle imports an arrival that lands after this poll's
    // snapshot bound; the search window stops below it.
    const originalSearch = session.searchUids.bind(session);
    let armed = true;
    session.searchUids = async (low: number, high: number) => {
      if (armed && low === 1) {
        armed = false;
        const three = fixture(3, "Bound three");
        session.load("INBOX", [one, two, three]);
        const [row] = await db.insert(messages).values({ accountId }).returning({ id: messages.id });
        await db.insert(messageOccurrences).values({
          accountId,
          messageId: row!.id,
          folderId: folder.id,
          uidvalidity: 1,
          uid: 3,
          internalDate: new Date(Date.UTC(2026, 8, 7, 11, 0, 0)),
        });
      }
      return originalSearch(low, high);
    };

    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "polled", expunged: 0 });

    // The concurrent arrival stays active; only a snapshot that covers its
    // UID may judge it.
    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows.map((row) => [row.uid, row.expungedAt !== null])).toEqual([
      [1, false],
      [2, false],
      [3, false],
    ]);

    // The next poll covers UID 3 through its own bound and keeps it.
    const repeat = await steady.pollFolder(session, accountId, folder.id);
    expect(repeat).toMatchObject({ state: "polled", expunged: 0, flagsObserved: 3 });
  });

  it("contains a failed folder and a stale body job without losing the cycle", async () => {
    const { accountId, folderIds } = await setupAccount([
      { name: "INBOX", role: "inbox" },
      { name: "Vanished" },
    ]);
    const inbox = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Contained one"), fixture(2, "Contained two")]);
    // No mailbox named Vanished exists: its select fails inside the cycle.

    const { backfill, bodies, steady, reconcile, db } = services();
    await drain(backfill, session, accountId, inbox);
    const moved = (await occurrenceRows(accountId, inbox.id))[0]!;

    // The first body fetch moves the second job's message: its occurrence is
    // expunged by the time the runner loads the stale job.
    const originalStreamOriginal = session.streamOriginal.bind(session);
    let armed = true;
    session.streamOriginal = async (uid: number) => {
      if (armed) {
        armed = false;
        await db
          .update(messageOccurrences)
          .set({ expungedAt: new Date() })
          .where(eq(messageOccurrences.id, moved.id));
      }
      return originalStreamOriginal(uid);
    };

    const runner = new SyncRunner(
      createDatabase(pool),
      backfill,
      bodies,
      new ThreadService(createDatabase(pool)),
      steady,
      reconcile,
    );
    const summary = await runner.runAccountCycle(session, accountId);

    // Both failures were contained; the cycle still fetched the healthy body,
    // reconciled threads, and emitted its status event.
    expect(summary).toMatchObject({ folderErrors: 1, bodyErrors: 1, bodiesFetched: 1 });
    expect(await eventsOf("sync.status", accountId)).toHaveLength(1);
    expect(await countMessages(accountId)).toBe(2);
  });

  it("polls the Inbox every minute and other folders every quarter hour", async () => {
    const { accountId, folderIds } = await setupAccount([
      { name: "INBOX", role: "inbox" },
      { name: "Archive" },
    ]);
    const inbox = folderIds.get("INBOX")!;
    const archive = folderIds.get("Archive")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Cadence inbox")]);
    session.load("Archive", [fixture(1, "Cadence archive")]);

    const { backfill, steady } = services();
    await drain(backfill, session, accountId, inbox);
    await drain(backfill, session, accountId, archive);
    await steady.pollFolder(session, accountId, inbox.id);
    await steady.pollFolder(session, accountId, archive.id);
    const polledAt = new Date();

    // A folder inside its interval is not due; the Inbox interval is shorter.
    expect(await steady.pollDue(inbox, polledAt)).toBe(false);
    expect(await steady.pollDue(archive, polledAt)).toBe(false);

    const minute = INBOX_POLL_INTERVAL_MS;
    const quarterHour = OTHER_FOLDER_POLL_INTERVAL_MS;
    expect(await steady.pollDue(inbox, new Date(polledAt.getTime() + minute - 1000))).toBe(false);
    expect(await steady.pollDue(inbox, new Date(polledAt.getTime() + minute + 1000))).toBe(true);
    expect(await steady.pollDue(archive, new Date(polledAt.getTime() + minute + 1000))).toBe(false);
    expect(await steady.pollDue(archive, new Date(polledAt.getTime() + quarterHour + 1000))).toBe(true);
  });

  it("repairs a missed import and marks expunges in the nightly inventory", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      fixture(1, "Inventory one"),
      fixture(2, "Inventory lost locally"),
      fixture(3, "Inventory dropped remotely"),
    ]);

    const { backfill, reconcile } = services();
    await drain(backfill, session, accountId, folder);

    // UID 2 was lost from the database; UID 3 was expunged on the server.
    await pool.query(
      `delete from message_occurrences where account_id = $1 and folder_id = $2 and uid = 2`,
      [accountId, folder.id],
    );
    await pool.query(
      `delete from messages where account_id = $1 and subject = 'Inventory lost locally'`,
      [accountId],
    );
    session.load("INBOX", [fixture(1, "Inventory one"), fixture(2, "Inventory lost locally")]);

    expect(await reconcile.inventoryDue(folder.id)).toBe(true);
    const inventory = await reconcile.inventoryFolder(session, accountId, folder.id);
    expect(inventory).toMatchObject({
      state: "inventoried",
      present: 2,
      active: 2,
      expunged: 1,
      repaired: 1,
      pendingRepairs: 0,
    });

    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows.map((row) => [row.uid, row.expungedAt !== null])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(await countMessages(accountId)).toBe(3);
    const inventoried = await eventsOf(FOLDER_INVENTORY_EVENT, folder.id);
    expect(inventoried).toHaveLength(1);
    expect(inventoried[0]).toMatchObject({ expunged: 1, repaired: 1 });

    // The nightly interval gates a repeat.
    const inventoriedAt = new Date();
    expect(await reconcile.inventoryDue(folder.id, inventoriedAt)).toBe(false);
    expect(
      await reconcile.inventoryDue(folder.id, new Date(inventoriedAt.getTime() + 24 * 60 * 60_000 + 1000)),
    ).toBe(true);
  });

  it("leaves unscanned history to backfill during an inventory", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load(
      "INBOX",
      Array.from({ length: 4 }, (_, index) => fixture(index + 1, `Partial ${index + 1}`)),
    );

    // One window of two imports; UID 1 and 2 are still unscanned history.
    const { backfill, reconcile } = services(2);
    await backfill.runBatch(session, accountId, folder.id);
    await backfill.runBatch(session, accountId, folder.id);

    const inventory = await reconcile.inventoryFolder(session, accountId, folder.id);
    expect(inventory).toMatchObject({ state: "inventoried", repaired: 0, pendingRepairs: 0, expunged: 0 });
    expect((await occurrenceRows(accountId, folder.id)).map((row) => row.uid)).toEqual([3, 4]);
  });

  it("runs due polls and inventories in one cycle, then skips fresh folders", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Runner one"), fixture(2, "Runner two")]);

    const { backfill, bodies, steady, reconcile } = services();
    const runner = new SyncRunner(createDatabase(pool), backfill, bodies, new ThreadService(createDatabase(pool)), steady, reconcile);
    const first = await runner.runAccountCycle(session, accountId);
    expect(first).toMatchObject({
      folders: 1,
      imported: 2,
      bodiesFetched: 2,
      polled: 1,
      arrivalsImported: 0,
      inventories: 1,
      generationChanges: 0,
      resets: 0,
    });
    expect(await eventsOf(FOLDER_POLLED_EVENT, folder.id)).toHaveLength(1);
    expect(await eventsOf(FOLDER_INVENTORY_EVENT, folder.id)).toHaveLength(1);
    expect(await eventsOf("sync.status", accountId)).toHaveLength(1);

    // A settled folder inside its intervals costs no remote poll work.
    const second = await runner.runAccountCycle(session, accountId);
    expect(second).toMatchObject({ folders: 0, batches: 0, imported: 0, bodiesFetched: 0, polled: 0 });
    expect(await eventsOf(FOLDER_POLLED_EVENT, folder.id)).toHaveLength(1);
    expect(await eventsOf(FOLDER_INVENTORY_EVENT, folder.id)).toHaveLength(1);
    expect(await eventsOf("sync.status", accountId)).toHaveLength(2);
  });

  it("records pending body counts separately from header progress in sync status", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      fixture(1, "Status one"),
      fixture(2, "Status two"),
      fixture(3, "Status three"),
    ]);

    const { backfill, bodies, steady, reconcile } = services();
    // One body per cycle leaves two messages waiting for their bodies.
    const runner = new SyncRunner(createDatabase(pool), backfill, bodies, new ThreadService(createDatabase(pool)), steady, reconcile, {
      bodiesPerCycle: 1,
    });
    await runner.runAccountCycle(session, accountId);

    const status = (await eventsOf("sync.status", accountId))[0]!;
    expect(status).toMatchObject({
      bodiesFetched: 1,
      backfillPendingFolders: 0,
      pendingBodies: 2,
      polled: 1,
    });
    expect((await folderRow(folder.id)).backfillComplete).toBe(true);

    // While a folder still owes history, header progress reports it and the
    // poll still runs for arrivals (SPEC F2: progress is independent).
    const { backfill: slowBackfill, bodies: slowBodies, steady: slowSteady, reconcile: slowReconcile } =
      services(2);
    const { accountId: slowAccountId } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const slowSession = new FakeMailboxSession();
    slowSession.load(
      "INBOX",
      Array.from({ length: 4 }, (_, index) => fixture(index + 1, `Slow ${index + 1}`)),
    );
    // Two batches of two windows import half the folder; one body per cycle
    // leaves the rest of the imported half waiting for their bodies.
    const slowRunner = new SyncRunner(createDatabase(pool), slowBackfill, slowBodies, new ThreadService(createDatabase(pool)), slowSteady, slowReconcile, {
      batchesPerFolder: 2,
      bodiesPerCycle: 1,
    });
    await slowRunner.runAccountCycle(slowSession, slowAccountId);
    const slowStatus = (await eventsOf("sync.status", slowAccountId))[0]!;
    expect(slowStatus).toMatchObject({
      backfillPendingFolders: 1,
      pendingBodies: 1,
      bodiesFetched: 1,
      polled: 1,
    });
  });

  it("resets and re-backfills a changed generation inside one runner cycle", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Cycle old one"), fixture(2, "Cycle old two")]);

    const { backfill, steady, reconcile } = services(2);
    // Import the first generation completely, then the server rebuilds the
    // folder before the next cycle.
    await drain(backfill, session, accountId, folder);
    session.uidValidity = 3;
    session.load("INBOX", [fixture(1, "Cycle new one"), fixture(2, "Cycle new two")]);

    const { bodies } = services();
    const runner = new SyncRunner(createDatabase(pool), backfill, bodies, new ThreadService(createDatabase(pool)), steady, reconcile);
    const summary = await runner.runAccountCycle(session, accountId);
    expect(summary).toMatchObject({
      generationChanges: 1,
      resets: 1,
      imported: 2,
    });
    expect((await folderRow(folder.id)).backfillComplete).toBe(true);

    const rows = await occurrenceRows(accountId, folder.id);
    expect(rows.map((row) => [row.uidvalidity, row.uid, row.invalidatedAt !== null])).toEqual([
      [1, 1, true],
      [1, 2, true],
      [3, 1, false],
      [3, 2, false],
    ]);
    // Both generations keep their message rows and originals stay stored.
    expect(await countMessages(accountId)).toBe(4);
    expect(await eventsOf("sync.folder_generation_reset", folder.id)).toHaveLength(1);
    const status = (await eventsOf("sync.status", accountId))[0]!;
    expect(status).toMatchObject({ resets: 1, generationChanges: 1 });
  });

  it("serves due-ness queries from a covering index that sorts by at", async () => {
    const index = await pool.query(
      "select indexdef from pg_indexes where tablename = 'events' and indexname = 'events_type_entity_id_at_idx'",
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0].indexdef).toMatch(/using btree \(type, entity_id, at desc\)/i);
    // The index it replaced covered the same lookups without the sort.
    const old = await pool.query(
      "select count(*)::int as count from pg_indexes where tablename = 'events' and indexname = 'events_type_entity_id_idx'",
    );
    expect(old.rows[0].count).toBe(0);
  });

  it("skips a body whose stream itself crosses the size bound", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Grows mid stream")]);

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, folder);
    const job = (await bodies.pendingBodies(accountId, 10))[0]!;

    // The server reports no size; the bytes themselves cross the bound.
    const crossing = Buffer.alloc(MAX_MESSAGE_BYTES + 2048, 0x2e);
    let discarded = false;
    session.streamOriginal = async () => ({
      expectedSize: null,
      chunks: (async function* () {
        yield crossing;
      })(),
      discard: () => {
        discarded = true;
      },
    });

    const outcome = await bodies.fetchBody(session, accountId, job);
    expect(outcome).toMatchObject({ state: "skipped_oversized", sizeBytes: MAX_MESSAGE_BYTES + 2048 });
    expect(discarded).toBe(true);

    const db = createDatabase(pool);
    const [row] = await db
      .select({ id: messages.id, sizeBytes: messages.sizeBytes })
      .from(messages)
      .where(eq(messages.accountId, accountId));
    expect(row).toMatchObject({ sizeBytes: MAX_MESSAGE_BYTES + 2048 });
    expect(await eventsOf("message.body_skipped", row!.id)).toEqual([
      { accountId, sizeBytes: MAX_MESSAGE_BYTES + 2048, maxBytes: MAX_MESSAGE_BYTES },
    ]);
    expect(await bodies.pendingBodyCount(accountId)).toBe(0);
    await expect(storage.durable.stat(originalMessageKey(row!.id))).resolves.toBeNull();
  });

  it("records a bounded failure for a body that will not parse", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Will not parse")]);

    const { backfill } = services();
    await drain(backfill, session, accountId, folder);
    const db = createDatabase(pool);
    // Ingestion always fails at the parse step: the failure is deterministic.
    const bodies = new BodyFetchService(db, {
      stageOriginal: async (input) => ({
        messageId: input.messageId,
        storageKey: "unreferenced",
        sha256: "0".repeat(64),
        sizeBytes: 1,
      }),
      applyStagedOriginal: async () => {
        throw new IngestionError("parse_failed", "The stored original will not parse.");
      },
    });
    const jobs = await bodies.pendingBodies(accountId, 10);
    expect(jobs).toHaveLength(1);

    const outcome = await bodies.fetchBody(session, accountId, jobs[0]!);
    expect(outcome).toMatchObject({ state: "failed" });

    const [row] = await db
      .select({ id: messages.id, bodyFailedAt: messages.bodyFailedAt, fetchedBody: messages.fetchedBody })
      .from(messages)
      .where(eq(messages.accountId, accountId));
    expect(row!.bodyFailedAt).not.toBeNull();
    expect(row!.fetchedBody).toBe(false);
    // The event names the failure kind alone; parser text stays out of the trail.
    expect(await eventsOf("message.body_failed", row!.id)).toEqual([
      { accountId, reason: "parse_failed" },
    ]);
    // A decided failure is not a job anymore: the row stops qualifying.
    expect(await bodies.pendingBodyCount(accountId)).toBe(0);
  });

  it("does not refresh flags onto an occurrence marked expunged mid-poll", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [fixture(1, "Guard one"), fixture(2, "Guard two")]);

    const { backfill, steady, db } = services();
    await drain(backfill, session, accountId, folder);

    // The server marks UID 2 read while the expunge pass removes it between
    // the page read and the flag commit.
    session.load("INBOX", [fixture(1, "Guard one"), fixture(2, "Guard two", ["\\Seen"])]);
    const originalFetchFlags = session.fetchFlags.bind(session);
    session.fetchFlags = async (uids: number[]) => {
      await db
        .update(messageOccurrences)
        .set({ expungedAt: new Date() })
        .where(
          and(
            eq(messageOccurrences.accountId, accountId),
            eq(messageOccurrences.folderId, folder.id),
            eq(messageOccurrences.uid, 2),
          ),
        );
      return originalFetchFlags(uids);
    };

    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "polled", flagsObserved: 2, flagsChanged: 0 });

    // The expunged row keeps the flags and revision it already had.
    const guarded = (await occurrenceRows(accountId, folder.id)).find((row) => row.uid === 2)!;
    expect(guarded.expungedAt).not.toBeNull();
    expect([guarded.unread, guarded.flagged, guarded.revision]).toEqual([true, false, 1]);
  });

  it("marks a whole folder's expunges without crossing the statement parameter bound", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;

    // Seed history directly: 65,536 occurrences, one above PostgreSQL's
    // 65,535-parameter statement limit, against a server that holds none.
    // The occurrence rows go in page-sized slices: one giant statement queues
    // three referential checks per row in one after-trigger batch, which this
    // deployment's database grinds through far too slowly.
    await pool.query(
      "insert into messages (account_id, subject) select $1, 'bulk' from generate_series(1, 65536) g",
      [accountId],
    );
    for (let offset = 0; offset < 65_536; offset += 8_192) {
      await pool.query(
        `
        insert into message_occurrences (account_id, message_id, folder_id, uidvalidity, uid, internal_date)
        select account_id, id, $2, 1, $3 + row_number() over (order by id), now()
        from (
          select id, account_id from messages
          where account_id = $1 and subject = 'bulk'
          order by id offset $4 limit 8192
        ) page
        `,
        [accountId, folder.id, offset, offset],
      );
    }
    await pool.query(
      `
      update folders set uidvalidity = 1, backfill_upper_uid = 65536,
        backfill_before_uid = 65537, backfill_complete = true, arrival_scanned_uid = 65536
      where id = $1
      `,
      [folder.id],
    );

    const session = new FakeMailboxSession();
    session.load("INBOX", []);
    session.uidNext = 65_537;

    const { steady } = services();
    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "polled", expunged: 65_536 });

    const marked = await pool.query(
      "select count(*)::int as count from message_occurrences where folder_id = $1 and expunged_at is not null",
      [folder.id],
    );
    expect(marked.rows[0].count).toBe(65_536);
  }, 120_000);

  it("logs the reason a contained folder failure was contained", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    // No mailbox is loaded, so the folder's select fails inside the cycle.
    const session = new FakeMailboxSession();

    const warns: string[] = [];
    const { db, backfill, bodies, steady, reconcile } = services();
    const runner = new SyncRunner(db, backfill, bodies, new ThreadService(db), steady, reconcile, {
      logger: { warn: (message) => { warns.push(message); } },
    });
    const summary = await runner.runAccountCycle(session, accountId);

    // The failure was contained and the cycle still closed.
    expect(summary.folderErrors).toBe(1);
    expect(await eventsOf("sync.status", accountId)).toHaveLength(1);
    // The diagnostic names the folder without credentials or content.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(folder.name);
    expect(warns[0]).toContain(folder.id);
    expect(warns[0]).toContain("contained");
  });
});
