import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  createStorage,
  folders,
  messages,
  runMigrations,
  threads as threadsTable,
  type Folder,
  type Message,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import { IngestionService } from "@mail-hub/ingestion";
import {
  BackfillService,
  BodyFetchService,
  ReconciliationService,
  SteadyStateService,
  SyncError,
  SyncRunner,
  ThreadService,
  type BackfillBatchOutcome,
} from "../src/index.ts";
import { FakeMailboxSession, type FakeMessage } from "./fake-mailbox.ts";

/**
 * Threading acceptance against a real PostgreSQL and the filesystem store
 * (SPEC F2 and section 12). Set `TEST_DATABASE_URL` to a connection string
 * whose user may create databases; a throwaway database is created per run.
 * Without the variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

/** The identity fields one threaded fixture needs. */
interface ThreadSpec {
  uid: number;
  /** Bare `Message-ID` local part; stored as `<id@example.com>`. */
  id: string;
  /** Bare identifiers this message replies to; several mean a conflicted reply. */
  inReplyTo?: string[];
  /** Bare identifiers, oldest first. */
  references?: string[];
  subject?: string;
  body?: string;
}

/** One fixture with explicit identity headers. */
function mail(spec: ThreadSpec): FakeMessage {
  const lines = [
    "From: Alice Sender <alice@example.com>",
    "To: Bob <bob@example.com>",
    `Subject: ${spec.subject ?? `Conversation ${spec.id}`}`,
    "Date: Mon, 07 Sep 2026 10:15:00 +0000",
    `Message-ID: <${spec.id}@example.com>`,
  ];
  if (spec.inReplyTo !== undefined && spec.inReplyTo.length > 0) {
    lines.push(`In-Reply-To: ${spec.inReplyTo.map((id) => `<${id}@example.com>`).join(" ")}`);
  }
  if (spec.references !== undefined) {
    lines.push(`References: ${spec.references.map((id) => `<${id}@example.com>`).join(" ")}`);
  }
  return {
    uid: spec.uid,
    headers: lines.join("\r\n"),
    body: spec.body ?? `Body of ${spec.id}.`,
    flags: [],
    internalDate: new Date(Date.UTC(2026, 8, 7, 10, 0, 0) + spec.uid * 60_000),
  };
}

/** The stored identifier text of a bare fixture id. */
function stored(id: string): string {
  return `<${id}@example.com>`;
}

suite("ThreadService", () => {
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

    root = await mkdtemp(join(tmpdir(), "mail-hub-threads-"));
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

  function services() {
    const db = createDatabase(pool);
    const ingestion = new IngestionService(db, storage);
    return {
      db,
      ingestion,
      backfill: new BackfillService(db),
      bodies: new BodyFetchService(db, ingestion),
      threads: new ThreadService(db),
      steady: new SteadyStateService(db),
      reconcile: new ReconciliationService(db),
    };
  }

  /** Run backfill batches until one reports complete. */
  async function drain(
    backfill: BackfillService,
    session: FakeMailboxSession,
    accountId: string,
    folder: Folder,
    maxBatches = 100,
  ): Promise<void> {
    for (let i = 0; i < maxBatches; i += 1) {
      const outcome: BackfillBatchOutcome = await backfill.runBatch(session, accountId, folder.id);
      if (
        outcome.state === "complete" ||
        outcome.state === "generation_changed" ||
        ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete)
      ) {
        return;
      }
    }
  }

  /** Resolve body jobs until none remain. */
  async function drainBodies(
    bodies: BodyFetchService,
    session: FakeMailboxSession,
    accountId: string,
    maxJobs = 100,
  ): Promise<void> {
    for (let i = 0; i < maxJobs; i += 1) {
      const jobs = await bodies.pendingBodies(accountId, 10);
      if (jobs.length === 0) {
        return;
      }
      for (const job of jobs) {
        await bodies.fetchBody(session, accountId, job);
      }
    }
  }

  /** The account's messages. Several rows may share one identifier (SPEC F2). */
  async function accountMessages(accountId: string): Promise<Message[]> {
    const db = createDatabase(pool);
    return db.select().from(messages).where(eq(messages.accountId, accountId));
  }

  /** The first message that holds one stored identifier. */
  function holding(rows: Message[], id: string): Message {
    return rows.find((row) => row.messageId === stored(id))!;
  }

  async function threadRow(threadId: string) {
    const rows = await pool.query("select * from threads where id = $1", [threadId]);
    return rows.rows[0];
  }

  async function eventCount(accountId: string, type: string): Promise<number> {
    const rows = await pool.query("select count(*)::int as count from events where entity_id = $1 and type = $2", [
      accountId,
      type,
    ]);
    return rows.rows[0].count;
  }

  it("converges a reply chain the backfill imported newest first", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({ uid: 1, id: "one", subject: "Quarterly report" }),
      mail({ uid: 2, id: "two", inReplyTo: ["one"], references: ["one"] }),
      mail({ uid: 3, id: "three", inReplyTo: ["two"], references: ["one", "two"] }),
    ]);

    const { backfill, bodies, threads } = services();
    await drain(backfill, session, accountId, folder);
    await drainBodies(bodies, session, accountId);
    const summary = await threads.reconcileAccount(accountId);

    const rows = await accountMessages(accountId);
    const one = holding(rows, "one");
    const two = holding(rows, "two");
    const three = holding(rows, "three");
    expect(one).toMatchObject({ threadLinkState: "root", parentMessageId: null });
    expect(two).toMatchObject({ threadLinkState: "linked", parentMessageId: one.id });
    expect(three).toMatchObject({ threadLinkState: "linked", parentMessageId: two.id });
    expect(new Set([one.threadId, two.threadId, three.threadId]).size).toBe(1);

    const thread = await threadRow(one.threadId!);
    expect(thread.subject_norm).toBe("quarterly report");
    expect(thread.participants.map((p: { address: string }) => p.address)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);

    expect(summary).toMatchObject({ examined: 3, linked: 2, roots: 1, pending: 0, ambiguous: 0, remaining: 0 });
    expect(await threads.pendingCount(accountId)).toBe(0);
    expect(await eventCount(accountId, "sync.thread_reconciliation")).toBe(1);
  });

  it("keeps a missing parent pending and links it when the parent arrives", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({ uid: 1, id: "late-two", inReplyTo: ["late-one"], references: ["late-one"] }),
      mail({ uid: 2, id: "late-three", inReplyTo: ["late-two"], references: ["late-one", "late-two"] }),
    ]);

    const { backfill, bodies, threads, steady } = services();
    await drain(backfill, session, accountId, folder);
    await drainBodies(bodies, session, accountId);
    await threads.reconcileAccount(accountId);

    const rows = await accountMessages(accountId);
    const two = holding(rows, "late-two");
    const three = holding(rows, "late-three");
    expect(two).toMatchObject({ threadLinkState: "pending", parentMessageId: null });
    expect(three).toMatchObject({ threadLinkState: "linked", parentMessageId: two.id });
    expect(three.threadId).toBe(two.threadId);

    // The missing root arrives as a new message after backfill finished.
    session.load("INBOX", [
      mail({ uid: 1, id: "late-two", inReplyTo: ["late-one"], references: ["late-one"] }),
      mail({ uid: 2, id: "late-three", inReplyTo: ["late-two"], references: ["late-one", "late-two"] }),
      mail({ uid: 3, id: "late-one", subject: "Late arrival" }),
    ]);
    session.uidNext = 4;
    await steady.pollFolder(session, accountId, folder.id);
    await drainBodies(bodies, session, accountId);
    const summary = await threads.reconcileAccount(accountId);

    const after = await accountMessages(accountId);
    const one = holding(after, "late-one");
    const twoAfter = holding(after, "late-two");
    const threeAfter = holding(after, "late-three");
    expect(twoAfter).toMatchObject({ threadLinkState: "linked", parentMessageId: one.id });
    expect(threeAfter).toMatchObject({ threadLinkState: "linked", parentMessageId: twoAfter.id });
    expect(new Set([one.threadId, twoAfter.threadId, threeAfter.threadId]).size).toBe(1);
    expect(summary).toMatchObject({ examined: 3, pending: 0, remaining: 0 });
  });

  it("resolves duplicate holders by merging, then flags the link when a new holder claims the identifier", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX", "Archive"]);
    const inbox = folderIds.get("INBOX")!;
    const archive = folderIds.get("Archive")!;
    const shared = mail({ uid: 1, id: "shared", subject: "Shared bytes" });
    const reply = mail({ uid: 5, id: "reply", inReplyTo: ["shared"], references: ["shared"] });
    const session = new FakeMailboxSession();
    session.load("INBOX", [shared, reply]);
    session.load("Archive", [{ ...shared, uid: 1 }]);

    const { backfill, bodies, threads, steady } = services();
    await drain(backfill, session, accountId, inbox);
    await drain(backfill, session, accountId, archive);

    // Two rows hold the identifier, so the child cannot pick a parent yet.
    await threads.reconcileAccount(accountId);
    let rows = await accountMessages(accountId);
    expect(holding(rows, "reply")).toMatchObject({ threadLinkState: "ambiguous", parentMessageId: null });

    // The byte-identical copies merge once both bodies exist.
    await drainBodies(bodies, session, accountId);
    const summary = await threads.reconcileAccount(accountId);
    rows = await accountMessages(accountId);
    expect(rows).toHaveLength(2);
    const survivor = holding(rows, "shared");
    const linked = holding(rows, "reply");
    expect(linked).toMatchObject({ threadLinkState: "linked", parentMessageId: survivor.id });
    expect(linked.threadId).toBe(survivor.threadId);
    expect(summary).toMatchObject({ linked: 1, remaining: 0 });

    const occurrences = await pool.query(
      "select count(*)::int as count from message_occurrences where account_id = $1 and message_id = $2",
      [accountId, survivor.id],
    );
    expect(occurrences.rows[0].count).toBe(2);

    // A different message reuses the header identifier; the now-unsafe link
    // must come off and the child must return to its own thread.
    session.load("INBOX", [
      shared,
      reply,
      mail({ uid: 9, id: "shared", subject: "Stolen identifier", body: "Different bytes entirely." }),
    ]);
    session.uidNext = 10;
    await steady.pollFolder(session, accountId, inbox.id);
    await drainBodies(bodies, session, accountId);
    const after = await threads.reconcileAccount(accountId);

    rows = await accountMessages(accountId);
    expect(rows).toHaveLength(3);
    const claim = rows.find((row) => row.subject === "Stolen identifier")!;
    expect(claim.threadLinkState).toBe("root");
    const flagged = holding(rows, "reply");
    expect(flagged).toMatchObject({ threadLinkState: "ambiguous", parentMessageId: null });
    expect(flagged.threadId).not.toBe(survivor.threadId);
    expect(after.unlinked).toBe(1);
    expect(await threads.pendingCount(accountId)).toBe(0);
  });

  it("never links messages by subject or participants alone", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({ uid: 1, id: "lookalike-one", subject: "Lunch on Friday" }),
      mail({ uid: 2, id: "lookalike-two", subject: "Lunch on Friday" }),
    ]);

    const { backfill, bodies, threads } = services();
    await drain(backfill, session, accountId, folder);
    await drainBodies(bodies, session, accountId);
    await threads.reconcileAccount(accountId);

    const rows = await accountMessages(accountId);
    const one = holding(rows, "lookalike-one");
    const two = holding(rows, "lookalike-two");
    expect(one).toMatchObject({ threadLinkState: "root", parentMessageId: null });
    expect(two).toMatchObject({ threadLinkState: "root", parentMessageId: null });
    expect(one.threadId).not.toBe(two.threadId);
  });

  it("keeps conflicted, self, and cyclic references unlinked", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({ uid: 1, id: "fork-a", subject: "Fork" }),
      mail({ uid: 2, id: "fork-b", subject: "Fork" }),
      // Two parent identifiers: no safe choice exists.
      mail({ uid: 3, id: "conflicted", inReplyTo: ["fork-a", "fork-b"], references: ["fork-a", "fork-b"] }),
      // The message names itself.
      mail({ uid: 4, id: "self", inReplyTo: ["self"], references: ["self"] }),
      // Two messages that name each other.
      mail({ uid: 5, id: "cycle-a", inReplyTo: ["cycle-b"], references: ["cycle-b"] }),
      mail({ uid: 6, id: "cycle-b", inReplyTo: ["cycle-a"], references: ["cycle-a"] }),
    ]);

    const { backfill, bodies, threads } = services();
    await drain(backfill, session, accountId, folder);
    await drainBodies(bodies, session, accountId);
    const summary = await threads.reconcileAccount(accountId);

    const rows = await accountMessages(accountId);
    expect(holding(rows, "conflicted")).toMatchObject({ threadLinkState: "ambiguous", parentMessageId: null });
    expect(holding(rows, "self")).toMatchObject({ threadLinkState: "ambiguous", parentMessageId: null });

    // A cycle can hold at most one of its two links; the other stays flagged.
    const cycleStates = ["cycle-a", "cycle-b"].map((id) => holding(rows, id).threadLinkState).sort();
    expect(cycleStates).toEqual(["ambiguous", "linked"]);
    expect(summary.ambiguous).toBe(3);
    expect(await threads.pendingCount(accountId)).toBe(0);
  });

  it("never links across accounts", async () => {
    const { accountId: holderAccount, folderIds: holderFolders } = await setupAccount(["INBOX"]);
    const { accountId: childAccount, folderIds: childFolders } = await setupAccount(["INBOX"]);

    // One session per account.
    const holderSession = new FakeMailboxSession();
    holderSession.load("INBOX", [mail({ uid: 1, id: "cross-account", subject: "Only here" })]);
    const childSession = new FakeMailboxSession();
    childSession.load("INBOX", [
      mail({ uid: 1, id: "cross-child", inReplyTo: ["cross-account"], references: ["cross-account"] }),
    ]);

    const holder = services();
    await drain(holder.backfill, holderSession, holderAccount, holderFolders.get("INBOX")!);
    await drainBodies(holder.bodies, holderSession, holderAccount);
    await holder.threads.reconcileAccount(holderAccount);

    const child = services();
    await drain(child.backfill, childSession, childAccount, childFolders.get("INBOX")!);
    await drainBodies(child.bodies, childSession, childAccount);
    await child.threads.reconcileAccount(childAccount);

    const holderRows = await accountMessages(holderAccount);
    const holderMessage = holding(holderRows, "cross-account");
    const childRows = await accountMessages(childAccount);
    const childMessage = holding(childRows, "cross-child");
    expect(holderMessage).toMatchObject({ threadLinkState: "root", parentMessageId: null });
    expect(childMessage).toMatchObject({ threadLinkState: "pending", parentMessageId: null });
    expect(childMessage.threadId).not.toBe(holderMessage.threadId);
  });

  it("works in bounded passes and repeats without changing settled links", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load(
      "INBOX",
      Array.from({ length: 5 }, (_, index) => mail({ uid: index + 1, id: `loose-${index + 1}` })),
    );

    const { backfill, bodies, threads } = services();
    await drain(backfill, session, accountId, folder);
    await drainBodies(bodies, session, accountId);

    const bounded = await threads.reconcileAccount(accountId, 2);
    expect(bounded).toMatchObject({ examined: 2, remaining: 3 });

    const finished = await threads.reconcileAccount(accountId);
    expect(finished).toMatchObject({ examined: 3, roots: 3, remaining: 0 });

    const threadCount = await pool.query("select count(*)::int as count from threads where account_id = $1", [
      accountId,
    ]);
    const settled = await threads.reconcileAccount(accountId);
    expect(settled).toMatchObject({ examined: 0, linksChanged: 0, remaining: 0 });
    const threadCountAfter = await pool.query("select count(*)::int as count from threads where account_id = $1", [
      accountId,
    ]);
    expect(threadCountAfter.rows[0].count).toBe(threadCount.rows[0].count);
    expect(threadCountAfter.rows[0].count).toBe(5);
  });

  it("runs thread jobs as part of an account cycle and reports them", async () => {
    const { accountId } = await setupAccount(["INBOX"]);
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({ uid: 1, id: "cycle-one", subject: "Cycle report" }),
      mail({ uid: 2, id: "cycle-two", inReplyTo: ["cycle-one"], references: ["cycle-one"] }),
      mail({ uid: 3, id: "cycle-three", inReplyTo: ["cycle-two"], references: ["cycle-one", "cycle-two"] }),
    ]);

    const { backfill, bodies, threads, steady, reconcile } = services();
    const runner = new SyncRunner(createDatabase(pool), backfill, bodies, threads, steady, reconcile);
    const first = await runner.runAccountCycle(session, accountId);
    expect(first).toMatchObject({
      imported: 3,
      bodiesFetched: 3,
      threadsResolved: 3,
      // Every row starts imported as pending, so all three links change.
      threadLinksChanged: 3,
    });

    const status = await pool.query(
      "select payload from events where entity_id = $1 and type = 'sync.status' order by at",
      [accountId],
    );
    expect(status.rows.at(-1).payload).toMatchObject({
      threadsResolved: 3,
      threadLinksChanged: 3,
      pendingThreads: 0,
    });

    const second = await runner.runAccountCycle(session, accountId);
    expect(second).toMatchObject({ threadsResolved: 0, threadLinksChanged: 0 });
  });

  it("prunes thread rows nothing references anymore", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({ uid: 1, id: "prune-root", subject: "Prune me not" }),
      mail({ uid: 2, id: "prune-child", inReplyTo: ["prune-root"], references: ["prune-root"] }),
    ]);

    const { db, backfill, bodies, threads } = services();
    await drain(backfill, session, accountId, folder);
    await drainBodies(bodies, session, accountId);
    await threads.reconcileAccount(accountId);

    // Root and child share one thread; that row has members.
    const live = new Set((await accountMessages(accountId)).map((row) => row.threadId));
    expect(live.size).toBe(1);
    expect(live.has(null)).toBe(false);

    // A thread row nothing references: an unlink stranded it, or it never had
    // members. It must not survive the next pass.
    const [orphan] = await db.insert(threadsTable).values({ accountId }).returning();

    const summary = await threads.reconcileAccount(accountId);
    expect(summary.threadsPruned).toBe(1);
    expect(await threads.pendingCount(accountId)).toBe(0);

    const remaining = await pool.query("select id from threads where account_id = $1", [accountId]);
    expect(remaining.rows.map((row: { id: string }) => row.id).sort()).toEqual([...live].sort());
    expect(remaining.rows.some((row: { id: string }) => row.id === orphan!.id)).toBe(false);
    // The prune itself is on the audit trail, with no rows examined.
    expect(await eventCount(accountId, "sync.thread_reconciliation")).toBe(2);
  });

  it("contains a failing thread pass and still records the cycle status", async () => {
    const { accountId } = await setupAccount(["INBOX"]);
    const session = new FakeMailboxSession();
    session.load("INBOX", [mail({ uid: 1, id: "contain-one" })]);

    const { backfill, bodies, steady, reconcile } = services();
    class ExplodingThreads extends ThreadService {
      override async reconcileAccount(): Promise<never> {
        throw new SyncError("mailbox_error", "The thread pass hit a broken chain.");
      }
    }

    const warns: string[] = [];
    const runner = new SyncRunner(
      createDatabase(pool),
      backfill,
      bodies,
      new ExplodingThreads(createDatabase(pool)),
      steady,
      reconcile,
      { logger: { warn: (message) => warns.push(message) } },
    );

    // The throw must cost neither the answer nor the status event.
    const summary = await runner.runAccountCycle(session, accountId);
    expect(summary).toMatchObject({
      imported: 1,
      threadErrors: 1,
      folderErrors: 0,
      bodyErrors: 0,
      threadsResolved: 0,
    });

    const status = await pool.query(
      "select payload from events where entity_id = $1 and type = 'sync.status' order by at",
      [accountId],
    );
    expect(status.rows.at(-1).payload).toMatchObject({ threadErrors: 1, pendingThreads: 1 });
    expect(warns.some((message) => message.includes("failed and was contained"))).toBe(true);
  });

  it("orders concurrent passes so a mutual reply pair cannot become a parent cycle", async () => {
    const { accountId, folderIds } = await setupAccount(["INBOX"]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();

    // First only A exists: it resolves pending, with no parent, and stands in
    // a thread of its own.
    session.load("INBOX", [mail({ uid: 1, id: "mutual-a", inReplyTo: ["mutual-b"] })]);
    const first = services();
    await drain(first.backfill, session, accountId, folder);
    await drainBodies(first.bodies, session, accountId);
    await first.threads.reconcileAccount(accountId);

    // B arrives: it answers A and also names A as its parent.
    session.load("INBOX", [
      mail({ uid: 1, id: "mutual-a", inReplyTo: ["mutual-b"] }),
      mail({ uid: 2, id: "mutual-b", inReplyTo: ["mutual-a"] }),
    ]);
    session.uidNext = 3;
    const second = services();
    await second.steady.pollFolder(session, accountId, folder.id);
    await drainBodies(second.bodies, session, accountId);

    const rows = await accountMessages(accountId);
    const a = holding(rows, "mutual-a");
    const b = holding(rows, "mutual-b");
    expect(a).toMatchObject({ parentMessageId: null });
    expect(a.threadId).toEqual(expect.any(String));

    // Importing B marks A dirty again; settle A so the first pass below owns
    // only B. The mid-race dirtying below brings A back.
    await pool.query("update messages set thread_dirty = false where id = $1", [a.id]);
    expect(b).toMatchObject({ parentMessageId: null, threadDirty: true });

    // Any batch that holds both rows must order A first.
    await pool.query("update messages set sent_at = sent_at + interval '1 hour' where id = $1", [a.id]);

    // Stall exactly the write that would link B onto A, so a second pass
    // decides A against B while the first pass holds its link uncommitted.
    await pool.query(`
      create function mail_hub_test_stall() returns trigger as $fn$
        begin
          perform pg_sleep(2);
          return new;
        end;
      $fn$ language plpgsql
    `);
    await pool.query(
      `create trigger mail_hub_test_stall before update on messages
       for each row
       when (old.parent_message_id is distinct from new.parent_message_id
             and new.parent_message_id = '${a.id}'::uuid)
       execute function mail_hub_test_stall()`,
    );

    try {
      const stalled = second.threads.reconcileAccount(accountId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A concurrent ingestion rewrote A's references, so A owes a decision
      // while the first pass still holds B's row.
      await pool.query("update messages set thread_dirty = true where id = $1", [a.id]);
      const racing = services().threads.reconcileAccount(accountId);
      await Promise.all([stalled, racing]);
    } finally {
      await pool.query("drop trigger if exists mail_hub_test_stall on messages");
      await pool.query("drop function if exists mail_hub_test_stall()");
    }

    const settled = await accountMessages(accountId);
    const aAfter = holding(settled, "mutual-a");
    const bAfter = holding(settled, "mutual-b");
    // Exactly one direction holds a link; the pair never points at itself.
    const parents = [aAfter.parentMessageId, bAfter.parentMessageId].filter((id) => id !== null);
    expect(parents).toHaveLength(1);
    expect(bAfter.parentMessageId).toBe(aAfter.id);
    expect([aAfter.threadDirty, bAfter.threadDirty]).toEqual([false, false]);
  });
});
