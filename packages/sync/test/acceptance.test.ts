import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  attachmentCacheKey,
  attachments,
  createDatabase,
  createStorage,
  folders,
  messageOccurrences,
  runMigrations,
  type Folder,
  type MessageOccurrence,
  type Storage,
} from "@mail-hub/database";
import { IngestionService } from "@mail-hub/ingestion";
import { RecoveryControls } from "@mail-hub/recovery";
import {
  ActionService,
  TwoWayActionExecutor,
  type ActionMailboxCapabilities,
  type ActionMailboxFlags,
  type ActionMailboxState,
  type FlagWriteRequest,
  type FlagWriteResult,
  type MailActionSubmission,
  type MoveWriteResult,
  type WritableActionMailbox,
} from "@mail-hub/actions";
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
 * Integrated sync, storage, threading, and search acceptance (SPEC section
 * 12, "Sync, storage, and search acceptance"). Every scenario runs the real
 * services against a real PostgreSQL and the filesystem store: interrupted
 * backfill, message copies, generation resets with reused UIDs, thread
 * ambiguity, attachment regeneration, concurrent flag writes, and the header
 * and body search behavior the generated index vector owes. Set
 * `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

/** The deployment generation the action scenarios run under. */
const GENERATION = randomUUID();

/** The header identity one fixture carries. */
interface MailSpec {
  uid: number;
  subject: string;
  /** Message-ID local part; `null` omits the header entirely. */
  id?: string | null;
  /** Bare identifiers this message replies to. */
  inReplyTo?: string[];
  /** Bare identifiers, oldest first. */
  references?: string[];
  from?: string;
  to?: string;
  body?: string;
  flags?: string[];
  /** Extra header lines, for example the MIME declarations. */
  extra?: string[];
}

/** One fixture message with explicit identity headers. */
function mail(spec: MailSpec): FakeMessage {
  const lines = [
    `From: ${spec.from ?? "Alice Sender <alice@example.com>"}`,
    `To: ${spec.to ?? "Bob <bob@example.com>"}`,
    `Subject: ${spec.subject}`,
    "Date: Mon, 07 Sep 2026 10:15:00 +0000",
  ];
  if (spec.id !== null && spec.id !== undefined) {
    lines.push(`Message-ID: <${spec.id}@example.com>`);
  }
  if (spec.inReplyTo !== undefined && spec.inReplyTo.length > 0) {
    lines.push(`In-Reply-To: ${spec.inReplyTo.map((id) => `<${id}@example.com>`).join(" ")}`);
  }
  if (spec.references !== undefined) {
    lines.push(`References: ${spec.references.map((id) => `<${id}@example.com>`).join(" ")}`);
  }
  lines.push(...(spec.extra ?? []));
  return {
    uid: spec.uid,
    headers: lines.join("\r\n"),
    body: spec.body ?? `Body of ${spec.subject}.`,
    flags: spec.flags ?? [],
    internalDate: new Date(Date.UTC(2026, 8, 7, 10, 0, 0) + spec.uid * 60_000),
  };
}

/**
 * The writable action view of one fake session: the same selected connection
 * the sync services use, extended with the two-way writes the executor
 * drives. Writes translate into the fake's flag arrays. Under CONDSTORE the
 * adapter keeps one modification sequence per UID, advances it on every
 * applied write or concurrent change, and rejects a write whose
 * `UNCHANGEDSINCE` condition no longer holds.
 */
class WritableSession implements WritableActionMailbox {
  /** Every flag write the session received, in order. */
  readonly flagWrites: FlagWriteRequest[] = [];
  private readonly modseqs = new Map<string, string>();
  private current: string | null = null;

  constructor(
    private readonly session: FakeMailboxSession,
    private readonly condstore: boolean,
  ) {}

  async select(folder: string): Promise<ActionMailboxState> {
    const state = await this.session.select(folder);
    this.current = folder;
    return state;
  }

  async fetchFlags(uids: number[]): Promise<ActionMailboxFlags[]> {
    const flags = await this.session.fetchFlags(uids);
    return this.condstore ? flags.map((entry) => ({ ...entry, modseq: this.modseqOf(entry.uid) })) : flags;
  }

  async revalidate(): Promise<ActionMailboxState> {
    return this.session.revalidate();
  }

  async capabilities(): Promise<ActionMailboxCapabilities> {
    return { condstore: this.condstore, move: true };
  }

  async writeFlag(request: FlagWriteRequest): Promise<FlagWriteResult> {
    this.flagWrites.push(request);
    const message = this.messageOf(request.uid);
    if (message === undefined) {
      return { result: "rejected" };
    }
    if (request.unchangedSince !== null && Number(this.modseqOf(request.uid)) > Number(request.unchangedSince)) {
      return { result: "rejected" };
    }
    this.setFlag(message, request.flag, request.value);
    if (this.condstore) {
      this.bump(request.uid);
    }
    return { result: "accepted" };
  }

  async moveMessage(): Promise<MoveWriteResult> {
    return { result: "rejected" };
  }

  /** One concurrent client write through another connection. */
  async touch(uid: number, change: { unread?: boolean; flagged?: boolean }): Promise<void> {
    const message = this.messageOf(uid);
    if (message === undefined) {
      throw new Error(`No message ${uid} exists in ${this.current ?? "no folder"}.`);
    }
    if (change.unread !== undefined) {
      this.setFlag(message, "unread", change.unread);
    }
    if (change.flagged !== undefined) {
      this.setFlag(message, "flagged", change.flagged);
    }
    if (this.condstore) {
      this.bump(uid);
    }
  }

  private setFlag(message: FakeMessage, flag: "unread" | "flagged", value: boolean): void {
    const flags = new Set(message.flags ?? []);
    const present = flag === "unread" ? !value : value;
    if (present) {
      flags.add(flag === "unread" ? "\\Seen" : "\\Flagged");
    } else {
      flags.delete(flag === "unread" ? "\\Seen" : "\\Flagged");
    }
    message.flags = [...flags];
  }

  private messageOf(uid: number): FakeMessage | undefined {
    return (this.session.mailboxes.get(this.current ?? "") ?? []).find((message) => message.uid === uid);
  }

  private modseqOf(uid: number): string {
    return this.modseqs.get(this.key(uid)) ?? "1";
  }

  private bump(uid: number): void {
    this.modseqs.set(this.key(uid), String(Number(this.modseqOf(uid)) + 1));
  }

  private key(uid: number): string {
    return `${this.current}:${uid}`;
  }
}

suite("Sync, storage, and search acceptance", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let storage: Storage;
  let root: string;
  let controls: RecoveryControls;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);

    // The control state is ready before any scenario fills the database.
    controls = new RecoveryControls(createDatabase(pool), { deploymentGeneration: GENERATION });
    const initialized = await controls.initialize();
    expect(initialized.result).toBe("initialized");

    root = await mkdtemp(join(tmpdir(), "mail-hub-acceptance-"));
    storage = createStorage(root);
  });

  afterAll(async () => {
    await pool?.end();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`drop database ${databaseName} with (force)`);
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

  function services(windowSize?: number) {
    const db = createDatabase(pool);
    const ingestion = new IngestionService(db, storage);
    return {
      db,
      ingestion,
      backfill: new BackfillService(db, windowSize === undefined ? {} : { windowSize }),
      bodies: new BodyFetchService(db, ingestion),
      threads: new ThreadService(db),
      steady: new SteadyStateService(db),
      reconcile: new ReconciliationService(db),
    };
  }

  /** The action service over the shared controls and one writable session. */
  function actionServices(session: FakeMailboxSession, condstore: boolean) {
    const mailbox = new WritableSession(session, condstore);
    const service = new ActionService(createDatabase(pool), controls, new TwoWayActionExecutor());
    return { mailbox, service };
  }

  function submission(accountId: string, kind: MailActionSubmission["kind"], occurrenceIds: string[]): MailActionSubmission {
    return {
      accountId,
      kind,
      recoveryGeneration: GENERATION,
      idempotencyKey: `key-${randomUUID()}`,
      occurrenceIds,
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
      const outcome: BackfillBatchOutcome = await backfill.runBatch(session, accountId, folder.id);
      if (
        outcome.state === "generation_changed" ||
        outcome.state === "complete" ||
        ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete)
      ) {
        return;
      }
    }
    throw new Error("The backfill drain did not finish the folder.");
  }

  /** Resolve body jobs until none remain. */
  async function drainBodies(
    bodies: BodyFetchService,
    session: FakeMailboxSession,
    accountId: string,
  ): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const jobs = await bodies.pendingBodies(accountId, 10);
      if (jobs.length === 0) {
        return;
      }
      for (const job of jobs) {
        await bodies.fetchBody(session, accountId, job);
      }
    }
    throw new Error("The body drain did not finish the account.");
  }

  async function occurrence(accountId: string, folderId: string, uid: number): Promise<MessageOccurrence> {
    const rows = await createDatabase(pool)
      .select()
      .from(messageOccurrences)
      .where(
        and(
          eq(messageOccurrences.accountId, accountId),
          eq(messageOccurrences.folderId, folderId),
          eq(messageOccurrences.uid, uid),
        ),
      )
      .limit(1);
    return rows[0]!;
  }

  async function occurrenceRow(occurrenceId: string): Promise<MessageOccurrence> {
    const rows = await createDatabase(pool)
      .select()
      .from(messageOccurrences)
      .where(eq(messageOccurrences.id, occurrenceId))
      .limit(1);
    return rows[0]!;
  }

  /** How many of one account's messages a natural-language query matches. */
  async function searchHits(accountId: string, query: string): Promise<number> {
    const rows = await pool.query(
      "select count(*)::int as count from messages where account_id = $1 and search @@ plainto_tsquery('simple', $2)",
      [accountId, query],
    );
    return rows.rows[0].count;
  }

  /** How many of one account's messages an `and`-joined term query matches. */
  async function searchTerms(accountId: string, terms: string): Promise<number> {
    const rows = await pool.query(
      "select count(*)::int as count from messages where account_id = $1 and search @@ to_tsquery('simple', $2)",
      [accountId, terms],
    );
    return rows.rows[0].count;
  }

  async function countMessages(accountId: string): Promise<number> {
    const rows = await pool.query("select count(*)::int as count from messages where account_id = $1", [accountId]);
    return rows.rows[0].count;
  }

  it("resumes an interrupted newest-first backfill while arrivals continue", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    const initial = [
      mail({ uid: 1, subject: "Restart one" }),
      mail({ uid: 2, subject: "Restart two" }),
      // UID 3 and 5 to 6 stay empty: empty ranges must advance the boundary.
      mail({ uid: 4, subject: "Restart four" }),
      mail({ uid: 7, subject: "Restart seven" }),
      mail({ uid: 8, subject: "Restart eight" }),
    ];
    session.load("INBOX", initial);

    // One window imports the newest messages, then the worker stops between
    // batches. A restart must repeat only the uncommitted window.
    const interrupted = services(3);
    await interrupted.backfill.runBatch(session, accountId, folder.id);
    const partial = await interrupted.backfill.runBatch(session, accountId, folder.id);
    expect(partial).toMatchObject({ state: "imported", range: { low: 6, high: 8 }, found: 2, imported: 2 });

    // The newest imported message is findable by its headers before any body
    // was fetched (SPEC F5: header matches work first).
    expect(await searchHits(accountId, "restart eight")).toBe(1);
    expect(await searchHits(accountId, "body")).toBe(0);

    // Arrivals continue above the captured bound while backfill is stopped.
    session.load("INBOX", [...initial, mail({ uid: 9, subject: "Restart nine" }), mail({ uid: 10, subject: "Restart ten" })]);

    const resumed = services(3);
    await drain(resumed.backfill, session, accountId, folder);

    const occurrences = await pool.query(
      "select uid from message_occurrences where account_id = $1 and folder_id = $2 order by uid",
      [accountId, folder.id],
    );
    expect(occurrences.rows.map((row) => Number(row.uid))).toEqual([1, 2, 4, 7, 8]);
    expect(await countMessages(accountId)).toBe(5);

    // The arrivals belong to steady state, never to the finished boundary.
    const poll = await resumed.steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "polled", bound: 10, found: 2, imported: 2 });
    const after = await pool.query(
      "select uid from message_occurrences where account_id = $1 and folder_id = $2 order by uid",
      [accountId, folder.id],
    );
    expect(after.rows.map((row) => Number(row.uid))).toEqual([1, 2, 4, 7, 8, 9, 10]);
    expect(await countMessages(accountId)).toBe(7);
  });

  it("merges byte-identical copies without a Message-ID and keeps both occurrences", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }, { name: "Archive" }]);
    const inbox = folderIds.get("INBOX")!;
    const archive = folderIds.get("Archive")!;
    const shared = mail({ uid: 1, subject: "Anonymous copy", id: null });
    const distinct = mail({ uid: 2, subject: "Anonymous other", id: null, body: "Different bytes entirely." });
    const session = new FakeMailboxSession();
    session.load("INBOX", [shared, distinct]);
    session.load("Archive", [{ ...shared, uid: 9, flags: ["\\Seen", "\\Flagged"] }]);

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, inbox);
    await drain(backfill, session, accountId, archive);
    await drainBodies(bodies, session, accountId);

    // The byte-identical pair merges on its content hash; without identifiers
    // nothing else can merge, and the different message stays its own row.
    expect(await countMessages(accountId)).toBe(2);
    const grouped = await pool.query(
      `select m.subject, m.message_id, m.snippet, count(o.id)::int as occurrences
       from messages m join message_occurrences o on o.message_id = m.id
       where m.account_id = $1 group by m.subject, m.message_id, m.snippet order by m.subject`,
      [accountId],
    );
    expect(grouped.rows).toEqual([
      { subject: "Anonymous copy", message_id: null, snippet: "Body of Anonymous copy.", occurrences: 2 },
      { subject: "Anonymous other", message_id: null, snippet: "Different bytes entirely.", occurrences: 1 },
    ]);

    // Both occurrences survive the merge with their independent flags.
    const flags = await pool.query(
      "select f.name, o.unread, o.flagged from message_occurrences o join folders f on f.id = o.folder_id where o.account_id = $1 order by f.name, o.uid",
      [accountId],
    );
    expect(flags.rows).toEqual([
      { name: "Archive", unread: false, flagged: true },
      { name: "INBOX", unread: true, flagged: false },
      { name: "INBOX", unread: true, flagged: false },
    ]);
  });

  it("keeps both messages of a reused Message-ID and never guesses their child parent", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }, { name: "Archive" }]);
    const inbox = folderIds.get("INBOX")!;
    const archive = folderIds.get("Archive")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({ uid: 1, subject: "Twin original", id: "twin" }),
      mail({ uid: 3, subject: "Twin reply", id: "twin-reply", inReplyTo: ["twin"], references: ["twin"] }),
    ]);
    session.load("Archive", [
      mail({ uid: 2, subject: "Twin imposter", id: "twin", body: "Different bytes with the same identifier." }),
    ]);

    const { backfill, bodies, threads } = services();
    await drain(backfill, session, accountId, inbox);
    await drain(backfill, session, accountId, archive);
    await drainBodies(bodies, session, accountId);
    const summary = await threads.reconcileAccount(accountId);

    // Different bytes never merge, so two rows hold one identifier and no
    // parent can be chosen for the reply (SPEC section 12).
    expect(await countMessages(accountId)).toBe(3);
    const rows = await pool.query("select subject, message_id, thread_link_state, parent_message_id, thread_id from messages where account_id = $1", [
      accountId,
    ]);
    const reply = rows.rows.find((row) => row.subject === "Twin reply")!;
    expect(reply).toMatchObject({ message_id: "<twin-reply@example.com>", thread_link_state: "ambiguous", parent_message_id: null });
    const holders = rows.rows.filter((row) => row.message_id === "<twin@example.com>");
    expect(holders).toHaveLength(2);
    expect(holders.every((row) => row.thread_link_state === "root" && row.parent_message_id === null)).toBe(true);
    expect(new Set([...holders.map((row) => row.thread_id), reply.thread_id]).size).toBe(3);
    expect(summary).toMatchObject({ ambiguous: 1, pending: 0, remaining: 0 });

    // A repeated pass settles without inventing a link.
    const repeat = await threads.reconcileAccount(accountId);
    expect(repeat).toMatchObject({ examined: 0, remaining: 0 });
  });

  it("finds header matches before the body and body and mixed matches after the fetch", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [
      mail({
        uid: 1,
        subject: "Sable invoice",
        id: "sable",
        from: "Grace Foo <grace@example.com>",
        to: "Iris <iris@example.com>",
        body: "The xylvanium shipment left the dock.",
      }),
      mail({
        uid: 2,
        subject: "Quartz renewal",
        id: "quartz",
        from: "Hugo Bar <hugo@example.com>",
        to: "Jack <jack@example.com>",
        body: "Please confirm the verdigris paste order.",
      }),
    ]);

    const { backfill, bodies } = services();
    await drain(backfill, session, accountId, folder);

    // Header-only rows answer sender, recipient, and subject queries.
    expect(await searchHits(accountId, "grace@example.com")).toBe(1);
    expect(await searchHits(accountId, "iris@example.com")).toBe(1);
    expect(await searchHits(accountId, "sable invoice")).toBe(1);
    // No body text is indexed yet, so body terms miss.
    expect(await searchHits(accountId, "xylvanium")).toBe(0);

    await drainBodies(bodies, session, accountId);

    // Body terms appear, and only on the message that carries them.
    expect(await searchHits(accountId, "xylvanium")).toBe(1);
    expect(await searchHits(accountId, "verdigris")).toBe(1);
    // Mixed header and body queries hold both halves together.
    expect(await searchTerms(accountId, "grace@example.com & xylvanium")).toBe(1);
    expect(await searchTerms(accountId, "grace@example.com & verdigris")).toBe(0);
    expect(await searchTerms(accountId, "hugo@example.com & quartz")).toBe(1);

    const indexed = await pool.query(
      "select subject, body_index_text from messages where account_id = $1 order by subject",
      [accountId],
    );
    expect(indexed.rows.map((row) => [row.subject, row.body_index_text])).toEqual([
      ["Quartz renewal", "please confirm the verdigris paste order."],
      ["Sable invoice", "the xylvanium shipment left the dock."],
    ]);
  });

  it("rejects an action frozen before a generation change before any remote write", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [mail({ uid: 1, subject: "Old generation one" }), mail({ uid: 2, subject: "Old generation two" })]);

    const first = services();
    await drain(first.backfill, session, accountId, folder);

    // An offline device froze this action against generation 1 UIDs.
    const { service, mailbox } = actionServices(session, false);
    const frozen = await occurrence(accountId, folder.id, 2);
    const queued = await service.submit(submission(accountId, "mark_read", [frozen.id]));
    expect(queued.created).toBe(true);

    // The server rebuilds the folder: a new generation and a reused UID space.
    session.uidValidity = 2;
    session.load("INBOX", [mail({ uid: 1, subject: "New generation one" }), mail({ uid: 2, subject: "New generation two" })]);

    // A body job selected before the flip is refused, never applied.
    const staleJobs = await first.bodies.pendingBodies(accountId, 10);
    expect(staleJobs).toHaveLength(2);
    const stale = staleJobs.find((job) => job.uid === 2)!;
    await expect(first.bodies.fetchBody(session, accountId, stale)).resolves.toMatchObject({
      state: "generation_changed",
      recorded: 1,
      observed: 2,
    });
    expect(await first.bodies.pendingBodies(accountId, 10)).toHaveLength(2);

    // One cycle resets the generation and re-backfills the reused UIDs.
    const runner = new SyncRunner(
      createDatabase(pool),
      first.backfill,
      first.bodies,
      first.threads,
      first.steady,
      first.reconcile,
    );
    const cycle = await runner.runAccountCycle(session, accountId);
    expect(cycle).toMatchObject({ generationChanges: 1, resets: 1, imported: 2, bodiesFetched: 2 });

    // The stale worker results are gone: only the new generation owed bodies,
    // and the cycle resolved them.
    expect(await first.bodies.pendingBodies(accountId, 10)).toEqual([]);

    // The frozen action is rejected before any remote write (SPEC F2).
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.state).toBe("executed");
    expect(result.receipt.items[0]).toMatchObject({ itemKey: frozen.id, status: "conflicted" });
    expect(result.receipt.items[0]!.outcome).toMatchObject({ reason: "invalidated" });
    expect(mailbox.flagWrites).toEqual([]);

    // Both generations keep their messages; old occurrences stay invalidated.
    expect(await countMessages(accountId)).toBe(4);
    const occurrences = await pool.query(
      "select uidvalidity, uid, invalidated_at is not null as invalid from message_occurrences where account_id = $1 order by uidvalidity, uid",
      [accountId],
    );
    expect(
      occurrences.rows.map((row) => ({ uidvalidity: Number(row.uidvalidity), uid: Number(row.uid), invalid: row.invalid })),
    ).toEqual([
      { uidvalidity: 1, uid: 1, invalid: true },
      { uidvalidity: 1, uid: 2, invalid: true },
      { uidvalidity: 2, uid: 1, invalid: false },
      { uidvalidity: 2, uid: 2, invalid: false },
    ]);
  });

  it("refreshes concurrent flag changes and conflicts a stale frozen action without writing", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    const one = mail({ uid: 1, subject: "Flag race one" });
    const two = mail({ uid: 2, subject: "Flag race two" });
    session.load("INBOX", [one, two]);

    const { backfill, steady } = services();
    await drain(backfill, session, accountId, folder);

    // One device froze this action before another client touched the folder.
    const { service, mailbox } = actionServices(session, false);
    const target = await occurrence(accountId, folder.id, 1);
    const stale = await service.submit(submission(accountId, "mark_read", [target.id]));

    // Another client stars UID 1 and reads UID 2 without conditional writes.
    session.load("INBOX", [
      { ...one, flags: ["\\Flagged"] },
      { ...two, flags: ["\\Seen"] },
    ]);
    const poll = await steady.pollFolder(session, accountId, folder.id);
    expect(poll).toMatchObject({ state: "polled", flagsObserved: 2, flagsChanged: 2 });
    const refreshed = await occurrenceRow(target.id);
    expect(refreshed).toMatchObject({ unread: true, flagged: true, revision: 2 });

    // The frozen action conflicts on its stale revision, before any write.
    const conflicted = await service.execute(stale.receipt.actionId, mailbox);
    expect(conflicted.receipt.items[0]).toMatchObject({ status: "conflicted" });
    expect(conflicted.receipt.items[0]!.outcome).toMatchObject({ reason: "stale_revision" });
    expect(mailbox.flagWrites).toEqual([]);
    expect((await occurrenceRow(target.id)).unread).toBe(true);

    // A freshly frozen action writes only its flag and keeps the other.
    const fresh = await service.submit(submission(accountId, "mark_read", [target.id]));
    const confirmed = await service.execute(fresh.receipt.actionId, mailbox);
    expect(confirmed.receipt.items[0]).toMatchObject({ status: "confirmed" });
    expect(mailbox.flagWrites).toEqual([{ uid: 1, flag: "unread", value: false, unchangedSince: null }]);

    const observed = await mailbox.fetchFlags([1]);
    expect(observed[0]).toMatchObject({ uid: 1, unread: false, flagged: true });
    expect(await occurrenceRow(target.id)).toMatchObject({ unread: false, flagged: true, revision: 3 });
  });

  it("exposes a conditional-write conflict and confirms the retried conditional write", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }]);
    const folder = folderIds.get("INBOX")!;
    const session = new FakeMailboxSession();
    session.load("INBOX", [mail({ uid: 1, subject: "Conditional race" })]);

    const { backfill, db } = services();
    await drain(backfill, session, accountId, folder);

    const { service, mailbox } = actionServices(session, true);
    const target = await occurrence(accountId, folder.id, 1);
    // The server reports modification sequences and the local row captured one.
    await db.update(messageOccurrences).set({ modseq: "1" }).where(eq(messageOccurrences.id, target.id));

    // A concurrent client stars the message after the capture: sequence 1 -> 2.
    await mailbox.select("INBOX");
    await mailbox.touch(1, { flagged: true });

    const queued = await service.submit(submission(accountId, "mark_read", [target.id]));
    const conflicted = await service.execute(queued.receipt.actionId, mailbox);
    expect(conflicted.receipt.items[0]).toMatchObject({ status: "conflicted" });
    expect(conflicted.receipt.items[0]!.outcome).toMatchObject({ reason: "condstore_rejected" });
    // One conditional attempt reached the server; the value never held.
    expect(mailbox.flagWrites).toEqual([{ uid: 1, flag: "unread", value: false, unchangedSince: "1" }]);

    // The conflict exposed the refreshed state on the local row (SPEC F2).
    expect(await occurrenceRow(target.id)).toMatchObject({ unread: true, flagged: true, modseq: "2", revision: 2 });

    // A retry over the fresh sequence writes conditionally and confirms.
    const retry = await service.submit(submission(accountId, "mark_read", [target.id]));
    const confirmed = await service.execute(retry.receipt.actionId, mailbox);
    expect(confirmed.receipt.items[0]).toMatchObject({ status: "confirmed" });
    expect(mailbox.flagWrites.at(-1)).toEqual({ uid: 1, flag: "unread", value: false, unchangedSince: "2" });
    expect(await occurrenceRow(target.id)).toMatchObject({ unread: false, flagged: true, modseq: "3", revision: 3 });
  });

  it("regenerates twin attachments and duplicate Content-ID parts to their exact bytes", async () => {
    const { accountId, folderIds } = await setupAccount([{ name: "INBOX", role: "inbox" }, { name: "Archive" }]);
    const inbox = folderIds.get("INBOX")!;
    const archive = folderIds.get("Archive")!;
    // Two attachments share one name, type, decoded size, and Content-ID, and
    // differ only in their bytes; an embedded message carries a third file.
    const withTwins = mail({
      uid: 1,
      subject: "Twin attachments",
      id: "twins",
      extra: ["MIME-Version: 1.0", "Content-Type: multipart/mixed; boundary=TW"],
      body: [
        "--TW",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Twin attachments ride along.",
        "--TW",
        "Content-Type: image/png; name=badge.png",
        "Content-Disposition: inline; filename=badge.png",
        "Content-Transfer-Encoding: base64",
        "Content-ID: <same@badge>",
        "",
        "Zm9vYmFy",
        "--TW",
        "Content-Type: image/png; name=badge.png",
        "Content-Disposition: inline; filename=badge.png",
        "Content-Transfer-Encoding: base64",
        "Content-ID: <same@badge>",
        "",
        "bnVtYmVy",
        "--TW",
        "Content-Type: message/rfc822",
        "",
        "From: inner@example.com",
        "To: outer@example.com",
        "Subject: Inner twin",
        "Message-ID: <inner-twin@example.com>",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=IN",
        "",
        "--IN",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Inner text.",
        "--IN",
        "Content-Type: application/pdf; name=inner.pdf",
        "Content-Disposition: attachment; filename=inner.pdf",
        "Content-Transfer-Encoding: base64",
        "",
        "c3BhbQ==",
        "--IN--",
        "--TW--",
      ].join("\r\n"),
    });
    const session = new FakeMailboxSession();
    session.load("INBOX", [withTwins]);

    const { backfill, bodies, ingestion, db } = services();
    await drain(backfill, session, accountId, inbox);
    await drainBodies(bodies, session, accountId);

    const messageRows = await pool.query("select id from messages where account_id = $1", [accountId]);
    const messageId = messageRows.rows[0].id as string;
    const located = await db
      .select()
      .from(attachments)
      .where(eq(attachments.messageId, messageId))
      .orderBy(attachments.partPath);
    expect(located.map((part) => [part.partPath, part.filename, part.contentType, part.sizeBytes, part.contentId])).toEqual([
      ["/2", "badge.png", "image/png", 6, "same@badge"],
      ["/3", "badge.png", "image/png", 6, "same@badge"],
      ["/4", null, "message/rfc822", located[2]!.sizeBytes, null],
      ["/4/1/2", "inner.pdf", "application/pdf", 4, null],
    ]);
    const [first, second, wrapper, inner] = located;
    // Identical descriptions, different bytes: the hash tells them apart.
    expect(first!.decodedSha256).not.toBe(second!.decodedSha256);
    expect(new Set([first!.id, second!.id, wrapper!.id, inner!.id]).size).toBe(4);

    // Regeneration answers with exactly the bytes of each locator; a
    // duplicate Content-ID never selects an arbitrary inline image.
    const foobar = new TextEncoder().encode("foobar");
    const number = new TextEncoder().encode("number");
    const spam = new TextEncoder().encode("spam");
    expect(new Uint8Array((await ingestion.regenerateAttachment(first!.id)).bytes)).toEqual(foobar);
    expect(new Uint8Array((await ingestion.regenerateAttachment(second!.id)).bytes)).toEqual(number);
    expect(new Uint8Array((await ingestion.regenerateAttachment(inner!.id)).bytes)).toEqual(spam);
    const embedded = await ingestion.regenerateAttachment(wrapper!.id);
    expect(createHash("sha256").update(embedded.bytes).digest("hex")).toBe(wrapper!.decodedSha256);
    for (const part of located) {
      expect(await storage.disposable.stat(attachmentCacheKey(part.id))).not.toBeNull();
    }

    // Deleted extracted copies regenerate again from the durable original.
    expect(await storage.disposable.remove(attachmentCacheKey(first!.id))).toBe(true);
    expect(await storage.disposable.remove(attachmentCacheKey(second!.id))).toBe(true);
    expect(new Uint8Array((await ingestion.regenerateAttachment(first!.id)).bytes)).toEqual(foobar);

    // A byte-identical copy in a second folder merges without disturbing the
    // part rows or their identifiers.
    session.load("Archive", [{ ...withTwins, uid: 8, flags: ["\\Seen"] }]);
    await drain(backfill, session, accountId, archive);
    await drainBodies(bodies, session, accountId);

    expect(await countMessages(accountId)).toBe(1);
    const afterMerge = await db.select().from(attachments).where(eq(attachments.messageId, messageId)).orderBy(attachments.partPath);
    expect(afterMerge.map((part) => part.id)).toEqual(located.map((part) => part.id));
    const allParts = await pool.query(
      "select count(*)::int as count from attachments a join messages m on m.id = a.message_id where m.account_id = $1",
      [accountId],
    );
    expect(allParts.rows[0].count).toBe(4);
  });
});
