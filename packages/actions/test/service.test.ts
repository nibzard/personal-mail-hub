import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  actionItems,
  actions,
  createDatabase,
  events,
  folders,
  messageOccurrences,
  messages,
  runMigrations,
  type MailHubDatabase,
  type MessageOccurrence,
  dropTestDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";
import {
  ACTION_APPLIED_EVENT,
  ACTION_COMPLETED_EVENT,
  ACTION_QUEUED_EVENT,
  ACTION_RESTORED_HELD_EVENT,
  ActionError,
  ActionService,
  TwoWayActionExecutor,
  type MailActionSubmission,
} from "../src/index.ts";
import { FakeActionMailbox } from "./fake-action-mailbox.ts";
import { FakeActionExecutor } from "./fake-executor.ts";

/**
 * Action-service acceptance against a real PostgreSQL (SPEC section 7).
 * Set `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

/** The deployment generation every test controls state with. */
const GENERATION = randomUUID();

/** A second generation, as a restore would install. */
const NEXT_GENERATION = randomUUID();

suite("ActionService", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let db: MailHubDatabase;
  let controls: RecoveryControls;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    db = createDatabase(pool);

    controls = new RecoveryControls(db, { deploymentGeneration: GENERATION });
    const initialized = await controls.initialize();
    expect(initialized.result).toBe("initialized");
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  function maintenanceUrl(): string {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    return url.toString();
  }

  /** One account with an Inbox and an Archive, both recorded at generation 1. */
  async function setupAccount(): Promise<{ accountId: string; inboxId: string; archiveId: string }> {
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
      .values([
        { accountId: account!.id, name: "INBOX", role: "inbox", uidvalidity: 1 },
        { accountId: account!.id, name: "Archive", role: "archive", uidvalidity: 1 },
      ])
      .returning();
    return {
      accountId: account!.id,
      inboxId: inserted.find((folder) => folder.name === "INBOX")!.id,
      archiveId: inserted.find((folder) => folder.name === "Archive")!.id,
    };
  }

  /** One active occurrence at generation 1, backed by a minimal message row. */
  async function seedOccurrence(
    accountId: string,
    folderId: string,
    uid: number,
    flags: { unread?: boolean; flagged?: boolean } = {},
  ): Promise<MessageOccurrence> {
    const [message] = await db
      .insert(messages)
      .values({ accountId, subject: `occ-${uid}`, sentAt: new Date() })
      .returning({ id: messages.id });
    const [occurrence] = await db
      .insert(messageOccurrences)
      .values({
        accountId,
        messageId: message!.id,
        folderId,
        uidvalidity: 1,
        uid,
        internalDate: new Date(),
        unread: flags.unread ?? true,
        flagged: flags.flagged ?? false,
      })
      .returning();
    return occurrence!;
  }

  /** A service over the shared controls and one scriptable executor. */
  function newService(executor = new FakeActionExecutor()): {
    service: ActionService<FakeActionMailbox>;
    executor: FakeActionExecutor;
  } {
    return { service: new ActionService(db, controls, executor), executor };
  }

  function submission(
    accountId: string,
    kind: MailActionSubmission["kind"],
    occurrenceIds: string[],
    extra: Partial<MailActionSubmission> = {},
  ): MailActionSubmission {
    return {
      accountId,
      kind,
      recoveryGeneration: GENERATION,
      idempotencyKey: `key-${randomUUID()}`,
      occurrenceIds,
      ...extra,
    };
  }

  /** The mailbox answer one folder's occurrences describe. */
  function mailboxOf(
    occurrences: MessageOccurrence[],
    folderName = "INBOX",
  ): FakeActionMailbox {
    const mailbox = new FakeActionMailbox();
    mailbox.load(
      folderName,
      occurrences.map((occurrence) => ({
        uid: occurrence.uid,
        unread: occurrence.unread,
        flagged: occurrence.flagged,
        ...(occurrence.modseq === null || occurrence.modseq === undefined
          ? {}
          : { modseq: occurrence.modseq }),
      })),
    );
    return mailbox;
  }

  async function occurrenceRow(occurrenceId: string): Promise<MessageOccurrence> {
    const rows = await db.select().from(messageOccurrences).where(eq(messageOccurrences.id, occurrenceId)).limit(1);
    return rows[0]!;
  }

  async function itemRows(actionId: string) {
    return db
      .select()
      .from(actionItems)
      .where(eq(actionItems.actionId, actionId))
      .orderBy(sql`(${actionItems.target} ->> 'uid')::bigint`, actionItems.itemKey);
  }

  /** Actions of one account, so parallel tests never collide. */
  async function actionsOf(accountId: string) {
    return db.select({ id: actions.id }).from(actions).where(eq(actions.accountId, accountId));
  }

  async function eventsOf(type: string, entityId: string | null = null) {
    const where =
      entityId === null
        ? and(eq(events.type, type), eq(events.entityType, "action"))
        : and(eq(events.type, type), eq(events.entityId, entityId));
    const rows = await db.select().from(events).where(where);
    return rows.map((row) => row.payload as Record<string, unknown>);
  }

  it("freezes targets at queue time and answers a repeated key with the same receipts", async () => {
    const { accountId, inboxId } = await setupAccount();
    const first = await seedOccurrence(accountId, inboxId, 1, { unread: true });
    const second = await seedOccurrence(accountId, inboxId, 2, { unread: true, flagged: true });

    const { service } = newService();
    const result = await service.submit(
      submission(accountId, "mark_read", [first.id, second.id, first.id]),
    );
    expect(result.created).toBe(true);
    expect(result.receipt).toMatchObject({
      kind: "mark_read",
      status: "queued",
      items: [
        { itemKey: first.id, status: "queued" },
        { itemKey: second.id, status: "queued" },
      ],
    });

    // The frozen target holds the occurrence, its folder generation, its
    // revision, and the flags observed at queue time (SPEC F2).
    const items = await itemRows(result.receipt.actionId);
    expect(items.map((item) => item.target)).toEqual([
      {
        occurrenceId: first.id,
        accountId,
        folderId: inboxId,
        uidvalidity: 1,
        uid: 1,
        revision: 1,
        observed: { unread: true, flagged: false },
        modseq: null,
      },
      {
        occurrenceId: second.id,
        accountId,
        folderId: inboxId,
        uidvalidity: 1,
        uid: 2,
        revision: 1,
        observed: { unread: true, flagged: true },
        modseq: null,
      },
    ]);

    // A repeated key returns the existing receipts; a changed payload under
    // the same key conflicts (SPEC section 7, step 2).
    const repeat = await service.submit(submission(accountId, "mark_read", [first.id, second.id], {
      idempotencyKey: result.receipt.idempotencyKey,
    }));
    expect(repeat.created).toBe(false);
    expect(repeat.receipt.actionId).toBe(result.receipt.actionId);
    await expect(
      service.submit(submission(accountId, "mark_read", [first.id], { idempotencyKey: result.receipt.idempotencyKey })),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const stored = await db.select({ value: actions.id }).from(actions);
    expect(stored).toHaveLength(1);
    expect(await eventsOf(ACTION_QUEUED_EVENT, result.receipt.actionId)).toHaveLength(1);
    expect(await actionsOf(accountId)).toHaveLength(1);
  });

  it("checks the recovery generation before the idempotency lookup", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 1);

    const { service } = newService();
    // A key the database never saw is still rejected first: the gate runs
    // before the lookup (SPEC section 7, step 1).
    await expect(
      service.submit(submission(accountId, "star", [occurrence.id], { recoveryGeneration: randomUUID() })),
    ).rejects.toMatchObject({ code: "recovery_required", httpStatus: 409 });

    await pool.query("update service_state set recovery_mode = 'reconciling'");
    try {
      await expect(service.submit(submission(accountId, "star", [occurrence.id]))).rejects.toMatchObject({
        code: "recovery_in_progress",
        httpStatus: 503,
      });
      const stored = await actionsOf(accountId);
      expect(stored).toHaveLength(0);
    } finally {
      await pool.query("update service_state set recovery_mode = 'ready'");
    }
    await expect(
      service.submit(submission(accountId, "star", [occurrence.id], { recoveryGeneration: "not-a-uuid" })),
    ).rejects.toBeInstanceOf(RecoveryBlockedError);
  });

  it("validates the account, request, key, and scope before queueing", async () => {
    const { accountId, inboxId, archiveId } = await setupAccount();
    const other = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 1);
    const foreign = await seedOccurrence(other.accountId, other.inboxId, 1);
    const expunged = await seedOccurrence(accountId, inboxId, 9);
    await db
      .update(messageOccurrences)
      .set({ expungedAt: new Date() })
      .where(eq(messageOccurrences.id, expunged.id));

    const { service } = newService();
    const rejects = (payload: MailActionSubmission) =>
      expect(service.submit(payload)).rejects.toBeInstanceOf(ActionError);

    await rejects(submission(accountId, "mark_read", []));
    await rejects(submission(accountId, "explode" as MailActionSubmission["kind"], [occurrence.id]));
    await rejects(submission(randomUUID(), "mark_read", [occurrence.id]));
    await rejects(submission(accountId, "mark_read", [occurrence.id, foreign.id]));
    await rejects(submission(accountId, "mark_read", [expunged.id]));
    await rejects(submission(accountId, "move", [occurrence.id]));
    await rejects(submission(accountId, "move", [occurrence.id], { destinationFolderId: other.archiveId }));
    await rejects(submission(accountId, "archive", [occurrence.id], { destinationFolderId: inboxId }));
    await rejects(submission(accountId, "star", [occurrence.id], { idempotencyKey: "x".repeat(201) }));

    expect(await actionsOf(accountId)).toHaveLength(0);

    // A well-formed scope still queues: validation rejects, it does not block.
    const valid = await service.submit(
      submission(accountId, "archive", [occurrence.id], { destinationFolderId: archiveId }),
    );
    expect(valid.created).toBe(true);
  });

  it("confirms a flag write and commits observed state, receipts, and events together", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 4, { unread: true });
    const mailbox = mailboxOf([occurrence]);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "mark_read", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.state).toBe("executed");

    // The executor saw the refreshed remote state and the frozen target.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      kind: "mark_read",
      target: { uid: 4, revision: 1 },
      remote: { unread: true },
      desired: { type: "flags", desire: { flag: "unread", value: false } },
    });

    // The mailbox answered with the new value, so the local observation, the
    // receipt, and the events committed together (SPEC section 7, step 5).
    const row = await occurrenceRow(occurrence.id);
    expect([row.unread, row.flagged, row.revision]).toEqual([false, false, 2]);
    expect(result.receipt).toMatchObject({
      status: "complete",
      items: [{ itemKey: occurrence.id, status: "confirmed", outcome: { observed: { unread: false, flagged: false } } }],
    });
    expect(await eventsOf(ACTION_APPLIED_EVENT, occurrence.id)).toHaveLength(1);
    expect(await eventsOf(ACTION_COMPLETED_EVENT, queued.receipt.actionId)).toEqual([
      { counts: { confirmed: 1 } },
    ]);

    // Executing a complete action changes nothing.
    const again = await service.execute(queued.receipt.actionId, mailbox);
    expect(again.state).toBe("executed");
    expect(executor.calls).toHaveLength(1);
    expect((await occurrenceRow(occurrence.id)).revision).toBe(2);
  });

  it("confirms without a write when the refreshed target already holds the desired value", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 7, { unread: true });
    // Another client read the message; the local row has not observed that.
    const mailbox = mailboxOf([{ ...occurrence, unread: false }]);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "mark_read", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "confirmed",
      outcome: { noop: true, observed: { unread: false } },
    });
    // No write left the service, and the local observation caught up.
    expect(executor.calls).toHaveLength(0);
    const row = await occurrenceRow(occurrence.id);
    expect([row.unread, row.revision]).toEqual([false, 2]);
  });

  it("conflicts on a stale local revision and leaves the target alone", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 2, { unread: true, flagged: true });
    const mailbox = mailboxOf([occurrence]);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "unstar", [occurrence.id]));
    // A poll observes a server change, so the frozen revision goes stale.
    await db
      .update(messageOccurrences)
      .set({ flagged: true, revision: 2, observedAt: new Date() })
      .where(eq(messageOccurrences.id, occurrence.id));

    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt).toMatchObject({
      status: "complete",
      items: [
        {
          status: "conflicted",
          outcome: { reason: "stale_revision", currentRevision: 2 },
        },
      ],
    });
    expect(executor.calls).toHaveLength(0);
    expect((await occurrenceRow(occurrence.id)).revision).toBe(2);
  });

  it("conflicts on a changed server modification sequence", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 3, { flagged: false });
    const mailbox = mailboxOf([occurrence]);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "star", [occurrence.id]));
    // The server advanced the modification sequence after the freeze.
    await db.update(messageOccurrences).set({ modseq: "41" }).where(eq(messageOccurrences.id, occurrence.id));

    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "conflicted",
      outcome: { reason: "modseq_changed", currentModseq: "41" },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("refuses a UID from another folder generation and conflicts the items", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 5);
    const mailbox = mailboxOf([occurrence]);
    mailbox.setUidValidity("INBOX", 2);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "mark_unread", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "conflicted",
      outcome: { reason: "generation_changed", observed: 2 },
    });
    // The selection validated the generation before any fetch or write.
    expect(mailbox.selections).toEqual(["INBOX"]);
    expect(executor.calls).toHaveLength(0);
    expect((await occurrenceRow(occurrence.id)).revision).toBe(1);
  });

  it("conflicts when the occurrence left the generation the item was frozen against", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 9, { unread: true });
    const mailbox = mailboxOf([occurrence]);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "mark_read", [occurrence.id]));
    // The folder rebuilt between the freeze and the run, and the occurrence
    // row moved to the new generation without going through invalidation:
    // the frozen UID belongs to the old UID space, where it names anything.
    await db
      .update(messageOccurrences)
      .set({ uidvalidity: 2 })
      .where(eq(messageOccurrences.id, occurrence.id));

    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "conflicted",
      outcome: { reason: "generation_changed", currentUidvalidity: 2 },
    });
    // The write refused to guess, so the executor and the row stayed idle.
    expect(executor.calls).toHaveLength(0);
    expect((await occurrenceRow(occurrence.id)).revision).toBe(1);
  });

  it("conflicts a target the refreshed mailbox no longer holds", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 6);
    const mailbox = mailboxOf([]);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "star", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "conflicted",
      outcome: { reason: "absent_remote" },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("keeps confirmed receipts when a later item fails, and never replays them", async () => {
    const { accountId, inboxId } = await setupAccount();
    const one = await seedOccurrence(accountId, inboxId, 11, { unread: true });
    const two = await seedOccurrence(accountId, inboxId, 12, { unread: true });
    const three = await seedOccurrence(accountId, inboxId, 13, { unread: true });
    const mailbox = mailboxOf([one, two, three]);
    const { service, executor } = newService();
    executor.queue({ kind: "confirm" }, { kind: "throw", error: new Error("The write was rejected.") });

    const queued = await service.submit(
      submission(accountId, "mark_read", [three.id, one.id, two.id]),
    );
    const result = await service.execute(queued.receipt.actionId, mailbox);
    // Items run in UID order; the failure between two successes
    // dispositioned neither of them again (SPEC section 7, step 4).
    expect(result.receipt).toMatchObject({ status: "complete" });
    expect(result.receipt.items).toMatchObject([
      { itemKey: one.id, status: "confirmed" },
      { itemKey: two.id, status: "failed", outcome: { code: "executor_error", message: "The write was rejected." } },
      { itemKey: three.id, status: "confirmed" },
    ]);
    const stored = mailbox.mailboxes.get("INBOX")!;
    expect([
      stored.find((message) => message.uid === one.uid)!.unread,
      stored.find((message) => message.uid === two.uid)!.unread,
      stored.find((message) => message.uid === three.uid)!.unread,
    ]).toEqual([false, true, false]);

    // A repeated run replays nothing: every item already holds a receipt.
    await service.execute(queued.receipt.actionId, mailbox);
    expect(executor.calls).toHaveLength(3);
  });

  it("holds an executor's uncertain outcome as unknown without touching local state", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 8, { unread: true });
    const mailbox = mailboxOf([occurrence]);
    const { service, executor } = newService();
    executor.queue({ kind: "unknown", reason: "The final response was lost." });

    const queued = await service.submit(submission(accountId, "mark_read", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "unknown",
      outcome: { reason: "The final response was lost." },
    });
    expect((await occurrenceRow(occurrence.id)).revision).toBe(1);
  });

  it("replays an interrupted flag assignment during restart reconciliation, target refreshed first", async () => {
    const { accountId, inboxId } = await setupAccount();
    const one = await seedOccurrence(accountId, inboxId, 21, { unread: true });
    const two = await seedOccurrence(accountId, inboxId, 22, { unread: true });
    const mailbox = mailboxOf([one, two]);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "mark_read", [one.id, two.id]));
    // A crash left one item executing and one queued (SPEC section 7, step 6).
    await pool.query(`update action_items set status = 'executing' where action_id = $1 and item_key = $2`, [
      queued.receipt.actionId,
      one.id,
    ]);

    const summary = await service.reconcileIncomplete(accountId, mailbox);
    expect(summary).toMatchObject({ scanned: 1, executed: 1, held: 0, generationMismatch: 0 });
    expect(executor.calls).toHaveLength(2);
    // The replay refreshed the target before writing: both confirmed.
    expect((await service.receipt(queued.receipt.actionId)).items).toMatchObject([
      { status: "confirmed" },
      { status: "confirmed" },
    ]);
    expect(await service.reconcileIncomplete(accountId, mailbox)).toMatchObject({ scanned: 0 });
  });

  it("never replays an interrupted move and holds it unknown; a queued move still runs", async () => {
    const { accountId, inboxId, archiveId } = await setupAccount();
    const interrupted = await seedOccurrence(accountId, inboxId, 31);
    const fresh = await seedOccurrence(accountId, inboxId, 32);
    const mailbox = mailboxOf([interrupted, fresh]);
    mailbox.load("Archive", []);
    const { service, executor } = newService();

    const first = await service.submit(
      submission(accountId, "move", [interrupted.id], { destinationFolderId: archiveId }),
    );
    await pool.query(`update action_items set status = 'executing' where action_id = $1`, [
      first.receipt.actionId,
    ]);
    const held = await service.execute(first.receipt.actionId, mailbox);
    expect(held.receipt).toMatchObject({
      status: "complete",
      items: [{ status: "unknown", outcome: { reason: "interrupted" } }],
    });
    expect(executor.calls).toHaveLength(0);

    const second = await service.submit(
      submission(accountId, "archive", [fresh.id], { destinationFolderId: archiveId }),
    );
    const moved = await service.execute(second.receipt.actionId, mailbox);
    expect(moved.receipt.items[0]).toMatchObject({ status: "confirmed" });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({
      kind: "archive",
      desired: { type: "move", destinationFolderId: archiveId, destinationFolderName: "Archive" },
    });
  });

  it("holds a lost destination as a conflict instead of guessing", async () => {
    const { accountId, inboxId, archiveId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 33);
    const mailbox = mailboxOf([occurrence]);
    const { service, executor } = newService();

    const queued = await service.submit(
      submission(accountId, "move", [occurrence.id], { destinationFolderId: archiveId }),
    );
    await db.delete(folders).where(eq(folders.id, archiveId));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "conflicted",
      outcome: { reason: "destination_removed" },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it("runs a two-way flag write through the readback and records what held", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 51, { unread: true, flagged: true });
    const mailbox = mailboxOf([occurrence]);
    const service = new ActionService(db, controls, new TwoWayActionExecutor());

    const queued = await service.submit(submission(accountId, "mark_read", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    // No CONDSTORE, so the write carried no captured sequence (SPEC F2).
    expect(mailbox.flagWrites).toEqual([
      { uid: 51, flag: "unread", value: false, unchangedSince: null },
    ]);
    // The write touched only the requested flag; the readback proved it.
    expect(result.receipt.items[0]).toMatchObject({
      status: "confirmed",
      outcome: { observed: { unread: false, flagged: true } },
    });
    const row = await occurrenceRow(occurrence.id);
    expect([row.unread, row.flagged, row.revision]).toEqual([false, true, 2]);
    expect(await eventsOf(ACTION_APPLIED_EVENT, occurrence.id)).toHaveLength(1);
  });

  it("writes conditionally with the frozen sequence and records the fresh one", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 52, { unread: true });
    await db.update(messageOccurrences).set({ modseq: "7" }).where(eq(messageOccurrences.id, occurrence.id));
    const mailbox = mailboxOf([{ ...occurrence, modseq: "7" }]);
    mailbox.writes.condstore = true;
    const service = new ActionService(db, controls, new TwoWayActionExecutor());

    const queued = await service.submit(submission(accountId, "star", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(mailbox.flagWrites).toEqual([
      { uid: 52, flag: "flagged", value: true, unchangedSince: "7" },
    ]);
    expect(result.receipt.items[0]).toMatchObject({
      status: "confirmed",
      outcome: { observed: { unread: true, flagged: true, modseq: "8" } },
    });
    // The observation committed with its receipt, so the next queued action
    // captures the fresh sequence (SPEC F2).
    const row = await occurrenceRow(occurrence.id);
    expect([row.flagged, row.revision, row.modseq]).toEqual([true, 2, "8"]);
  });

  it("holds a lost readback unknown with the last observed state", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 56, { unread: true });
    const mailbox = mailboxOf([occurrence]);
    mailbox.queue({ kind: "apply", dropReadbackAfter: true });
    const service = new ActionService(db, controls, new TwoWayActionExecutor());

    const queued = await service.submit(submission(accountId, "mark_read", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    // The connection dropped after the accepted write, so the receipt claims
    // no result and keeps what the refresh last observed (SPEC F2).
    expect(result.receipt.items[0]).toMatchObject({
      status: "unknown",
      outcome: {
        reason: "The accepted write could not be read back: The connection dropped during the readback.",
        observed: { unread: true, flagged: false },
      },
    });
    // The local observation claims nothing the readback did not prove.
    const row = await occurrenceRow(occurrence.id);
    expect([row.unread, row.revision]).toEqual([true, 1]);
    expect(await eventsOf(ACTION_APPLIED_EVENT, occurrence.id)).toHaveLength(0);
  });

  it("commits a rejected conditional write as a conflict with the refreshed state", async () => {
    const { accountId, inboxId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 53, { unread: true });
    await db.update(messageOccurrences).set({ modseq: "9" }).where(eq(messageOccurrences.id, occurrence.id));
    const mailbox = mailboxOf([{ ...occurrence, modseq: "9" }]);
    mailbox.writes.condstore = true;
    // The server accepted the command, but a concurrent change won and the
    // value never held (SPEC F2: refresh and conflict check).
    mailbox.queue({ kind: "accept_without_effect" });
    const service = new ActionService(db, controls, new TwoWayActionExecutor());

    const queued = await service.submit(submission(accountId, "star", [occurrence.id]));
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt).toMatchObject({
      status: "complete",
      items: [
        {
          status: "conflicted",
          outcome: { reason: "condstore_rejected", observed: { unread: true, flagged: false } },
        },
      ],
    });
    // A conflict writes no applied event and claims no change.
    expect(await eventsOf(ACTION_APPLIED_EVENT, occurrence.id)).toHaveLength(0);
    const row = await occurrenceRow(occurrence.id);
    expect([row.flagged, row.revision]).toEqual([false, 1]);
  });

  it("expunges the source occurrence of a confirmed move and records the destination", async () => {
    const { accountId, inboxId, archiveId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 54, { unread: true });
    const mailbox = mailboxOf([occurrence]);
    mailbox.load("Archive", []);
    const service = new ActionService(db, controls, new TwoWayActionExecutor());

    const queued = await service.submit(
      submission(accountId, "archive", [occurrence.id], { destinationFolderId: archiveId }),
    );
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "confirmed",
      outcome: {
        observed: { unread: true, flagged: false },
        movedTo: { folder: "Archive", uidvalidity: 1, uid: 101 },
      },
    });
    // The message left the source on the server, and the local row says so;
    // the destination copy arrives through synchronization (SPEC F4).
    expect(mailbox.mailboxes.get("INBOX")).toEqual([]);
    expect(mailbox.mailboxes.get("Archive")).toEqual([{ uid: 101, unread: true, flagged: false }]);
    const row = await occurrenceRow(occurrence.id);
    expect(row.expungedAt).not.toBeNull();
    expect(await eventsOf(ACTION_APPLIED_EVENT, occurrence.id)).toHaveLength(1);
  });

  it("lets the live claim's receipt replace the interrupted hold of a concurrent run", async () => {
    const { accountId, inboxId, archiveId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 57, { unread: true });
    const mailbox = mailboxOf([occurrence]);
    mailbox.load("Archive", []);
    const inner = new TwoWayActionExecutor();
    let held: unknown = null;
    // The remote move runs; while it is in flight, restart reconciliation of
    // a concurrent run holds the executing item unknown as interrupted.
    const service = new ActionService<FakeActionMailbox>(db, controls, {
      async apply(box, item) {
        const outcome = await inner.apply(box, item);
        await service.reconcileIncomplete(accountId, box);
        held = await service.receipt(item.actionId);
        return outcome;
      },
    });

    const queued = await service.submit(
      submission(accountId, "archive", [occurrence.id], { destinationFolderId: archiveId }),
    );
    const result = await service.execute(queued.receipt.actionId, mailbox);

    // The concurrent run really recorded the interrupted hold first.
    expect(held).toMatchObject({ items: [{ status: "unknown", outcome: { reason: "interrupted" } }] });
    // The live claim's receipt replaced it: the move is confirmed and the
    // source occurrence is expunged locally (SPEC section 7, step 5).
    expect(result.receipt.items[0]).toMatchObject({
      status: "confirmed",
      outcome: { movedTo: { folder: "Archive" } },
    });
    expect(mailbox.mailboxes.get("INBOX")).toEqual([]);
    expect((await occurrenceRow(occurrence.id)).expungedAt).not.toBeNull();
    expect(await eventsOf(ACTION_APPLIED_EVENT, occurrence.id)).toHaveLength(1);
  });

  it("fails a move without the MOVE capability and leaves the occurrence alone", async () => {
    const { accountId, inboxId, archiveId } = await setupAccount();
    const occurrence = await seedOccurrence(accountId, inboxId, 55);
    const mailbox = mailboxOf([occurrence]);
    mailbox.writes.move = false;
    const service = new ActionService(db, controls, new TwoWayActionExecutor());

    const queued = await service.submit(
      submission(accountId, "move", [occurrence.id], { destinationFolderId: archiveId }),
    );
    const result = await service.execute(queued.receipt.actionId, mailbox);
    expect(result.receipt.items[0]).toMatchObject({
      status: "failed",
      outcome: { code: "move_unsupported" },
    });
    expect(mailbox.moveRequests).toEqual([]);
    const row = await occurrenceRow(occurrence.id);
    expect(row.expungedAt).toBeNull();
  });

  it("reconciles only the account asked for", async () => {
    const mine = await setupAccount();
    const other = await setupAccount();
    const mineOccurrence = await seedOccurrence(mine.accountId, mine.inboxId, 1);
    const otherOccurrence = await seedOccurrence(other.accountId, other.inboxId, 1);
    const { service, executor } = newService();

    await service.submit(submission(mine.accountId, "star", [mineOccurrence.id]));
    await service.submit(submission(other.accountId, "star", [otherOccurrence.id]));

    const summary = await service.reconcileIncomplete(mine.accountId, mailboxOf([mineOccurrence]));
    expect(summary).toMatchObject({ scanned: 1, executed: 1 });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]).toMatchObject({ accountId: mine.accountId });
  });

  it("dispositions restored actions so recovery can complete", async () => {
    const { accountId, inboxId, archiveId } = await setupAccount();
    const queuedOccurrence = await seedOccurrence(accountId, inboxId, 41);
    const executingOccurrence = await seedOccurrence(accountId, inboxId, 42);
    const { service, executor } = newService();

    const queued = await service.submit(submission(accountId, "star", [queuedOccurrence.id]));
    const executing = await service.submit(
      submission(accountId, "move", [executingOccurrence.id], { destinationFolderId: archiveId }),
    );
    await pool.query(`update action_items set status = 'executing' where action_id = $1`, [
      executing.receipt.actionId,
    ]);

    // A restore installs a new deployment generation; the database still
    // carries the old one, so nothing runs (SPEC section 10).
    const restored = new RecoveryControls(db, { deploymentGeneration: NEXT_GENERATION });
    const heldService = new ActionService(db, restored, executor);
    const held = await heldService.execute(queued.receipt.actionId, mailboxOf([queuedOccurrence]));
    expect(held).toMatchObject({ state: "held", reason: "recovery_blocked" });
    await expect(heldService.submit(submission(accountId, "star", [queuedOccurrence.id]))).rejects.toMatchObject({
      code: "recovery_required",
    });

    // Recovery begin records the new generation; the actions still hold.
    expect((await restored.beginRecovery()).result).toBe("started");
    const disposition = await heldService.dispositionRestoredActions(NEXT_GENERATION);
    // Earlier tests leave their own old-generation actions pending, so only
    // the lower bounds hold globally; the per-action receipts below are exact.
    expect(disposition.unknown).toBeGreaterThanOrEqual(1);
    expect(disposition.actions).toBeGreaterThanOrEqual(2);
    expect(await eventsOf(ACTION_RESTORED_HELD_EVENT, queued.receipt.actionId)).toHaveLength(1);
    expect(executor.calls).toHaveLength(0);

    const afterQueued = await heldService.receipt(queued.receipt.actionId);
    const afterExecuting = await heldService.receipt(executing.receipt.actionId);
    expect(afterQueued).toMatchObject({ status: "complete", items: [{ status: "conflicted", outcome: { reason: "restored_generation" } }] });
    expect(afterExecuting).toMatchObject({ status: "complete", items: [{ status: "unknown", outcome: { reason: "restored_generation" } }] });

    // Every restored operation is dispositioned, so completion reopens work.
    const completed = await restored.completeRecovery();
    expect(completed.result).toBe("completed");
    const replayed = await heldService.execute(queued.receipt.actionId, mailboxOf([queuedOccurrence]));
    expect(replayed.state).toBe("executed");
    expect(executor.calls).toHaveLength(0);

    // Control state returns to the original generation for the tests that follow.
    const back = new RecoveryControls(db, { deploymentGeneration: GENERATION });
    expect((await back.beginRecovery()).result).toBe("started");
    expect((await back.completeRecovery()).result).toBe("completed");
  });
});
