import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  actions,
  createDatabase,
  createJobQueue,
  decisions,
  dropTestDatabase,
  events,
  folders,
  messageOccurrences,
  messages,
  outboundMessages,
  runMigrations,
  type MailHubDatabase,
} from "@mail-hub/database";
import { RecoveryControls } from "@mail-hub/recovery";
import { HealthService, type HealthReport } from "../src/index.ts";

/**
 * Health reporting against a real PostgreSQL (SPEC sections 10 and 11). Set
 * `TEST_DATABASE_URL` to a connection string whose user may create databases;
 * a throwaway database is created per run. Without the variable the suite
 * skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const OLD_ACTION_AT = new Date(Date.now() - 90_000);

suite("health service", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let scratchUrl: string;
  let controls: RecoveryControls;
  let service: HealthService;

  beforeAll(async () => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    url.pathname = `/${databaseName}`;
    scratchUrl = url.toString();
    pool = new Pool({ connectionString: scratchUrl });
    await runMigrations(pool);
    db = createDatabase(pool);

    controls = new RecoveryControls(db, { deploymentGeneration: GENERATION });
    const outcome = await controls.initialize();
    if (outcome.result !== "initialized") {
      throw new Error(`The scratch database could not be initialized: ${outcome.result}.`);
    }
    service = new HealthService(db, controls);
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  it("reports an empty but ready installation", async () => {
    // Runs before the queue-schema test creates pgboss tables, so the queue
    // is honestly unknown on a fresh installation whose worker never ran.
    const health = await service.readHealth();
    expect(health.available).toBe(true);
    if (!health.available) {
      return;
    }
    expect(health.report.status).toBe("ok");
    expect(health.report.database.state).toBe("ok");
    expect(health.report.database.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(health.report.recovery).toMatchObject({
      state: "ready",
      mode: "ready",
      generation: GENERATION,
      deploymentGeneration: GENERATION,
    });
    expect(health.report.queue).toEqual({
      state: "unknown",
      depth: null,
      oldestJobAt: null,
      oldestJobAgeSeconds: null,
      oldestPendingWorkAt: null,
      oldestPendingWorkAgeSeconds: null,
    });
    expect(health.report.classification.circuit).toBe("not_configured");
    expect(health.report.classification.calls).toBe(0);
    expect(health.report.classification.errors).toBe(0);
    expect(health.report.sends).toEqual({ queued: 0, failed: 0, outcomeUnknown: 0 });
    expect(health.report.accounts).toEqual([]);
  });

  it("reports per-account sync lag, metrics, queue age, and send counters", async () => {
    const fixtures = await insertFixtures(db);

    const health = await service.readHealth();
    expect(health.available).toBe(true);
    if (!health.available) {
      return;
    }
    const { report } = health;

    expect(report.status).toBe("ok");
    expect(report.accounts).toHaveLength(1);
    const account = report.accounts[0]!;
    expect(account).toMatchObject({ accountId: ACCOUNT_ID, label: "Main", color: "#0a7ffa" });
    expect(account.sync.lastCycleAt).toBe(fixtures.cycleAt.toISOString());
    expect(account.sync.cycleAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(account.sync.backfillPendingFolders).toBe(2);
    expect(account.sync.pendingBodies).toBe(1);
    expect(account.metrics).toEqual({
      messagesSynced: 3,
      bodiesFetched: 2,
      lastFullReconciliationAt: fixtures.inventoryAt.toISOString(),
      jevCalls: 1,
      jevErrors: 1,
    });
    expect(report.classification.calls).toBe(1);
    expect(report.classification.errors).toBe(1);
    expect(report.sends).toEqual({ queued: 1, failed: 1, outcomeUnknown: 1 });

    // The queued action is older than the queued send, so it holds the age.
    expect(report.queue.oldestPendingWorkAt).toBe(OLD_ACTION_AT.toISOString());
    expect(report.queue.oldestPendingWorkAgeSeconds).toBeGreaterThanOrEqual(90);
  });

  it("merges the circuit state the injected classification reader reports", async () => {
    const wired = new HealthService(db, controls, {
      readCircuit: async () => ({
        circuit: "open" as const,
        description: "Classification is paused: the breaker opened.",
      }),
    });
    const health = await wired.readHealth();
    expect(health.available).toBe(true);
    if (health.available) {
      // The circuit verdict comes from the reader; the counters still come
      // from the durable records the fixtures wrote.
      expect(health.report.classification).toEqual({
        circuit: "open",
        description: "Classification is paused: the breaker opened.",
        calls: 1,
        errors: 1,
      });
    }

    const broken = new HealthService(db, controls, {
      readCircuit: async () => {
        throw new Error("circuit state unreadable");
      },
    });
    const degraded = await broken.readHealth();
    expect(degraded.available).toBe(true);
    if (degraded.available) {
      expect(degraded.report.classification.circuit).toBe("unknown");
      expect(degraded.report.classification.description).toBe(
        "The classification circuit state could not be read.",
      );
    }
  });

  it("degrades while recovery is not ready or readable", async () => {
    const blocked = new HealthService(db, {
      readStatus: async () =>
        ({
          state: "reconciling",
          generation: GENERATION,
        }) as Awaited<ReturnType<RecoveryControls["readStatus"]>>,
    });
    const reconciling = await blocked.readHealth();
    expect(reconciling.available).toBe(true);
    if (reconciling.available) {
      expect(reconciling.report.status).toBe("degraded");
      expect(reconciling.report.recovery).toMatchObject({ state: "reconciling", mode: "reconciling" });
    }

    const failing = new HealthService(db, {
      readStatus: async () => {
        throw new Error("control row unreadable");
      },
    });
    const unreadable = await failing.readHealth();
    expect(unreadable.available).toBe(true);
    if (unreadable.available) {
      expect(unreadable.report.status).toBe("degraded");
      expect(unreadable.report.recovery.state).toBe("unknown");
    }
  });

  it("short-circuits with an unavailable verdict when the round trip fails", async () => {
    let reads = 0;
    const broken = {
      execute: async () => {
        reads += 1;
        throw new Error("connection refused");
      },
    } as unknown as MailHubDatabase;
    let statusReads = 0;
    const health = new HealthService(broken, {
      readStatus: async () => {
        statusReads += 1;
        return { state: "ready", generation: GENERATION } as const;
      },
    });
    const report: HealthReport = await health.readHealth();
    expect(report.available).toBe(false);
    if (!report.available) {
      expect(report.database).toEqual({ state: "unavailable", roundTripMs: null });
      expect(report.checkedAt).toBe(new Date(report.checkedAt).toISOString());
    }
    expect(reads).toBe(1);
    expect(statusReads).toBe(0);
  });

  it("reads queue age from the real job queue schema", async () => {
    const queue = createJobQueue(scratchUrl);
    await queue.start();
    try {
      await queue.createQueue("health-probe");
      await queue.send("health-probe", {});

      const health = await service.readHealth();
      expect(health.available).toBe(true);
      if (health.available) {
        expect(health.report.queue.state).toBe("ok");
        expect(health.report.queue.depth).toBe(1);
        expect(health.report.queue.oldestJobAt).not.toBeNull();
        expect(health.report.queue.oldestJobAgeSeconds).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await queue.stop();
    }
  });
});

/** The newest cycle and inventory times the fixtures write. */
interface Fixtures {
  cycleAt: Date;
  inventoryAt: Date;
}

/**
 * One account with three messages (two bodies fetched), a newest and an
 * older sync cycle, two inventories, one Jev decision, one Jev failure, an
 * old queued action, and one outbound message per reviewed status.
 */
async function insertFixtures(db: MailHubDatabase): Promise<Fixtures> {
  const cycleAt = new Date(Date.now() - 45_000);
  const inventoryAt = new Date(Date.now() - 30_000);
  const oldInventoryAt = new Date(Date.now() - 120_000);
  const oldCycleAt = new Date(Date.now() - 150_000);

  await db.insert(accounts).values({
    id: ACCOUNT_ID,
    label: "Main",
    color: "#0a7ffa",
    username: "owner@example.test",
    passwordEnc: "ciphertext",
  });
  const folder = (
    await db
      .insert(folders)
      .values({ accountId: ACCOUNT_ID, name: "INBOX", role: "inbox" })
      .returning()
  )[0]!;

  const inserted = await db
    .insert(messages)
    .values([
      { accountId: ACCOUNT_ID, subject: "First", fetchedBody: true },
      { accountId: ACCOUNT_ID, subject: "Second", fetchedBody: true },
      { accountId: ACCOUNT_ID, subject: "Third", fetchedBody: false },
    ])
    .returning();
  await db.insert(messageOccurrences).values(
    inserted.map((message, index) => ({
      accountId: ACCOUNT_ID,
      messageId: message.id,
      folderId: folder.id,
      uidvalidity: 1,
      uid: index + 1,
      internalDate: new Date(Date.now() - 60_000),
    })),
  );

  await db.insert(events).values([
    {
      actor: "system",
      type: "sync.status",
      entityType: "account",
      entityId: ACCOUNT_ID,
      at: oldCycleAt,
      payload: { accountId: ACCOUNT_ID, backfillPendingFolders: 9, pendingBodies: 9 },
    },
    {
      actor: "system",
      type: "sync.status",
      entityType: "account",
      entityId: ACCOUNT_ID,
      at: cycleAt,
      payload: { accountId: ACCOUNT_ID, backfillPendingFolders: 2, pendingBodies: 1 },
    },
    {
      actor: "system",
      type: "sync.folder_inventory",
      entityType: "folder",
      entityId: folder.id,
      at: oldInventoryAt,
      payload: { accountId: ACCOUNT_ID },
    },
    {
      actor: "system",
      type: "sync.folder_inventory",
      entityType: "folder",
      entityId: folder.id,
      at: inventoryAt,
      payload: { accountId: ACCOUNT_ID },
    },
    {
      actor: "system",
      type: "class.error",
      entityType: "account",
      entityId: ACCOUNT_ID,
      payload: { accountId: ACCOUNT_ID },
    },
  ]);

  await db.insert(decisions).values({
    messageId: inserted[0]!.id,
    inputHash: "abc123",
    model: "pinned-1",
    questionSet: "v1",
    answers: { class: "transactional" },
  });

  await db.insert(actions).values({
    accountId: ACCOUNT_ID,
    recoveryGeneration: GENERATION,
    idempotencyKey: "health-1",
    requestHash: "hash-1",
    kind: "flags",
    request: { desired: { unread: false } },
    status: "queued",
    createdAt: OLD_ACTION_AT,
  });

  const envelope = {
    identity: { address: "owner@example.test", name: null },
    envelopeSender: "owner@example.test",
    envelopeRecipients: ["peer@example.test"],
    recipients: { to: [{ address: "peer@example.test", name: null }] },
    markdownSource: "Hello",
    draftRevision: 1,
  };
  await db.insert(outboundMessages).values([
    {
      ...envelope,
      accountId: ACCOUNT_ID,
      recoveryGeneration: GENERATION,
      idempotencyKey: "send-queued",
      requestHash: "hash-q",
      status: "queued",
      rfcMessageId: "<q@example.test>",
      mimeStorageKey: "outbound/q",
      mimeSha256: "q",
    },
    {
      ...envelope,
      accountId: ACCOUNT_ID,
      recoveryGeneration: GENERATION,
      idempotencyKey: "send-failed",
      requestHash: "hash-f",
      status: "failed",
      rfcMessageId: "<f@example.test>",
      mimeStorageKey: "outbound/f",
      mimeSha256: "f",
    },
    {
      ...envelope,
      accountId: ACCOUNT_ID,
      recoveryGeneration: GENERATION,
      idempotencyKey: "send-unknown",
      requestHash: "hash-u",
      status: "outcome_unknown",
      rfcMessageId: "<u@example.test>",
      mimeStorageKey: "outbound/u",
      mimeSha256: "u",
    },
  ]);

  return { cycleAt, inventoryAt };
}
