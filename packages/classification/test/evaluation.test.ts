import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  decisions,
  dropTestDatabase,
  events,
  messages,
  runMigrations,
  type MailHubDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";
import {
  ASKS_ACTION_BREAKOUT_CONFIDENCE,
  CLASS_CORRECTED_EVENT,
  CLASS_GATE_EVENT,
  ClassificationError,
  MINIMUM_LABELED_MESSAGES,
  evaluateClassification,
  parseClassificationLabels,
  readRoutingState,
  recordClassificationGate,
  type ClassificationLabel,
} from "../src/index.ts";

/**
 * The evaluation gate against a real PostgreSQL (SPEC section 12): label
 * parsing, the critical-false-negative model with its breakout rule,
 * coverage, correction rate per sender, and the durable routing verdict.
 * Set `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the database suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "66666666-6666-6666-8666-666666666666";

describe("label parsing", () => {
  it("reads one JSON object per line and skips blanks and comments", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const labels = parseClassificationLabels(
      `# hand labels, 2026-09-19\n` +
        `\n` +
        `{"messageId": "${id}", "class": "correspondence", "asksAction": true}\n` +
        `{"messageId": "${randomUUID()}", "class": "receipt"}\n`,
    );
    expect(labels).toEqual([
      { messageId: id, classHint: "correspondence", asksAction: true },
      { messageId: labels[1]!.messageId, classHint: "receipt" },
    ]);
  });

  it("rejects lines a person could not have meant", () => {
    const id = randomUUID();
    expect(() => parseClassificationLabels("{not json")).toThrow(ClassificationError);
    expect(() => parseClassificationLabels(`{"messageId": "${id}"}`)).toThrow(ClassificationError);
    expect(() => parseClassificationLabels(`{"messageId": "${id}", "class": "spooky"}`)).toThrow(
      ClassificationError,
    );
    expect(() => parseClassificationLabels(`{"messageId": "nope", "class": "receipt"}`)).toThrow(
      ClassificationError,
    );
    expect(() =>
      parseClassificationLabels(`{"messageId": "${id}", "class": "receipt", "urgent": true}`),
    ).toThrow(ClassificationError);
    expect(() =>
      parseClassificationLabels(`{"messageId": "${id}", "class": "receipt", "asksAction": "yes"}`),
    ).toThrow(ClassificationError);
    expect(() =>
      parseClassificationLabels(
        `{"messageId": "${id}", "class": "receipt"}\n{"messageId": "${id}", "class": "other"}`,
      ),
    ).toThrow(ClassificationError);
  });
});

suite("classification evaluation", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let controls: RecoveryControls;

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
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  /** One stored message carrying the answer the caller wants measured. */
  async function insertMessage(input: {
    senderAddress?: string | null;
    classHint?: string | null;
    classSource?: string;
    asksAction?: boolean;
    asksActionConfidence?: number;
  }): Promise<string> {
    const [account] = await db
      .insert(accounts)
      .values({
        label: `account-${randomUUID().slice(0, 8)}`,
        color: "#0f766e",
        username: "user@example.com",
        passwordEnc: "ciphertext",
      })
      .returning();
    const metadata: Record<string, unknown> =
      input.classSource === undefined ? {} : { classSource: input.classSource };
    const [message] = await db
      .insert(messages)
      .values({
        accountId: account!.id,
        subject: "Subject",
        sender:
          input.senderAddress === undefined || input.senderAddress === null
            ? null
            : { address: input.senderAddress, name: null },
        senderText: input.senderAddress ?? "",
        subjectText: "Subject",
        fetchedBody: true,
        classHint: input.classHint ?? null,
        asksAction: input.asksAction ?? null,
        metadata,
      })
      .returning();
    if (input.asksActionConfidence !== undefined) {
      await db.insert(decisions).values({
        messageId: message!.id,
        inputHash: "hash",
        model: "typesafe-ai/jev@2026-09-15",
        questionSet: "classify-1",
        answers: {},
        confidence: { asks_action: input.asksActionConfidence },
        latencyMs: 20,
      });
    }
    return message!.id;
  }

  function label(messageId: string, classHint: ClassificationLabel["classHint"], asksAction?: boolean): ClassificationLabel {
    return { messageId, classHint, ...(asksAction === undefined ? {} : { asksAction }) };
  }

  it("counts personal and action mail a bundle would bury", async () => {
    const buried = await insertMessage({
      senderAddress: "person@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const buriedMarketing = await insertMessage({
      senderAddress: "shop@example.com",
      classHint: "marketing",
      classSource: "jev",
    });
    const buriedAction = await insertMessage({
      senderAddress: "service@example.com",
      classHint: "notification",
      classSource: "jev",
    });
    const evaluation = await evaluateClassification(db, [
      label(buried, "correspondence"),
      label(buriedMarketing, "correspondence"),
      label(buriedAction, "other", true),
    ]);

    expect(evaluation.labeled).toBe(3);
    expect(evaluation.answered).toBe(3);
    expect(evaluation.coverage).toBe(1);
    expect(evaluation.bySource.jev).toBe(3);
    expect(evaluation.criticalFalseNegatives.map((miss) => miss.messageId)).toEqual([
      buried,
      buriedMarketing,
      buriedAction,
    ]);
    expect(evaluation.criticalFalseNegatives[0]).toMatchObject({
      sender: "person@example.com",
      labeledClassHint: "correspondence",
      suggestedClassHint: "newsletter",
      source: "jev",
    });
    expect(evaluation.gate.passed).toBe(false);
    expect(evaluation.gate.description).toContain("critical false negative");
  });

  it("lets the breakout rule rescue bundled action mail", async () => {
    const rescued = await insertMessage({
      senderAddress: "service@example.com",
      classHint: "notification",
      classSource: "jev",
      asksAction: true,
      asksActionConfidence: ASKS_ACTION_BREAKOUT_CONFIDENCE,
    });
    const notRescued = await insertMessage({
      senderAddress: "other-service@example.com",
      classHint: "notification",
      classSource: "jev",
      asksAction: true,
      asksActionConfidence: ASKS_ACTION_BREAKOUT_CONFIDENCE - 0.01,
    });
    const silent = await insertMessage({
      senderAddress: "quiet@example.com",
      classHint: "notification",
      classSource: "jev",
      asksAction: false,
      asksActionConfidence: 0.99,
    });
    const evaluation = await evaluateClassification(db, [
      label(rescued, "other", true),
      label(notRescued, "other", true),
      label(silent, "other", true),
    ]);

    expect(evaluation.criticalFalseNegatives.map((miss) => miss.messageId)).toEqual([notRescued, silent]);
  });

  it("keeps security alerts and unanswered mail out of the count", async () => {
    const alert = await insertMessage({
      senderAddress: "bank@example.com",
      classHint: "security_alert",
      classSource: "rule",
    });
    const unanswered = await insertMessage({ senderAddress: "person@example.com" });
    const newsletter = await insertMessage({
      senderAddress: "news@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const evaluation = await evaluateClassification(db, [
      label(alert, "correspondence"),
      label(unanswered, "correspondence"),
      label(newsletter, "newsletter"),
    ]);

    expect(evaluation.criticalFalseNegatives).toHaveLength(0);
    expect(evaluation.answered).toBe(2);
    expect(evaluation.coverage).toBeCloseTo(2 / 3, 5);
    expect(evaluation.bySource).toMatchObject({ rule: 1, jev: 1 });
  });

  it("fails on labels for mail that is not stored, instead of shrinking", async () => {
    await expect(
      evaluateClassification(db, [label(randomUUID(), "correspondence")]),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(evaluateClassification(db, [])).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("measures the correction rate per sender over the labeled set", async () => {
    const noisy = "noisy@example.com";
    const quiet = "quiet@example.com";
    const noisyMessage = await insertMessage({
      senderAddress: noisy,
      classHint: "newsletter",
      classSource: "jev",
    });
    const quietMessage = await insertMessage({
      senderAddress: quiet,
      classHint: "newsletter",
      classSource: "jev",
    });
    await db.insert(events).values([
      {
        actor: "user",
        type: CLASS_CORRECTED_EVENT,
        entityType: "message",
        entityId: noisyMessage,
        payload: { scope: "sender", sender: noisy, to: "correspondence" },
      },
      {
        actor: "user",
        type: CLASS_CORRECTED_EVENT,
        entityType: "message",
        entityId: noisyMessage,
        payload: { scope: "message", sender: noisy, to: "correspondence" },
      },
    ]);

    const evaluation = await evaluateClassification(db, [
      label(noisyMessage, "correspondence"),
      label(quietMessage, "newsletter"),
    ]);

    expect(evaluation.senders).toHaveLength(2);
    const [top] = evaluation.senders;
    expect(top).toMatchObject({ sender: noisy, labeled: 1, answered: 1, corrections: 2, rate: 2 });
    expect(evaluation.senders[1]).toMatchObject({ sender: quiet, corrections: 0, rate: 0 });
  });

  it("keeps routing off until the labeled set reaches the minimum", async () => {
    const ids: string[] = [];
    for (let index = 0; index < MINIMUM_LABELED_MESSAGES - 1; index += 1) {
      ids.push(
        await insertMessage({
          senderAddress: `sender-${index}@example.com`,
          classHint: "correspondence",
          classSource: "jev",
        }),
      );
    }
    const below = await evaluateClassification(db, ids.map((id) => label(id, "correspondence")));
    expect(below.criticalFalseNegatives).toHaveLength(0);
    expect(below.gate.passed).toBe(false);
    expect(below.gate.description).toContain(`${MINIMUM_LABELED_MESSAGES}`);

    ids.push(
      await insertMessage({
        senderAddress: "last@example.com",
        classHint: "correspondence",
        classSource: "jev",
      }),
    );
    const met = await evaluateClassification(db, ids.map((id) => label(id, "correspondence")));
    expect(met.gate.passed).toBe(true);
    expect(met.gate.routingEnabled).toBe(true);
  });

  it("records the verdict durably and lets a failing run end routing", async () => {
    const untouched = await readRoutingState(db);
    expect(untouched.routingEnabled).toBe(false);
    expect(untouched.evaluatedAt).toBeNull();

    const ids: string[] = [];
    for (let index = 0; index < MINIMUM_LABELED_MESSAGES; index += 1) {
      ids.push(
        await insertMessage({
          senderAddress: `clean-${index}@example.com`,
          classHint: "receipt",
          classSource: "rule",
        }),
      );
    }
    const passing = await evaluateClassification(db, ids.map((id) => label(id, "receipt")));
    expect(passing.gate.passed).toBe(true);
    await recordClassificationGate(db, controls, GENERATION, passing);

    const enabled = await readRoutingState(db);
    expect(enabled.routingEnabled).toBe(true);
    expect(enabled.evaluatedAt).toBeInstanceOf(Date);
    expect(enabled.counts).toMatchObject({
      labeled: MINIMUM_LABELED_MESSAGES,
      criticalFalseNegatives: 0,
    });

    const buried = await insertMessage({
      senderAddress: "person@example.com",
      classHint: "newsletter",
      classSource: "jev",
    });
    const failing = await evaluateClassification(db, [label(buried, "correspondence")]);
    await recordClassificationGate(db, controls, GENERATION, failing);

    const disabled = await readRoutingState(db);
    expect(disabled.routingEnabled).toBe(false);
    expect(disabled.description).toContain("critical false negative");

    const gate = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.type, CLASS_GATE_EVENT));
    expect(gate).toHaveLength(2);
    expect(gate.at(-1)!.payload).toMatchObject({ routing: "shadow", criticalFalseNegatives: 1 });
  });

  it("gates the verdict record like every durable write", async () => {
    const evaluation = await evaluateClassification(db, [
      label(await insertMessage({ classHint: "receipt", classSource: "rule" }), "receipt"),
    ]);
    await expect(
      recordClassificationGate(db, controls, "99999999-9999-4999-8999-999999999999", evaluation),
    ).rejects.toBeInstanceOf(RecoveryBlockedError);
  });
});
