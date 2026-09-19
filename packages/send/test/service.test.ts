import { mkdtemp } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SmtpSubmitReport, SmtpSubmitRequest } from "@mail-hub/contracts";
import {
  accounts as accountsTable,
  bodies as bodiesTable,
  attachments as attachmentsTable,
  createDatabase,
  createStorage,
  drafts as draftsTable,
  events,
  messages as messagesTable,
  outboundMessages,
  runMigrations,
  uploadKey,
  type MailHubDatabase,
  type Storage,
} from "@mail-hub/database";
import { SANITIZER_VERSION } from "@mail-hub/ingestion";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";
import { ComposeService } from "@mail-hub/compose";
import { OutboundService, SendError, type OutboundRecord } from "../src/index.ts";

/**
 * Outbound snapshots and SMTP sending against a real PostgreSQL and a real
 * filesystem store (SPEC F7). Set `TEST_DATABASE_URL` to a connection string
 * whose user may create databases; a throwaway database is created per run.
 * Without the variable the suite skips. SMTP is scripted at the submitter
 * port; the transport suite covers the wire itself.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";

const readyContext = { requestGeneration: GENERATION };
const staleGenerationContext = { requestGeneration: OTHER_GENERATION };

const RECIPIENTS = {
  to: [{ address: "to@example.com", name: null }],
  cc: [{ address: "cc@example.com", name: null }],
  bcc: [{ address: "bcc@example.com", name: null }],
};

const MARKDOWN = "# Quarter report\n\nThe numbers **held** this quarter.";

/** One scripted submitter with every request it received. */
function scriptedSubmitter(report: SmtpSubmitReport): {
  calls: SmtpSubmitRequest[];
  submit: (request: SmtpSubmitRequest) => Promise<SmtpSubmitReport>;
} {
  const calls: SmtpSubmitRequest[] = [];
  return {
    calls,
    submit: async (request) => {
      calls.push(request);
      return report;
    },
  };
}

function acceptedReport(responses: Map<string, string | null> = new Map()): SmtpSubmitReport {
  return {
    state: "accepted",
    response: "250 2.0.0 Ok: queued",
    responseCode: 250,
    recipients: [...responses.entries()].map(([address, response]) => ({
      address,
      accepted: response?.startsWith("250") ?? false,
      response,
    })),
    error: null,
  };
}

function rejectedReport(): SmtpSubmitReport {
  return {
    state: "rejected",
    response: "550 5.7.1 Message refused",
    responseCode: 550,
    recipients: [],
    error: { code: "EMESSAGE", message: "550 5.7.1 Message refused" },
  };
}

function unknownReport(): SmtpSubmitReport {
  return {
    state: "unknown",
    response: null,
    responseCode: null,
    recipients: [],
    error: { code: "ESOCKET", message: "connection dropped" },
  };
}

/** Convert a rejected promise into its typed error, or fail the test. */
async function rejection(promise: Promise<unknown>): Promise<SendError | RecoveryBlockedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SendError || error instanceof RecoveryBlockedError) {
      return error;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

suite("outbound snapshots and SMTP sending", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let storage: Storage;
  let compose: ComposeService;
  let controls: RecoveryControls;
  let accountId: string;

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

    storage = createStorage(await mkdtemp(join(tmpdir(), "mail-hub-send-")));
    compose = new ComposeService(db, storage, controls);

    const inserted = await db
      .insert(accountsTable)
      .values({
        label: "Main mailbox",
        color: "#2563eb",
        username: "user@example.com",
        passwordEnc: "v1.unused",
        identities: [{ address: "user@example.com", name: "Main User", isDefault: true }],
      })
      .returning({ id: accountsTable.id });
    accountId = inserted[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** One draft at revision 1, through the real compose service. */
  async function makeDraft(
    overrides: Partial<{ recipients: typeof RECIPIENTS; markdown: string; subject: string | null }> = {},
  ) {
    return compose.createDraft(readyContext, {
      accountId,
      recipients: overrides.recipients ?? RECIPIENTS,
      subject: overrides.subject ?? "One exact message",
      markdown: overrides.markdown ?? MARKDOWN,
    });
  }

  /** Queue one send of the given draft and return the stored row. */
  async function queueSendOf(draftId: string, key = randomUUID(), baseRevision = 1): Promise<OutboundRecord> {
    const result = await composeAndQueue(draftId, key, baseRevision);
    return result.outbound;
  }

  async function composeAndQueue(draftId: string, key: string, baseRevision: number) {
    const service = new OutboundService(db, storage, controls);
    return service.queueSend(readyContext, { draftId, idempotencyKey: key, baseRevision });
  }

  /** One service wired to a scripted submitter, for the execution tests. */
  function executingService(report: SmtpSubmitReport): {
    service: OutboundService;
    script: ReturnType<typeof scriptedSubmitter>;
  } {
    const script = scriptedSubmitter(report);
    return {
      script,
      service: new OutboundService(db, storage, controls, {
        submit: script.submit,
        resolveCredentials: async (id: string) => ({
          host: "smtp.example.com",
          port: 587,
          security: "starttls_required" as const,
          username: "user@example.com",
          password: "mailbox-secret",
          accountId: id,
        }),
      }),
    };
  }

  /** The outbound row as stored, with its draft. */
  async function loadRow(outboundId: string) {
    const rows = await db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)).limit(1);
    return rows[0]!;
  }

  it("freezes one snapshot, stores its bytes, and locks the draft", async () => {
    const draft = await makeDraft();
    const outbound = await queueSendOf(draft.id);

    expect(outbound.status).toBe("queued");
    expect(outbound.sentCopyStatus).toBe("pending");
    expect(outbound.rfcMessageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);

    const row = await loadRow(outbound.id);
    expect(row.draftId).toBe(draft.id);
    expect(row.draftRevision).toBe(1);
    expect(row.recoveryGeneration).toBe(GENERATION);
    expect(row.identity).toEqual({ address: "user@example.com", name: "Main User" });
    expect(row.envelopeSender).toBe("user@example.com");
    expect(row.envelopeRecipients).toEqual(["to@example.com", "cc@example.com", "bcc@example.com"]);
    expect(row.recipients.bcc).toEqual([{ address: "bcc@example.com", name: null }]);
    expect(row.markdownSource).toBe(MARKDOWN);
    expect(row.threadId).toBe(draft.threadId);

    // The stored bytes are exact and verifiable, and they never name the
    // blind-copy recipients (SPEC F7 step 2).
    const bytes = await storage.durable.get(row.mimeStorageKey);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.mimeSha256);
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).not.toContain("bcc@example.com");
    expect(text).toContain("multipart/alternative");

    const lockedDraft = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(lockedDraft.lockedBySend).toBe(outbound.id);

    const queued = await db
      .select({ type: events.type })
      .from(events)
      .where(eq(events.entityId, outbound.id));
    expect(queued.map((event) => event.type)).toContain("send.queued");
  });

  it("replays one idempotency key and refuses a changed request under it", async () => {
    const draft = await makeDraft();
    const key = randomUUID();
    const first = await composeAndQueue(draft.id, key, 1);
    const replay = await composeAndQueue(draft.id, key, 1);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.outbound.id).toBe(first.outbound.id);

    const conflict = await rejection(composeAndQueue(draft.id, key, 2));
    expect(conflict instanceof SendError && conflict.code).toBe("idempotency_conflict");
  });

  it("rejects a stale base revision with the current one", async () => {
    const draft = await makeDraft();
    const error = await rejection(composeAndQueue(draft.id, randomUUID(), 7));

    expect(error instanceof SendError && error.code).toBe("draft_stale");
    expect(error instanceof SendError && error.currentRevision).toBe(1);
  });

  it("rejects a second send while the draft is locked", async () => {
    const draft = await makeDraft();
    await queueSendOf(draft.id);
    const error = await rejection(composeAndQueue(draft.id, randomUUID(), 1));

    expect(error instanceof SendError && error.code).toBe("draft_locked");
  });

  it("requires at least one recipient", async () => {
    const draft = await makeDraft({ recipients: { to: [], cc: [], bcc: [] } });
    const error = await rejection(composeAndQueue(draft.id, randomUUID(), 1));

    expect(error instanceof SendError && error.code).toBe("recipients_required");
  });

  it("refuses to queue when a stored upload no longer matches its hash", async () => {
    const draft = await makeDraft();
    const upload = await compose.createUpload(readyContext, {
      accountId,
      filename: "notes.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("attachment bytes"),
    });
    await compose.attachUpload(readyContext, draft.id, upload.id);

    // Corrupt the durable object after the row recorded its hash.
    await storage.durable.put(uploadKey(upload.id), new TextEncoder().encode("tampered bytes"));

    const error = await rejection(composeAndQueue(draft.id, randomUUID(), 1));
    expect(error instanceof SendError && error.code).toBe("upload_unverified");
  });

  it("gates queueing on the recovery generation before the idempotency lookup", async () => {
    const draft = await makeDraft();
    const service = new OutboundService(db, storage, controls);
    const error = await rejection(
      service.queueSend(staleGenerationContext, { draftId: draft.id, idempotencyKey: randomUUID(), baseRevision: 1 }),
    );

    expect(error instanceof RecoveryBlockedError && error.code).toBe("recovery_required");
  });

  it("needs a submitter before it can execute", async () => {
    const draft = await makeDraft();
    const outbound = await queueSendOf(draft.id);
    const service = new OutboundService(db, storage, controls);
    const error = await rejection(service.executeOutbound(outbound.id));

    expect(error instanceof SendError && error.code).toBe("send_unavailable");
  });

  it("submits the stored bytes once and records the local sent copy", async () => {
    const draft = await makeDraft();
    const upload = await compose.createUpload(readyContext, {
      accountId,
      filename: "notes.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("attachment bytes"),
    });
    await compose.attachUpload(readyContext, draft.id, upload.id);

    const { service, script } = executingService(acceptedReport());
    const outbound = await queueSendOf(draft.id);
    const rowBefore = await loadRow(outbound.id);
    const stored = await storage.durable.get(rowBefore.mimeStorageKey);

    const outcome = await service.executeOutbound(outbound.id);
    expect(outcome.submitted).toBe(true);
    expect(script.calls).toHaveLength(1);

    const request = script.calls[0]!;
    expect(request.envelope.from).toBe("user@example.com");
    expect(request.envelope.to).toEqual(["to@example.com", "cc@example.com", "bcc@example.com"]);
    expect(Buffer.from(request.raw).equals(Buffer.from(stored))).toBe(true);
    expect(request.username).toBe("user@example.com");

    const row = await loadRow(outbound.id);
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
    expect(row.smtpResponse).toEqual({ response: "250 2.0.0 Ok: queued", responseCode: 250 });
    expect(row.recipientResults).toEqual([
      { address: "to@example.com", accepted: true, response: "250 2.0.0 Ok: queued" },
      { address: "cc@example.com", accepted: true, response: "250 2.0.0 Ok: queued" },
      { address: "bcc@example.com", accepted: true, response: "250 2.0.0 Ok: queued" },
    ]);

    // The local sent record: one logical message, born fetched, with its
    // body, attachment, and search text (SPEC F7 step 4).
    const message = (
      await db.select().from(messagesTable).where(eq(messagesTable.id, row.logicalMessageId!)).limit(1)
    )[0]!;
    expect(message.accountId).toBe(accountId);
    expect(message.messageId).toBe(row.rfcMessageId);
    expect(message.originalSha256).toBe(row.mimeSha256);
    expect(message.originalStorageKey).toBe(row.mimeStorageKey);
    expect(message.fetchedBody).toBe(true);
    expect(message.threadDirty).toBe(true);
    expect(message.recipients?.bcc).toEqual([{ address: "bcc@example.com", name: null }]);
    expect(message.sender).toEqual({ address: "user@example.com", name: "Main User" });

    const body = (await db.select().from(bodiesTable).where(eq(bodiesTable.messageId, message.id)).limit(1))[0]!;
    expect(body.textPlain).toBe(MARKDOWN);
    expect(body.htmlSanitized).toBe(row.html);
    expect(body.sanitizerVersion).toBe(SANITIZER_VERSION);

    const parts = await db.select().from(attachmentsTable).where(eq(attachmentsTable.messageId, message.id));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.filename).toBe("notes.txt");
    expect(parts[0]!.decodedSha256).toBe(createHash("sha256").update("attachment bytes").digest("hex"));

    const types = (
      await db.select({ type: events.type }).from(events).where(eq(events.entityId, outbound.id))
    ).map((event) => event.type);
    expect(types).toContain("send.sent");

    // A second execution of the same row never submits again.
    const again = await service.executeOutbound(outbound.id);
    expect(again.submitted).toBe(false);
    expect(again.status).toBe("sent");
    expect(script.calls).toHaveLength(1);
  });

  it("keeps partial acceptance explicit in the recorded results", async () => {
    const draft = await makeDraft();
    const { service } = executingService(
      acceptedReport(
        new Map([
          ["to@example.com", "250 2.1.5 Ok"],
          ["cc@example.com", "550 5.1.1 User unknown"],
          ["bcc@example.com", "250 2.1.5 Ok"],
        ]),
      ),
    );
    const outbound = await queueSendOf(draft.id);
    const outcome = await service.executeOutbound(outbound.id);

    expect(outcome.status).toBe("sent");
    const row = await loadRow(outbound.id);
    expect(row.recipientResults.find((result) => result.address === "cc@example.com")?.accepted).toBe(false);
    expect(row.recipientResults.find((result) => result.address === "to@example.com")?.accepted).toBe(true);
  });

  it("releases the draft after one definitive refusal", async () => {
    const draft = await makeDraft();
    const { service } = executingService(rejectedReport());
    const outbound = await queueSendOf(draft.id);
    const outcome = await service.executeOutbound(outbound.id);

    expect(outcome.status).toBe("failed");
    const row = await loadRow(outbound.id);
    expect(row.lastError).toEqual({ code: "EMESSAGE", message: "550 5.7.1 Message refused" });

    const unlocked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(unlocked.lockedBySend).toBeNull();

    const types = (
      await db.select({ type: events.type }).from(events).where(eq(events.entityId, outbound.id))
    ).map((event) => event.type);
    expect(types).toContain("send.failed");
  });

  it("keeps the draft locked after an unclassifiable outcome", async () => {
    const draft = await makeDraft();
    const { service } = executingService(unknownReport());
    const outbound = await queueSendOf(draft.id);
    const outcome = await service.executeOutbound(outbound.id);

    expect(outcome.status).toBe("outcome_unknown");
    const row = await loadRow(outbound.id);
    expect(row.lastError).toEqual({ code: "ESOCKET", message: "connection dropped" });

    const stillLocked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(stillLocked.lockedBySend).toBe(outbound.id);
  });

  it("sweeps queued rows of this generation only", async () => {
    const draft = await makeDraft();
    await queueSendOf(draft.id);

    // One row from another generation: a restored database keeps its pending
    // sends until reconciliation dispositions them.
    const foreign = await queueSendOf((await makeDraft()).id);
    await db
      .update(outboundMessages)
      .set({ recoveryGeneration: OTHER_GENERATION })
      .where(eq(outboundMessages.id, foreign.id));

    const { service } = executingService(acceptedReport());
    const summary = await service.executeQueued();

    expect(summary.blocked).toBe(false);
    expect(summary.submitted).toBeGreaterThanOrEqual(1);
    expect(summary.skippedStale).toBeGreaterThanOrEqual(1);
    expect((await loadRow(foreign.id)).status).toBe("queued");
  });
});
