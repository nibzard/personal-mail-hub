import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  actionItems,
  actions,
  bodies,
  createDatabase,
  decisions,
  dropTestDatabase,
  events,
  folders,
  messages,
  messageOccurrences,
  runMigrations,
  senderOverrides,
  type MailHubDatabase,
} from "@mail-hub/database";
import { RecoveryControls } from "@mail-hub/recovery";
import { SettingsService } from "@mail-hub/settings";
import {
  CIRCUIT_ERROR_THRESHOLD,
  CLASS_ERROR_EVENT,
  ClassificationService,
  JEV_MODEL,
  QUESTION_SET_VERSION,
  type JevAdapter,
  type JevDecision,
} from "../src/index.ts";
import { JevAdapterError } from "../src/adapter.ts";

/**
 * Shadow-mode classification acceptance against a real PostgreSQL (SPEC F8).
 * Set `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "44444444-4444-4444-8444-444444444444";

/** A stub adapter that records every text it was asked. */
function stubAdapter(
  overrides: Partial<JevDecision["answers"]> = {},
  failure: "none" | "timeout" = "none",
): JevAdapter & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async ask(input: { text: string }): Promise<JevDecision> {
      texts.push(input.text);
      if (failure === "timeout") {
        throw new JevAdapterError("timeout", "Jev did not answer in time.");
      }
      return {
        model: JEV_MODEL,
        answers: {
          classHint: "newsletter",
          senderRelationship: "bulk_sender",
          asksAction: false,
          asksReply: false,
          timeSensitive: false,
          ...overrides,
        },
        confidence: {
          classHint: 0.9,
          senderRelationship: null,
          asksAction: 0.75,
          asksReply: null,
          timeSensitive: null,
        },
        latencyMs: 42,
        inputTokens: 1500,
      };
    },
  };
}

suite("classification service", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let settings: SettingsService;
  let service: ClassificationService;
  let adapter: ReturnType<typeof stubAdapter>;

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

    const controls = new RecoveryControls(db, { deploymentGeneration: GENERATION });
    const outcome = await controls.initialize();
    if (outcome.result !== "initialized") {
      throw new Error(`The test database could not be initialized: ${outcome.result}.`);
    }
    settings = new SettingsService(db, controls);
    await settings.updateSettings(
      { requestGeneration: GENERATION },
      { classificationEnabled: true },
    );

    // One empty pass writes the enabled boundary the backfill gate reads, so
    // every fixture this suite inserts afterwards counts as new mail.
    adapter = stubAdapter();
    service = buildService();
    const opening = await service.runCycle();
    if (opening.skipped !== "no_candidates") {
      throw new Error(`The opening cycle did not come up clean: ${opening.skipped}.`);
    }
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  /** One classified-ready message with its stored body and ingest event. */
  async function insertMessage(input: {
    subject: string;
    senderAddress: string;
    senderName?: string | null;
    textPlain?: string;
    classifyAccount?: boolean;
    ingestedAt?: Date;
  }): Promise<{ accountId: string; messageId: string }> {
    const [account] = await db
      .insert(accounts)
      .values({
        label: `account-${randomUUID().slice(0, 8)}`,
        color: "#0f766e",
        username: "user@example.com",
        passwordEnc: "ciphertext",
        classifyEnabled: input.classifyAccount ?? true,
      })
      .returning();
    const [message] = await db
      .insert(messages)
      .values({
        accountId: account!.id,
        subject: input.subject,
        sender: { address: input.senderAddress, name: input.senderName ?? null },
        senderText: input.senderAddress,
        subjectText: input.subject,
        fetchedBody: true,
      })
      .returning();
    await db.insert(bodies).values({
      messageId: message!.id,
      textPlain: input.textPlain ?? `Body of ${input.subject}.`,
      htmlSanitized: null,
      sanitizerVersion: "test",
    });
    await db.insert(events).values({
      actor: "system",
      type: "message.ingested",
      entityType: "message",
      entityId: message!.id,
      payload: {},
      ...(input.ingestedAt === undefined ? {} : { at: input.ingestedAt }),
    });
    return { accountId: account!.id, messageId: message!.id };
  }

  function buildService(withAdapter: JevAdapter | null = adapter): ClassificationService {
    return new ClassificationService(db, { settings, adapter: withAdapter });
  }

  it("answers from the deterministic rule and spends no call", async () => {
    adapter = stubAdapter();
    service = buildService();
    const { messageId } = await insertMessage({
      subject: "Your verification code is 4821",
      senderAddress: "noreply@shop.example",
    });

    const summary = await service.runCycle();
    expect(summary.classified).toBe(1);
    expect(summary.bySource.rule).toBe(1);
    expect(adapter.texts).toHaveLength(0);

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.classHint).toBe("security_alert");
    expect(row!.metadata).toMatchObject({ classSource: "rule", rule: "security_sender_or_subject" });
    const stored = await db.select().from(decisions);
    expect(stored).toHaveLength(0);
  });

  it("lets a sender override win over rules and Jev", async () => {
    adapter = stubAdapter({ classHint: "correspondence" });
    service = buildService();
    const { accountId, messageId } = await insertMessage({
      subject: "Your verification code is 4821",
      senderAddress: "NOREPLY@shop.example",
    });
    await db.insert(senderOverrides).values({
      accountId,
      sender: "noreply@shop.example",
      classHint: "marketing",
      note: "shop broadcasts",
    });

    const summary = await service.runCycle();
    expect(summary.bySource.override).toBe(1);
    expect(adapter.texts).toHaveLength(0);
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.classHint).toBe("marketing");
    expect(row!.metadata).toMatchObject({ classSource: "override" });
  });

  it("lets a confirmed manual placement end the question", async () => {
    adapter = stubAdapter();
    service = buildService();
    const { accountId, messageId } = await insertMessage({
      subject: "Quarterly planning",
      senderAddress: "boss@work.example",
    });
    const [folder] = await db
      .insert(folders)
      .values({ accountId, name: "Archive", role: "archive" })
      .returning();
    const [occurrence] = await db
      .insert(messageOccurrences)
      .values({
        accountId,
        messageId,
        folderId: folder!.id,
        uidvalidity: 1,
        uid: 5,
        internalDate: new Date(),
      })
      .returning();
    const [action] = await db
      .insert(actions)
      .values({
        accountId,
        recoveryGeneration: GENERATION,
        idempotencyKey: `move-${randomUUID()}`,
        requestHash: "hash",
        kind: "move",
        request: {},
        status: "confirmed",
      })
      .returning();
    await db.insert(actionItems).values({
      actionId: action!.id,
      itemKey: "item-1",
      target: {
        occurrenceId: occurrence!.id,
        accountId,
        folderId: folder!.id,
        uidvalidity: 1,
        uid: 5,
        revision: 1,
      },
      status: "confirmed",
    });

    const summary = await service.runCycle();
    expect(summary.bySource.manual).toBe(1);
    expect(adapter.texts).toHaveLength(0);
    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.classHint).toBeNull();
    expect(row!.metadata).toMatchObject({ classSource: "manual" });
  });

  it("asks Jev once over minimized input and stores the raw decision", async () => {
    adapter = stubAdapter({
      classHint: "correspondence",
      senderRelationship: "known_contact",
      asksAction: true,
      asksReply: true,
      timeSensitive: true,
    });
    service = buildService();
    const { messageId } = await insertMessage({
      subject: "Contract for signature",
      senderAddress: "legal@firm.example",
      senderName: "Firm Legal",
      textPlain: "Please sign and return.\n> older clause text",
    });

    const summary = await service.runCycle();
    expect(summary.bySource.jev).toBe(1);
    expect(adapter.texts).toHaveLength(1);
    expect(adapter.texts[0]).toBe(
      "From: Firm Legal <legal@firm.example>\nSubject: Contract for signature\n\nPlease sign and return.",
    );

    const [decision] = await db.select().from(decisions);
    expect(decision!.messageId).toBe(messageId);
    expect(decision!.model).toBe(JEV_MODEL);
    expect(decision!.questionSet).toBe(QUESTION_SET_VERSION);
    expect(decision!.answers).toMatchObject({ class_hint: "correspondence", asks_action: true });
    expect(decision!.latencyMs).toBe(42);

    const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(row!.classHint).toBe("correspondence");
    expect(row!.asksAction).toBe(true);
    expect(row!.asksReply).toBe(true);
    expect(row!.timeSensitive).toBe(true);
    expect(row!.metadata).toMatchObject({ classSource: "jev", senderRelationship: "known_contact" });

    // The second cycle finds nothing pending: one answer per message.
    const again = await service.runCycle();
    expect(again.classified).toBe(0);
    expect(again.skipped).toBe("no_candidates");
  });

  it("opens the breaker after repeated failures and resumes after the cooldown", async () => {
    const failing = stubAdapter({}, "timeout");
    service = buildService(failing);
    const stuck = await insertMessage({ subject: "Failing call", senderAddress: "x@example.com" });

    for (let attempt = 0; attempt < CIRCUIT_ERROR_THRESHOLD; attempt += 1) {
      const summary = await service.runCycle();
      expect(summary.errors).toBe(1);
    }

    const open = await service.readCircuit();
    expect(open.circuit).toBe("open");
    expect(open.description).toContain("paused");

    const paused = await service.runCycle();
    expect(paused.skipped).toBe("circuit_open");
    expect(paused.classified).toBe(0);

    const failures = await db.select().from(events).where(eq(events.type, CLASS_ERROR_EVENT));
    expect(failures).toHaveLength(CIRCUIT_ERROR_THRESHOLD);

    // The burst ages out of the 10-minute trip window but stays inside the
    // 30-minute cooldown: the breaker must hold open, not silently close and
    // call the broken endpoint again.
    const lapsed = new Date(Date.now() - 15 * 60_000);
    await db.update(events).set({ at: lapsed }).where(eq(events.type, CLASS_ERROR_EVENT));
    expect((await service.readCircuit()).circuit).toBe("open");
    const held = await service.runCycle();
    expect(held.skipped).toBe("circuit_open");
    expect(failing.texts).toHaveLength(CIRCUIT_ERROR_THRESHOLD);

    // After the cooldown the breaker half-opens: attempts run again.
    const aged = new Date(Date.now() - 45 * 60_000);
    await db.update(events).set({ at: aged }).where(eq(events.type, CLASS_ERROR_EVENT));
    const recovered = await service.runCycle();
    expect(recovered.errors).toBe(1);

    // Remove the fixture so the backfill counts below stay exact.
    await db.delete(bodies).where(eq(bodies.messageId, stuck.messageId));
    await db.delete(messages).where(eq(messages.id, stuck.messageId));
  });

  it("keeps the per-message entry point behind the open breaker too", async () => {
    const failing = stubAdapter({}, "timeout");
    service = buildService(failing);
    const stuck = await insertMessage({ subject: "Per-message circuit check", senderAddress: "x@example.com" });

    for (let attempt = 0; attempt < CIRCUIT_ERROR_THRESHOLD; attempt += 1) {
      await service.runCycle();
    }
    expect((await service.readCircuit()).circuit).toBe("open");

    adapter = stubAdapter();
    service = buildService();
    const outcome = await service.classifyMessage(stuck.messageId);
    expect(outcome).toEqual({ state: "skipped", reason: "circuit_open" });
    expect(adapter.texts).toHaveLength(0);

    // Release the breaker so the suites below start from a closed circuit,
    // and remove the fixture so the backfill counts below stay exact.
    const aged = new Date(Date.now() - 45 * 60_000);
    await db.update(events).set({ at: aged }).where(eq(events.type, CLASS_ERROR_EVENT));
    await db.delete(bodies).where(eq(bodies.messageId, stuck.messageId));
    await db.delete(messages).where(eq(messages.id, stuck.messageId));
  });

  it("pauses when the monthly cost cap is reached", async () => {
    adapter = stubAdapter();
    service = buildService();
    await settings.updateSettings({ requestGeneration: GENERATION }, { classificationMonthlyCostCapUsd: 0 });

    const circuit = await service.readCircuit();
    expect(circuit.circuit).toBe("open");
    expect(circuit.description).toContain("cap");

    const summary = await service.runCycle();
    expect(summary.skipped).toBe("cost_cap");
    expect(adapter.texts).toHaveLength(0);

    await settings.updateSettings({ requestGeneration: GENERATION }, { classificationMonthlyCostCapUsd: null });
  });

  it("stays unconfigured without an adapter and disabled in settings", async () => {
    const noAdapter = buildService(null);
    expect((await noAdapter.readCircuit()).circuit).toBe("not_configured");
    expect((await noAdapter.runCycle()).skipped).toBe("not_configured");

    await settings.updateSettings({ requestGeneration: GENERATION }, { classificationEnabled: false });
    adapter = stubAdapter();
    service = buildService();
    expect((await service.readCircuit()).circuit).toBe("not_configured");
    expect((await service.runCycle()).skipped).toBe("disabled");
    await settings.updateSettings({ requestGeneration: GENERATION }, { classificationEnabled: true });
  });

  it("skips the historical backlog unless backfill classification is on", async () => {
    adapter = stubAdapter();
    service = buildService();
    await settings.updateSettings({ requestGeneration: GENERATION }, { backfillClassification: false });
    const backlog = await insertMessage({
      subject: "Old backlog message",
      senderAddress: "old@example.com",
      ingestedAt: new Date(Date.now() - 3 * 60 * 60_000),
    });

    // The enabled boundary from the re-enable above keeps the backlog out.
    const boundaryCycle = await service.runCycle();
    expect(boundaryCycle.skipped).toBe("no_candidates");

    // A message ingested after the boundary classifies even with backfill off.
    const fresh = await insertMessage({
      subject: "Fresh arrival",
      senderAddress: "fresh@example.com",
      ingestedAt: new Date(Date.now() + 60 * 60_000),
    });
    const gated = await service.runCycle();
    expect(gated.classified).toBe(1);
    const [freshRow] = await db.select().from(messages).where(eq(messages.id, fresh.messageId));
    expect(freshRow!.metadata).toMatchObject({ classSource: "jev" });
    const [backlogRow] = await db.select().from(messages).where(eq(messages.id, backlog.messageId));
    expect(backlogRow!.metadata.classSource).toBeUndefined();

    // Turning backfill on reaches the stored backlog too.
    await settings.updateSettings({ requestGeneration: GENERATION }, { backfillClassification: true });
    const backfill = await service.runCycle();
    expect(backfill.classified).toBe(1);
    const [sweptRow] = await db.select().from(messages).where(eq(messages.id, backlog.messageId));
    expect(sweptRow!.metadata).toMatchObject({ classSource: "jev" });
  });

  it("leaves a disabled account out of the sweep", async () => {
    adapter = stubAdapter();
    service = buildService();
    await insertMessage({
      subject: "No classification for this account",
      senderAddress: "off@example.com",
      classifyAccount: false,
    });
    const summary = await service.runCycle();
    expect(summary.skipped).toBe("no_candidates");
    expect(adapter.texts).toHaveLength(0);
  });
});
