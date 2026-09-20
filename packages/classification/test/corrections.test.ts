import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  dropTestDatabase,
  events,
  messages,
  runMigrations,
  senderOverrides,
  type MailHubDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls, type MutationGate } from "@mail-hub/recovery";
import {
  CLASS_CORRECTED_EVENT,
  ClassificationError,
  CorrectionService,
  type CorrectionRequest,
} from "../src/index.ts";

/**
 * Correction acceptance against a real PostgreSQL (SPEC F8): each scope
 * changes only what its name says, the gate runs first, and every
 * correction leaves exactly one event. Set `TEST_DATABASE_URL` to a
 * connection string whose user may create databases; a throwaway database
 * is created per run. Without the variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "55555555-5555-5555-8555-555555555555";

suite("correction service", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let controls: RecoveryControls;
  let service: CorrectionService;

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

    controls = new RecoveryControls(db, { deploymentGeneration: GENERATION });
    const outcome = await controls.initialize();
    if (outcome.result !== "initialized") {
      throw new Error(`The test database could not be initialized: ${outcome.result}.`);
    }
    service = new CorrectionService(db, controls);
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  /** One account the sender sweep scopes to. */
  async function insertAccount(): Promise<string> {
    const [account] = await db
      .insert(accounts)
      .values({
        label: `account-${randomUUID().slice(0, 8)}`,
        color: "#0f766e",
        username: "user@example.com",
        passwordEnc: "ciphertext",
      })
      .returning();
    return account!.id;
  }

  /** One stored message; the answer fields come from the caller. */
  async function insertMessage(
    accountId: string,
    input: {
      senderAddress?: string | null;
      classHint?: string | null;
      classSource?: string;
      rule?: string;
    },
  ): Promise<string> {
    const metadata: Record<string, unknown> = {};
    if (input.classSource !== undefined) {
      metadata.classSource = input.classSource;
    }
    if (input.rule !== undefined) {
      metadata.rule = input.rule;
    }
    const [message] = await db
      .insert(messages)
      .values({
        accountId,
        subject: "Subject",
        sender:
          input.senderAddress === undefined || input.senderAddress === null
            ? null
            : { address: input.senderAddress, name: null },
        senderText: input.senderAddress ?? "",
        subjectText: "Subject",
        fetchedBody: true,
        classHint: input.classHint ?? null,
        metadata,
      })
      .returning();
    return message!.id;
  }

  async function corrections(): Promise<{ type: string; payload: Record<string, unknown> }[]> {
    return db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(eq(events.type, CLASS_CORRECTED_EVENT));
  }

  it("answers one message with the owner's own class and stops the sweep", async () => {
    const accountId = await insertAccount();
    const messageId = await insertMessage(accountId, {
      senderAddress: "news@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const eventsBefore = (await corrections()).length;

    const result = await service.correct(
      { requestGeneration: GENERATION },
      { messageId, scope: "message", classHint: "correspondence", note: "A real question inside" },
    );

    expect(result).toMatchObject({
      scope: "message",
      classHint: "correspondence",
      sender: "news@example.com",
      previous: { source: "jev", classHint: "newsletter" },
      reapplied: 1,
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.classHint).toBe("correspondence");
    expect(row!.metadata).toMatchObject({ classSource: "manual" });

    const recorded = await corrections();
    expect(recorded).toHaveLength(eventsBefore + 1);
    expect(recorded.at(-1)!.payload).toMatchObject({
      scope: "message",
      sender: "news@example.com",
      from: { source: "jev", classHint: "newsletter" },
      to: "correspondence",
      note: "A real question inside",
    });
  });

  it("records a message answer of no class as deliberate", async () => {
    const accountId = await insertAccount();
    const messageId = await insertMessage(accountId, {
      senderAddress: "odd@example.com",
      classHint: "other",
      classSource: "jev",
    });

    const result = await service.correct(
      { requestGeneration: GENERATION },
      { messageId, scope: "message", classHint: null },
    );

    expect(result.classHint).toBeNull();
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.classHint).toBeNull();
    expect(row!.metadata).toMatchObject({ classSource: "manual" });
  });

  it("overrides a sender and re-applies the answer to that sender's mail", async () => {
    const accountId = await insertAccount();
    const seeded = await insertMessage(accountId, {
      senderAddress: "News@Example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const sameSenderOtherCase = await insertMessage(accountId, {
      senderAddress: "news@example.com",
    });
    const placedByHand = await insertMessage(accountId, {
      senderAddress: "news@example.com",
      classHint: "receipt",
      classSource: "manual",
    });
    const otherSender = await insertMessage(accountId, {
      senderAddress: "other@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const otherAccount = await insertAccount();
    const sameSenderElsewhere = await insertMessage(otherAccount, {
      senderAddress: "news@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });

    const result = await service.correct(
      { requestGeneration: GENERATION },
      {
        messageId: seeded,
        scope: "sender",
        classHint: "marketing",
        note: "Retail broadcasts",
      },
    );

    // The corrected message, the other-case copy, and nothing else: not the
    // owner's own placement, not another sender, not another account.
    expect(result).toMatchObject({ scope: "sender", sender: "News@Example.com", reapplied: 2 });

    // The row keys the address lowercase; the result and the event keep the
    // address as it stood on the corrected message.
    const [override] = await db
      .select()
      .from(senderOverrides)
      .where(eq(senderOverrides.accountId, accountId));
    expect(override!).toMatchObject({
      accountId,
      sender: "news@example.com",
      classHint: "marketing",
      note: "Retail broadcasts",
    });

    const [swept] = await db.select().from(messages).where(eq(messages.id, seeded));
    expect(swept!.classHint).toBe("marketing");
    expect(swept!.metadata).toMatchObject({ classSource: "override" });
    const [joined] = await db.select().from(messages).where(eq(messages.id, sameSenderOtherCase));
    expect(joined!.classHint).toBe("marketing");
    expect(joined!.metadata).toMatchObject({ classSource: "override" });
    const [handPlaced] = await db.select().from(messages).where(eq(messages.id, placedByHand));
    expect(handPlaced!.classHint).toBe("receipt");
    expect(handPlaced!.metadata).toMatchObject({ classSource: "manual" });
    const [untouched] = await db.select().from(messages).where(eq(messages.id, otherSender));
    expect(untouched!.classHint).toBe("newsletter");
    expect(untouched!.metadata).toMatchObject({ classSource: "jev" });
    const [elsewhere] = await db.select().from(messages).where(eq(messages.id, sameSenderElsewhere));
    expect(elsewhere!.classHint).toBe("newsletter");
    expect(elsewhere!.metadata).toMatchObject({ classSource: "jev" });
  });

  it("updates one sender override instead of stacking rows", async () => {
    const accountId = await insertAccount();
    const first = await insertMessage(accountId, {
      senderAddress: "shop@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const eventsBefore = (await corrections()).length;

    await service.correct(
      { requestGeneration: GENERATION },
      { messageId: first, scope: "sender", classHint: "marketing" },
    );
    await service.correct(
      { requestGeneration: GENERATION },
      { messageId: first, scope: "sender", classHint: "notification" },
    );

    const rows = await db
      .select()
      .from(senderOverrides)
      .where(eq(senderOverrides.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classHint).toBe("notification");
    expect((await corrections()).length).toBe(eventsBefore + 2);
  });

  it("collapses two corrections that differ only in address case", async () => {
    const accountId = await insertAccount();
    const mixedCase = await insertMessage(accountId, {
      senderAddress: "Cron@Example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const otherCase = await insertMessage(accountId, {
      senderAddress: "cron@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });

    await service.correct(
      { requestGeneration: GENERATION },
      { messageId: mixedCase, scope: "sender", classHint: "other" },
    );
    const result = await service.correct(
      { requestGeneration: GENERATION },
      { messageId: otherCase, scope: "sender", classHint: "notification" },
    );

    // One lowercase row holds the newest correction; the raw address stays
    // in the result and the audit event.
    expect(result).toMatchObject({ scope: "sender", sender: "cron@example.com", classHint: "notification" });
    const rows = await db
      .select()
      .from(senderOverrides)
      .where(eq(senderOverrides.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sender).toBe("cron@example.com");
    expect(rows[0]!.classHint).toBe("notification");
    const recorded = await corrections();
    expect(recorded.at(-1)!.payload).toMatchObject({ scope: "sender", sender: "cron@example.com" });
  });

  it("records a rule correction as the request to edit pinned code", async () => {
    const accountId = await insertAccount();
    const messageId = await insertMessage(accountId, {
      senderAddress: "bank@example.com",
      classHint: "receipt",
      classSource: "rule",
      rule: "receipt_subject",
    });
    const before = (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!;

    const result = await service.correct(
      { requestGeneration: GENERATION },
      { messageId, scope: "rule", classHint: "correspondence", note: "Bank answers my questions" },
    );

    expect(result).toMatchObject({
      scope: "rule",
      rule: "receipt_subject",
      previous: { source: "rule", classHint: "receipt" },
      reapplied: 0,
    });
    const after = (await db.select().from(messages).where(eq(messages.id, messageId)))[0]!;
    expect(after.classHint).toBe(before.classHint);
    expect(after.metadata).toEqual(before.metadata);

    const recorded = await corrections();
    expect(recorded.at(-1)!.payload).toMatchObject({
      scope: "rule",
      rule: "receipt_subject",
      to: "correspondence",
    });
    const overrides = await db
      .select()
      .from(senderOverrides)
      .where(eq(senderOverrides.accountId, accountId));
    expect(overrides).toHaveLength(0);
  });

  it("rejects a rule correction when the rules did not answer", async () => {
    const accountId = await insertAccount();
    const messageId = await insertMessage(accountId, {
      senderAddress: "person@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const eventsBefore = (await corrections()).length;
    await expect(
      service.correct({ requestGeneration: GENERATION }, { messageId, scope: "rule", classHint: "other" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect((await corrections()).length).toBe(eventsBefore);
  });

  it("rejects unusable requests without writing anything", async () => {
    const accountId = await insertAccount();
    const messageId = await insertMessage(accountId, { senderAddress: "person@example.com" });
    const eventsBefore = (await corrections()).length;

    await expect(
      service.correct({ requestGeneration: GENERATION }, { messageId: "not-a-uuid", scope: "message", classHint: "other" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    // Values outside the contract arrive untyped, the way a hand-written
    // client would send them; the service must refuse them anyway.
    const raw = (request: Record<string, unknown>) =>
      service.correct({ requestGeneration: GENERATION }, request as unknown as CorrectionRequest);
    await expect(raw({ messageId, scope: "everything", classHint: "other" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(raw({ messageId, scope: "message", classHint: "urgent" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.correct(
        { requestGeneration: GENERATION },
        { messageId, scope: "message", classHint: "other", note: "x".repeat(2_001) },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      service.correct(
        { requestGeneration: GENERATION },
        { messageId: randomUUID(), scope: "message", classHint: "other" },
      ),
    ).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
    const noSender = await insertMessage(accountId, { senderAddress: null });
    await expect(
      service.correct({ requestGeneration: GENERATION }, { messageId: noSender, scope: "sender", classHint: "other" }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect((await corrections()).length).toBe(eventsBefore);
  });

  it("runs the recovery gate before anything is read or written", async () => {
    const blocked: MutationGate = {
      async gateMutation() {
        throw new RecoveryBlockedError("recovery_required", GENERATION);
      },
    };
    const blockedService = new CorrectionService(db, blocked);
    const accountId = await insertAccount();
    const messageId = await insertMessage(accountId, { senderAddress: "person@example.com" });
    const eventsBefore = (await corrections()).length;

    await expect(
      blockedService.correct({ requestGeneration: GENERATION }, { messageId, scope: "message", classHint: "other" }),
    ).rejects.toBeInstanceOf(RecoveryBlockedError);

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.classHint).toBeNull();
    expect((await corrections()).length).toBe(eventsBefore);
  });

  it("rejects an old generation like every durable client mutation", async () => {
    const accountId = await insertAccount();
    const messageId = await insertMessage(accountId, { senderAddress: "person@example.com" });
    await expect(
      service.correct(
        { requestGeneration: "99999999-9999-4999-8999-999999999999" },
        { messageId, scope: "message", classHint: "other" },
      ),
    ).rejects.toBeInstanceOf(RecoveryBlockedError);
  });
});

describe("correction validation without a database", () => {
  it("exposes the event name the audit trail and the eval command share", () => {
    expect(CLASS_CORRECTED_EVENT).toBe("class.corrected");
    expect(new ClassificationError("not_found", "missing").httpStatus).toBe(404);
  });
});
