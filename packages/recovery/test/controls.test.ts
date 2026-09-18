import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  actions,
  createDatabase,
  events,
  outboundMessages,
  runMigrations,
  type MailHubDatabase,
} from "@mail-hub/database";
import { RecoveryControls, type RecoveryHooks } from "../src/index.ts";

/**
 * Recovery control acceptance against a real PostgreSQL. Set
 * `TEST_DATABASE_URL` to a connection string whose user may create databases;
 * a throwaway database is created per run. Without the variable the suite
 * skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";

suite("recovery controls", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;

  beforeAll(async () => {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    db = createDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await admin.query(`drop database ${databaseName} with (force)`);
    await admin.end();
  });

  function controls(deploymentGeneration?: string, hooks?: RecoveryHooks): RecoveryControls {
    return new RecoveryControls(db, { deploymentGeneration, hooks });
  }

  it("blocks everything when deployment configuration is missing", async () => {
    expect(await controls(undefined).readStatus()).toEqual({ state: "config_missing" });
    await expect(controls(undefined).gateMutation(GENERATION_A)).rejects.toMatchObject({
      code: "recovery_in_progress",
      httpStatus: 503,
    });
    await expect(controls(undefined).beginRecovery()).resolves.toEqual({
      result: "rejected",
      reason: "deployment_config_missing",
    });
  });

  it("blocks mail mutations before control state is initialized", async () => {
    expect(await controls(GENERATION_A).readStatus()).toEqual({
      state: "uninitialized",
      deploymentGeneration: GENERATION_A,
    });
    await expect(controls(GENERATION_A).gateMutation(GENERATION_A)).rejects.toMatchObject({
      code: "recovery_in_progress",
      httpStatus: 503,
    });
    await expect(controls(GENERATION_A).gateMutation(undefined)).rejects.toMatchObject({
      code: "invalid_recovery_generation",
      httpStatus: 400,
    });
  });

  it("refuses to initialize a database that already holds mail", async () => {
    const inserted = await db
      .insert(accounts)
      .values({ label: "main", color: "#2563eb", username: "user@example.com", passwordEnc: "v1:ct" })
      .returning();
    await expect(controls(GENERATION_A).initialize()).resolves.toEqual({
      result: "rejected",
      reason: "database_not_empty",
    });
    await db.delete(accounts).where(eq(accounts.id, inserted[0]!.id));
  });

  it("initializes a fresh installation and only once", async () => {
    await expect(controls(GENERATION_A).initialize()).resolves.toEqual({
      result: "initialized",
      generation: GENERATION_A,
    });
    await expect(controls(GENERATION_A).initialize()).resolves.toEqual({
      result: "rejected",
      reason: "already_initialized",
    });
    await expect(controls(GENERATION_B).initialize()).resolves.toEqual({
      result: "rejected",
      reason: "already_initialized",
    });
  });

  it("allows mutations once the control state is ready", async () => {
    await expect(controls(GENERATION_A).gateMutation(GENERATION_A)).resolves.toEqual({
      generation: GENERATION_A,
    });
  });

  it("begins recovery under a new generation and revokes restored auth once", async () => {
    const revocations: number[] = [];
    const hooks: RecoveryHooks = {
      revokeRestoredAuth: async () => {
        revocations.push(revocations.length);
      },
      hasRegisteredOwner: async () => true,
    };
    const service = controls(GENERATION_B, hooks);

    await expect(service.beginRecovery()).resolves.toEqual({ result: "started", generation: GENERATION_B });
    await expect(service.beginRecovery()).resolves.toEqual({ result: "resumed", generation: GENERATION_B });
    expect(revocations).toHaveLength(1);

    expect(await controls(GENERATION_B).readStatus()).toEqual({
      state: "reconciling",
      generation: GENERATION_B,
    });
    expect(await controls(GENERATION_A).readStatus()).toMatchObject({ state: "generation_mismatch" });
  });

  it("holds mail mutations while reconciling", async () => {
    await expect(controls(GENERATION_B).gateMutation(GENERATION_B)).rejects.toMatchObject({
      code: "recovery_in_progress",
      httpStatus: 503,
    });
    await expect(controls(GENERATION_B).gateMutation(GENERATION_A)).rejects.toMatchObject({
      code: "recovery_required",
      httpStatus: 409,
      currentGeneration: GENERATION_B,
    });
  });

  it("requires disposition of restored pending operations before completing", async () => {
    const accountRows = await db
      .insert(accounts)
      .values({ label: "main", color: "#2563eb", username: "user@example.com", passwordEnc: "v1:ct" })
      .returning();
    const accountId = accountRows[0]!.id;

    const actionRows = await db
      .insert(actions)
      .values({
        accountId,
        recoveryGeneration: GENERATION_A,
        idempotencyKey: "action-restore-1",
        requestHash: "hash",
        kind: "mark_read",
        request: {},
        status: "queued",
      })
      .returning();
    const outboundRows = await db
      .insert(outboundMessages)
      .values({
        accountId,
        recoveryGeneration: GENERATION_A,
        idempotencyKey: "send-restore-1",
        requestHash: "hash",
        draftRevision: 1,
        identity: { address: "user@example.com", name: null },
        envelopeSender: "user@example.com",
        envelopeRecipients: ["peer@example.com"],
        status: "queued",
        recipients: { to: [{ address: "peer@example.com", name: null }] },
        markdownSource: "",
        rfcMessageId: "restore-1@example.com",
        mimeStorageKey: "durable/outbound/restore-1",
        mimeSha256: "hash",
      })
      .returning();

    const service = controls(GENERATION_B);
    await expect(service.completeRecovery()).resolves.toEqual({
      result: "rejected",
      reason: "pending_operations",
      pendingOperations: { actions: 1, outboundMessages: 1 },
    });

    // A conflicted action is dispositioned; an unknown send outcome is an
    // explicit hold and also counts as dispositioned.
    await db.update(actions).set({ status: "conflicted" }).where(eq(actions.id, actionRows[0]!.id));
    await expect(service.completeRecovery()).resolves.toEqual({
      result: "rejected",
      reason: "pending_operations",
      pendingOperations: { actions: 0, outboundMessages: 1 },
    });
    await db
      .update(outboundMessages)
      .set({ status: "outcome_unknown" })
      .where(eq(outboundMessages.id, outboundRows[0]!.id));

    await expect(controls(GENERATION_B, { hasRegisteredOwner: async () => false }).completeRecovery()).resolves.toEqual(
      { result: "rejected", reason: "owner_missing" },
    );
    await expect(
      controls(GENERATION_B, { hasRegisteredOwner: async () => true }).completeRecovery(),
    ).resolves.toEqual({ result: "completed", generation: GENERATION_B, ownerCheck: "verified" });
    expect(await service.readStatus()).toEqual({ state: "ready", generation: GENERATION_B });
  });

  it("rejects completion without an active recovery or with a changed generation", async () => {
    await expect(controls(GENERATION_B).completeRecovery()).resolves.toEqual({
      result: "rejected",
      reason: "no_active_recovery",
    });
    await expect(controls(GENERATION_B).beginRecovery()).resolves.toEqual({
      result: "rejected",
      reason: "already_ready",
    });
  });

  it("records recovery events without secrets", async () => {
    const rows = await db.select().from(events).where(eq(events.entityType, "service_state"));
    const types = rows.map((row) => row.type);

    expect(types).toContain("recovery.init");
    expect(types).toContain("recovery.complete");

    const beginPayloads = rows
      .filter((row) => row.type === "recovery.begin")
      .map((row) => row.payload)
      .sort((left, right) => (left.resumed === right.resumed ? 0 : left.resumed ? 1 : -1));
    expect(beginPayloads).toHaveLength(2);
    expect(beginPayloads[0]).toMatchObject({
      recoveryGeneration: GENERATION_B,
      previousGeneration: GENERATION_A,
      resumed: false,
    });
    expect(beginPayloads[1]).toMatchObject({ recoveryGeneration: GENERATION_B, resumed: true });

    expect(JSON.stringify(rows)).not.toContain("password");
  });
});
