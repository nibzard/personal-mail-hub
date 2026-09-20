import { mkdtemp } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
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
  folders as foldersTable,
  messages as messagesTable,
  outboundMessages,
  outboundUploads,
  runMigrations,
  uploadKey,
  type MailHubDatabase,
  type Storage,
} from "@mail-hub/database";
import { SANITIZER_VERSION } from "@mail-hub/ingestion";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";
import { ComposeService, ComposeError } from "@mail-hub/compose";
import { OutboundService, SendError, ATTEMPT_LEASE_MS, SEND_SWEEP_ATTEMPT_CAP, type OutboundRecord } from "../src/index.ts";
import { FakeSentFolder } from "./fake-sent-copy.ts";

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

/** One uncertain attempt that still recorded per-recipient statements. */
function unknownReportWithStatements(responses: Map<string, string>): SmtpSubmitReport {
  return {
    state: "unknown",
    response: null,
    responseCode: null,
    recipients: [...responses.entries()].map(([address, response]) => ({
      address,
      accepted: response.startsWith("250"),
      response,
    })),
    error: { code: "ESOCKET", message: "connection dropped after the data phase" },
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

/** The compose-service shape of the same conversion. */
async function composeRejection(promise: Promise<unknown>): Promise<ComposeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ComposeError) {
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
  let bareAccountId: string;

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
    await db.insert(foldersTable).values({ accountId, name: "Sent", role: "sent" });

    // One account without a Sent mapping, for the destination checks.
    const bare = await db
      .insert(accountsTable)
      .values({
        label: "Bare mailbox",
        color: "#16a34a",
        username: "bare@example.com",
        passwordEnc: "v1.unused",
        identities: [{ address: "bare@example.com", name: "Bare User", isDefault: true }],
      })
      .returning({ id: accountsTable.id });
    bareAccountId = bare[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** One draft at revision 1, through the real compose service. */
  async function makeDraft(
    overrides: Partial<{
      accountId: string;
      recipients: typeof RECIPIENTS;
      markdown: string;
      subject: string | null;
    }> = {},
  ) {
    return compose.createDraft(readyContext, {
      accountId: overrides.accountId ?? accountId,
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

  /**
   * One storage double that fires a hook while the freeze verifies an upload,
   * before the claim transaction opens: the window a concurrent attach or
   * detach commits through. Later calls pass straight through.
   */
  function storageWithVerifyHook(hook: () => Promise<unknown>): Storage {
    const durable = storage.durable;
    let armed = true;
    return {
      durable: {
        storageClass: durable.storageClass,
        put: (key: string, bytes: Uint8Array) => durable.put(key, bytes),
        putStream: (key: string, chunks: AsyncIterable<Uint8Array>) => durable.putStream(key, chunks),
        get: (key: string) => durable.get(key),
        createReadStream: (key: string) => durable.createReadStream(key),
        stat: (key: string) => durable.stat(key),
        verify: async (key: string, expectedSha256: string) => {
          if (armed) {
            armed = false;
            await hook();
          }
          return durable.verify(key, expectedSha256);
        },
        remove: (key: string) => durable.remove(key),
      },
      disposable: storage.disposable,
    };
  }

  /**
   * One service wired to a scripted submitter and a fake Sent folder, for the
   * append and recovery tests. Both accounts share the folder double.
   */
  function appendingService(report: SmtpSubmitReport, folder: FakeSentFolder): {
    service: OutboundService;
    script: ReturnType<typeof scriptedSubmitter>;
    folder: FakeSentFolder;
  } {
    const wired = executingService(report);
    const service = new OutboundService(db, storage, controls, {
      submit: wired.script.submit,
      resolveCredentials: async () => ({
        host: "smtp.example.com",
        port: 587,
        security: "starttls_required" as const,
        username: "user@example.com",
        password: "mailbox-secret",
      }),
      openSentCopy: async () => folder.session(),
    });
    return { service, script: wired.script, folder };
  }

  /** Queue and accept one send, returning the stored row and its bytes. */
  async function acceptedSend(
    service: OutboundService,
    options: { accountId?: string } = {},
  ): Promise<{ row: typeof outboundMessages.$inferSelect; bytes: Uint8Array }> {
    const draft = await makeDraft({ accountId: options.accountId });
    const queued = await queueSendOf(draft.id);
    await service.executeOutbound(queued.id);
    const row = await loadRow(queued.id);
    expect(row.status).toBe("sent");
    return { row, bytes: await storage.durable.get(row.mimeStorageKey) };
  }

  /** The event types recorded for one outbound row. */
  async function eventTypesOf(outboundId: string): Promise<string[]> {
    const rows = await db.select({ type: events.type }).from(events).where(eq(events.entityId, outboundId));
    return rows.map((event) => event.type);
  }

  /** The outbound row as stored, with its draft. */
  async function loadRow(outboundId: string) {
    const rows = await db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)).limit(1);
    return rows[0]!;
  }

  /**
   * One fresh account with no Sent-folder mapping. Earlier tests may map Sent
   * for the shared accounts, so a test of the unmapped path mints its own.
   */
  async function unmappedAccount(): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const inserted = await db
      .insert(accountsTable)
      .values({
        label: `Unmapped ${suffix}`,
        color: "#dc2626",
        username: `unmapped-${suffix}@example.com`,
        passwordEnc: "v1.unused",
        identities: [
          { address: `unmapped-${suffix}@example.com`, name: "Unmapped User", isDefault: true },
        ],
      })
      .returning({ id: accountsTable.id });
    return inserted[0]!.id;
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

  it("counts a changed attachment set under one key as a changed request", async () => {
    const draft = await makeDraft();
    const key = randomUUID();
    const first = await composeAndQueue(draft.id, key, 1);
    expect(first.created).toBe(true);

    // A definitive failure unlocks the draft for editing again, and attach
    // moves no revision: without the file set in the request hash, a reused
    // key would replay the old failed snapshot as if nothing changed.
    const { service } = executingService(rejectedReport());
    await service.executeOutbound(first.outbound.id);
    expect((await loadRow(first.outbound.id)).status).toBe("failed");

    const unchanged = await composeAndQueue(draft.id, key, 1);
    expect(unchanged.created).toBe(false);
    expect(unchanged.outbound.id).toBe(first.outbound.id);

    const upload = await compose.createUpload(readyContext, {
      accountId,
      filename: "late.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("late bytes"),
    });
    await compose.attachUpload(readyContext, draft.id, upload.id);

    const conflict = await rejection(composeAndQueue(draft.id, key, 1));
    expect(conflict instanceof SendError && conflict.code).toBe("idempotency_conflict");

    // A fresh key freezes the new file set and carries it into the snapshot.
    const second = await composeAndQueue(draft.id, randomUUID(), 1);
    expect(second.created).toBe(true);
    const links = await db
      .select({ uploadId: outboundUploads.uploadId })
      .from(outboundUploads)
      .where(eq(outboundUploads.outboundId, second.outbound.id));
    expect(links).toEqual([{ uploadId: upload.id }]);
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

  it("refuses to freeze when a concurrent attach changes the draft's files", async () => {
    const draft = await makeDraft();
    const first = await compose.createUpload(readyContext, {
      accountId,
      filename: "first.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("first bytes"),
    });
    const second = await compose.createUpload(readyContext, {
      accountId,
      filename: "second.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("second bytes"),
    });
    await compose.attachUpload(readyContext, draft.id, first.id);

    // The attach lands between the unlocked attachment read and the freeze
    // transaction. It moves no revision, so only the link re-check inside
    // the claim transaction can catch it.
    const raced = new OutboundService(
      db,
      storageWithVerifyHook(() => compose.attachUpload(readyContext, draft.id, second.id)),
      controls,
    );
    const error = await rejection(
      raced.queueSend(readyContext, { draftId: draft.id, idempotencyKey: randomUUID(), baseRevision: 1 }),
    );
    expect(error instanceof SendError && error.code).toBe("draft_stale");

    // Nothing queued, nothing locked, and the draft never moved.
    expect(
      await db.select().from(outboundMessages).where(eq(outboundMessages.draftId, draft.id)),
    ).toHaveLength(0);
    const draftRow = (await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)))[0]!;
    expect(draftRow.lockedBySend).toBeNull();
    expect(draftRow.revision).toBe(1);

    // The retry freezes exactly the files the draft now names.
    const retry = await queueSendOf(draft.id);
    expect(
      await db.select().from(outboundUploads).where(eq(outboundUploads.outboundId, retry.id)),
    ).toHaveLength(2);
  });

  it("refuses to freeze when a concurrent detach changes the draft's files", async () => {
    const draft = await makeDraft();
    const upload = await compose.createUpload(readyContext, {
      accountId,
      filename: "only.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("only bytes"),
    });
    await compose.attachUpload(readyContext, draft.id, upload.id);

    const raced = new OutboundService(
      db,
      storageWithVerifyHook(() => compose.detachUpload(readyContext, draft.id, upload.id)),
      controls,
    );
    const error = await rejection(
      raced.queueSend(readyContext, { draftId: draft.id, idempotencyKey: randomUUID(), baseRevision: 1 }),
    );
    expect(error instanceof SendError && error.code).toBe("draft_stale");

    expect(
      await db.select().from(outboundMessages).where(eq(outboundMessages.draftId, draft.id)),
    ).toHaveLength(0);
    const draftRow = (await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)))[0]!;
    expect(draftRow.lockedBySend).toBeNull();
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

  it("fails an attempt whose stored bytes left durable storage, and frees the draft", async () => {
    const draft = await makeDraft();
    const { service, script } = executingService(acceptedReport());
    const outbound = await queueSendOf(draft.id);
    await storage.durable.remove((await loadRow(outbound.id)).mimeStorageKey);

    const outcome = await service.executeOutbound(outbound.id);
    expect(outcome.status).toBe("failed");
    const row = await loadRow(outbound.id);
    expect(row.lastError).toEqual({
      code: "mime_missing",
      message: "The stored MIME bytes could not be read; nothing was submitted.",
    });
    // SMTP never opened, so no recipient holds a recorded verdict.
    expect(row.recipientResults).toEqual([]);
    expect(row.smtpResponse).toBeNull();
    expect(script.calls).toHaveLength(0);
    expect(await eventTypesOf(outbound.id)).toContain("send.failed");

    // Nothing was submitted, so the outcome is definitive and the draft
    // returns to editing instead of staying wedged as unknown.
    const unlocked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(unlocked.lockedBySend).toBeNull();
    const edited = await compose.updateDraft(readyContext, draft.id, {
      baseRevision: 1,
      markdown: "# Edited after the local failure\n\nThe draft was never wedged.",
    });
    expect(edited.revision).toBe(2);
  });

  it("fails an attempt whose stored bytes no longer match their hash", async () => {
    const draft = await makeDraft();
    const { service, script } = executingService(acceptedReport());
    const outbound = await queueSendOf(draft.id);
    await storage.durable.put((await loadRow(outbound.id)).mimeStorageKey, new TextEncoder().encode("tampered"));

    const outcome = await service.executeOutbound(outbound.id);
    expect(outcome.status).toBe("failed");
    expect((await loadRow(outbound.id)).lastError).toEqual({
      code: "mime_mismatch",
      message: "The stored MIME bytes no longer match their recorded hash; nothing was submitted.",
    });
    expect(script.calls).toHaveLength(0);
    const unlocked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(unlocked.lockedBySend).toBeNull();
  });

  it("fails an attempt with unresolvable credentials and frees the draft", async () => {
    const draft = await makeDraft();
    const script = scriptedSubmitter(acceptedReport());
    const service = new OutboundService(db, storage, controls, {
      submit: script.submit,
      resolveCredentials: async () => {
        throw new Error("No SMTP password is stored for this account.\nThe rest stays off the record.");
      },
    });
    const outbound = await queueSendOf(draft.id);
    const outcome = await service.executeOutbound(outbound.id);

    expect(outcome.status).toBe("failed");
    const row = await loadRow(outbound.id);
    expect(row.lastError).toEqual({
      code: "credentials_unavailable",
      message: "No SMTP password is stored for this account.",
    });
    expect(script.calls).toHaveLength(0);
    expect(await eventTypesOf(outbound.id)).toContain("send.failed");

    // A wrong password must not wedge the draft: it unlocks, the settings
    // get fixed, and the edited draft queues again under a new key.
    const unlocked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(unlocked.lockedBySend).toBeNull();
    const edited = await compose.updateDraft(readyContext, draft.id, {
      baseRevision: 1,
      markdown: "# Edited after the password was fixed",
    });
    const retry = await queueSendOf(edited.id, randomUUID(), edited.revision);
    expect(retry.status).toBe("queued");
  });

  it("ends the draft lock on acceptance, so a sent draft is deletable", async () => {
    const draft = await makeDraft();
    const upload = await compose.createUpload(readyContext, {
      accountId,
      filename: "kept.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("kept bytes"),
    });
    await compose.attachUpload(readyContext, draft.id, upload.id);

    const { service } = executingService(acceptedReport());
    const outbound = await queueSendOf(draft.id);
    const outcome = await service.executeOutbound(outbound.id);
    expect(outcome.status).toBe("sent");

    const released = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(released.lockedBySend).toBeNull();

    // The sent snapshot is the record; the draft can be discarded, and the
    // outbound references keep its file alive (SPEC F6).
    await compose.deleteDraft(readyContext, draft.id);
    const deleted = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(deleted.deletedAt).not.toBeNull();
    const kept = await loadRow(outbound.id);
    expect(kept.status).toBe("sent");
    expect(kept.draftId).toBe(draft.id);
    expect(await storage.durable.stat(uploadKey(upload.id))).not.toBeNull();
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

  it("needs a Sent-copy session before it can append", async () => {
    const draft = await makeDraft();
    const outbound = await queueSendOf(draft.id);
    const { service: submitOnly } = executingService(acceptedReport());
    await submitOnly.executeOutbound(outbound.id);

    const error = await rejection(submitOnly.executeSentCopyAppend(outbound.id));
    expect(error instanceof SendError && error.code).toBe("sent_copy_unavailable");
  });

  it("appends the stored bytes once and records the destination", async () => {
    const { service, script, folder } = appendingService(acceptedReport(), new FakeSentFolder("Sent"));
    const { row, bytes } = await acceptedSend(service);

    const summary = await service.appendDueSentCopies(100);
    expect(summary.blocked).toBe(false);
    expect(summary.attempted).toBeGreaterThanOrEqual(1);

    // The sweep also stores due rows from earlier tests, so the pass runs
    // with headroom above the default batch; this row's own append is what
    // matters here.
    expect(folder.appendsOf(row.rfcMessageId)).toBe(1);
    const attempt = folder.appends.find((entry) => entry.rfcMessageId === row.rfcMessageId)!;
    expect(attempt.folder).toBe("Sent");
    expect(Buffer.from(attempt.bytes).equals(Buffer.from(bytes))).toBe(true);

    const stored = await loadRow(row.id);
    expect(stored.status).toBe("sent");
    expect(stored.sentCopyStatus).toBe("stored");
    expect(stored.sentFolderId).toBe((await sentFolderOf(row.accountId))!.id);
    expect(stored.sentUidvalidity).toBe(1);
    expect(stored.sentUid).toBe(folder.uidOf(row.rfcMessageId));
    expect(stored.lastError).toBeNull();
    expect(await eventTypesOf(row.id)).toContain("send.sent_copy_stored");

    // A stored copy is done; no sweep appends it again, and SMTP saw exactly
    // one submission the whole time.
    const again = await service.appendDueSentCopies();
    expect(again.scanned).toBe(0);
    expect(folder.appendsOf(row.rfcMessageId)).toBe(1);
    expect(script.calls).toHaveLength(1);
  });

  it("keeps sent status after a refused append and retries only the append", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service, script } = appendingService(acceptedReport(), folder);
    const { row } = await acceptedSend(service);

    folder.scriptedAppend = { result: "rejected" };
    await service.appendDueSentCopies();

    const failed = await loadRow(row.id);
    expect(failed.status).toBe("sent");
    expect(failed.sentCopyStatus).toBe("failed");
    expect(failed.lastError).toEqual({
      code: "append_rejected",
      message: "The server refused the Sent append; the sent state is unchanged.",
    });
    expect(await eventTypesOf(row.id)).toContain("send.sent_copy_failed");

    folder.scriptedAppend = null;
    await service.appendDueSentCopies();
    const stored = await loadRow(row.id);
    expect(stored.sentCopyStatus).toBe("stored");
    expect(folder.appendsOf(row.rfcMessageId)).toBe(2);
    // The append job never opened SMTP (SPEC F7 step 5).
    expect(script.calls).toHaveLength(1);
  });

  it("holds a lost append response as unknown and stores it only after reconciliation", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row, bytes } = await acceptedSend(service);

    folder.scriptedAppend = { result: "uncertain", reason: "connection dropped" };
    await service.appendDueSentCopies();

    const held = await loadRow(row.id);
    expect(held.sentCopyStatus).toBe("unknown");
    expect((held.lastError as { code: string }).code).toBe("append_uncertain");
    expect(await eventTypesOf(row.id)).toContain("send.sent_copy_unknown");

    // The lost attempt actually landed. The next sweep must verify that copy
    // instead of appending a second one.
    folder.scriptedAppend = null;
    folder.load(row.rfcMessageId, bytes);
    await service.appendDueSentCopies();

    const stored = await loadRow(row.id);
    expect(stored.sentCopyStatus).toBe("stored");
    expect(stored.sentUid).toBe(1);
    expect(folder.appendsOf(row.rfcMessageId)).toBe(1);
  });

  it("does not append when the folder already holds the verified copy", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row, bytes } = await acceptedSend(service);

    // A Sent import raced the append job and stored the copy first.
    folder.load(row.rfcMessageId, bytes);
    await service.appendDueSentCopies();

    const stored = await loadRow(row.id);
    expect(stored.sentCopyStatus).toBe("stored");
    expect(stored.sentUid).toBe(1);
    expect(folder.appendsOf(row.rfcMessageId)).toBe(0);
  });

  it("retains unknown when a same-identifier message holds different bytes", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row } = await acceptedSend(service);

    folder.load(row.rfcMessageId, new TextEncoder().encode("different bytes with the same identifier"));
    await service.appendDueSentCopies();
    await service.appendDueSentCopies();

    const held = await loadRow(row.id);
    expect(held.sentCopyStatus).toBe("unknown");
    expect((held.lastError as { code: string }).code).toBe("sent_copy_conflict");
    expect(folder.appendsOf(row.rfcMessageId)).toBe(0);
  });

  it("fails quietly while the account maps no Sent folder, and stores after mapping one", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row } = await acceptedSend(service, { accountId: bareAccountId });

    const first = await service.appendDueSentCopies();
    expect(first.attempted).toBeGreaterThanOrEqual(1);
    let failed = await loadRow(row.id);
    expect(failed.sentCopyStatus).toBe("failed");
    expect((failed.lastError as { code: string }).code).toBe("sent_folder_unmapped");

    // Repeated sweeps change nothing and record nothing further.
    const second = await service.appendDueSentCopies();
    expect(second.attempted).toBe(0);
    failed = await loadRow(row.id);
    expect(failed.sentCopyStatus).toBe("failed");
    expect((await eventTypesOf(row.id)).filter((type) => type === "send.sent_copy_failed")).toHaveLength(1);

    await db.insert(foldersTable).values({ accountId: bareAccountId, name: "Sent", role: "sent" });
    await service.appendDueSentCopies();
    const stored = await loadRow(row.id);
    expect(stored.sentCopyStatus).toBe("stored");
    expect(folder.appendsOf(row.rfcMessageId)).toBe(1);
  });

  it("holds an abandoned submission as unknown and never resubmits it", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service, script } = appendingService(acceptedReport(), folder);
    const draft = await makeDraft();
    const outbound = await queueSendOf(draft.id);

    // A crash left the row mid-submission: claimed with an expired lease and
    // no outcome recorded.
    await db
      .update(outboundMessages)
      .set({
        status: "sending",
        sendingStartedAt: new Date(Date.now() - ATTEMPT_LEASE_MS - 1000),
      })
      .where(eq(outboundMessages.id, outbound.id));

    const recovered = await service.recoverAbandonedAttempts();
    expect(recovered.blocked).toBe(false);
    expect(recovered.heldSends).toBe(1);

    const held = await loadRow(outbound.id);
    expect(held.status).toBe("outcome_unknown");
    expect((held.lastError as { code: string }).code).toBe("sending_abandoned");
    expect(await eventTypesOf(outbound.id)).toContain("send.outcome_unknown");

    const stillLocked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(stillLocked.lockedBySend).toBe(outbound.id);

    // No path resubmits an uncertain attempt (SPEC F7 step 6).
    const sweep = await service.executeQueued();
    expect(sweep.submitted).toBe(0);
    const direct = await service.executeOutbound(outbound.id);
    expect(direct.submitted).toBe(false);
    const copies = await service.appendDueSentCopies();
    expect(copies.scanned).toBe(0);
    expect(script.calls).toHaveLength(0);
  });

  it("holds an abandoned append as unknown and reconciles it on the next sweep", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row, bytes } = await acceptedSend(service);

    await db
      .update(outboundMessages)
      .set({
        sentCopyStatus: "appending",
        appendStartedAt: new Date(Date.now() - ATTEMPT_LEASE_MS - 1000),
      })
      .where(eq(outboundMessages.id, row.id));

    const recovered = await service.recoverAbandonedAttempts();
    expect(recovered.heldAppends).toBe(1);
    const held = await loadRow(row.id);
    expect(held.sentCopyStatus).toBe("unknown");
    expect((held.lastError as { code: string }).code).toBe("append_abandoned");

    // The abandoned append did land; the sweep must verify it, not repeat it.
    folder.load(row.rfcMessageId, bytes);
    await service.appendDueSentCopies();
    const stored = await loadRow(row.id);
    expect(stored.sentCopyStatus).toBe("stored");
    expect(folder.appendsOf(row.rfcMessageId)).toBe(0);
  });

  it("keeps a live in-flight submission safe from a concurrent recovery pass", async () => {
    const folder = new FakeSentFolder("Sent");
    let release!: (report: SmtpSubmitReport) => void;
    let entered = false;
    const gated = new Promise<SmtpSubmitReport>((resolve) => {
      release = resolve;
    });
    const service = new OutboundService(db, storage, controls, {
      submit: async () => {
        entered = true;
        return gated;
      },
      resolveCredentials: async () => ({
        host: "smtp.example.com",
        port: 587,
        security: "starttls_required" as const,
        username: "user@example.com",
        password: "mailbox-secret",
      }),
      openSentCopy: async () => folder.session(),
    });
    const draft = await makeDraft();
    const outbound = await queueSendOf(draft.id);

    // Hold the attempt open after its claim: the row is `sending` and the
    // SMTP conversation is still running.
    const inFlight = service.executeOutbound(outbound.id);
    for (let guard = 0; !entered && guard < 500; guard += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(entered).toBe(true);
    expect((await loadRow(outbound.id)).status).toBe("sending");

    // A second worker's recovery pass must leave the leased attempt alone.
    const recovered = await service.recoverAbandonedAttempts();
    expect(recovered.heldSends).toBe(0);
    expect((await loadRow(outbound.id)).status).toBe("sending");

    // The live worker's own commit still wins after the pass went by.
    release(acceptedReport());
    const done = await inFlight;
    expect(done.submitted).toBe(true);
    expect((await loadRow(outbound.id)).status).toBe("sent");
    const draftRow = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(draftRow.lockedBySend).toBeNull();
  });

  it("rolls a late acceptance back when a lease-aged hold already took the row", async () => {
    const folder = new FakeSentFolder("Sent");
    const draft = await makeDraft();
    const outbound = await queueSendOf(draft.id);
    const script = scriptedSubmitter(acceptedReport());
    let held = false;
    const service = new OutboundService(db, storage, controls, {
      submit: async (request) => {
        script.calls.push(request);
        if (!held) {
          held = true;
          // The submission outlived its lease: recovery already held the row
          // as unknown while SMTP was still talking.
          await db
            .update(outboundMessages)
            .set({
              status: "outcome_unknown",
              lastError: {
                code: "sending_abandoned",
                message:
                  "The submission attempt recorded no outcome before the process stopped; nothing was resubmitted.",
              },
            })
            .where(and(eq(outboundMessages.id, outbound.id), eq(outboundMessages.status, "sending")));
        }
        return acceptedReport();
      },
      resolveCredentials: async () => ({
        host: "smtp.example.com",
        port: 587,
        security: "starttls_required" as const,
        username: "user@example.com",
        password: "mailbox-secret",
      }),
      openSentCopy: async () => folder.session(),
    });

    const outcome = await service.executeOutbound(outbound.id);
    expect(outcome.submitted).toBe(true);
    // The caller reads the state that actually holds, not a phantom sent.
    expect(outcome.status).toBe("outcome_unknown");

    // No part of the acceptance committed: no sent event, no local sent
    // record, and the draft keeps the lock only the transition releases.
    const row = await loadRow(outbound.id);
    expect(row.status).toBe("outcome_unknown");
    expect(row.logicalMessageId).toBeNull();
    expect(row.sentAt).toBeNull();
    expect((await eventTypesOf(outbound.id)).filter((type) => type === "send.sent")).toHaveLength(0);
    expect(
      await db.select().from(messagesTable).where(eq(messagesTable.messageId, row.rfcMessageId)),
    ).toHaveLength(0);
    const locked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(locked.lockedBySend).toBe(outbound.id);

    // The evidence path stays open: the accepted submission's own copy
    // resolves the held row through the same acceptance transaction.
    folder.load(row.rfcMessageId, await storage.durable.get(row.mimeStorageKey));
    const reconciled = await service.reconcileUnknownOutcomes(100);
    expect(reconciled.resolved).toBeGreaterThanOrEqual(1);
    const resolved = await loadRow(outbound.id);
    expect(resolved.status).toBe("sent");
    expect((await eventTypesOf(outbound.id)).filter((type) => type === "send.sent")).toHaveLength(1);
    expect(script.calls).toHaveLength(1);
  });

  it("contains one poisoned row and keeps the sweep moving", async () => {
    const folder = new FakeSentFolder("Sent");
    // The poisoned row is the older one; the sweep must reach the younger
    // row in the same pass instead of aborting on the first.
    const poisoned = await queueSendOf((await makeDraft({ subject: "Poisoned first" })).id);
    const healthy = await queueSendOf((await makeDraft({ subject: "Healthy second" })).id);

    let poisonedOnce = false;
    const script = scriptedSubmitter(acceptedReport());
    const service = new OutboundService(db, storage, controls, {
      submit: async (request) => {
        script.calls.push(request);
        if (!poisonedOnce) {
          poisonedOnce = true;
          // The claimed row was flipped before the refusal could record —
          // the unlock then refuses, exactly like the poisoned row the
          // defect describes.
          await db
            .update(outboundMessages)
            .set({ status: "outcome_unknown" })
            .where(eq(outboundMessages.id, poisoned.id));
          return rejectedReport();
        }
        return acceptedReport();
      },
      resolveCredentials: async () => ({
        host: "smtp.example.com",
        port: 587,
        security: "starttls_required" as const,
        username: "user@example.com",
        password: "mailbox-secret",
      }),
      openSentCopy: async () => folder.session(),
    });

    const summary = await service.executeQueued();
    expect(summary.rowErrors).toBe(1);
    expect(summary.submitted).toBe(1);
    expect((await loadRow(poisoned.id)).status).toBe("outcome_unknown");
    expect((await loadRow(healthy.id)).status).toBe("sent");
  });

  it("resolves an unknown send from a verified Sent copy in one transaction", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service, script } = appendingService(unknownReport(), folder);
    const draft = await makeDraft();
    const queued = await queueSendOf(draft.id);
    await service.executeOutbound(queued.id);
    const unknownRow = await loadRow(queued.id);
    expect(unknownRow.status).toBe("outcome_unknown");
    expect(unknownRow.logicalMessageId).toBeNull();

    // Durable server evidence: the server stored the exact submitted bytes.
    folder.load(unknownRow.rfcMessageId, await storage.durable.get(unknownRow.mimeStorageKey));

    const summary = await service.reconcileUnknownOutcomes();
    expect(summary.resolved).toBe(1);

    const resolved = await loadRow(queued.id);
    expect(resolved.status).toBe("sent");
    expect(resolved.sentCopyStatus).toBe("stored");
    expect(resolved.sentUid).toBe(1);
    expect(resolved.lastError).toBeNull();

    // The pre-send results held `accepted: false` for every recipient,
    // because the attempt recorded no per-recipient detail. The verified
    // copy proves the submission was accepted, so the honest results cover
    // the whole envelope instead of contradicting the sent state.
    expect(resolved.recipientResults).toEqual([
      { address: "to@example.com", accepted: true, response: null },
      { address: "cc@example.com", accepted: true, response: null },
      { address: "bcc@example.com", accepted: true, response: null },
    ]);

    const message = (
      await db.select().from(messagesTable).where(eq(messagesTable.id, resolved.logicalMessageId!)).limit(1)
    )[0]!;
    expect(message.originalSha256).toBe(resolved.mimeSha256);
    expect(message.fetchedBody).toBe(true);
    expect(await db.select().from(bodiesTable).where(eq(bodiesTable.messageId, message.id))).toHaveLength(1);

    const sentEvents = (await eventTypesOf(queued.id)).filter((type) => type === "send.sent");
    expect(sentEvents).toHaveLength(1);

    // Resolution is evidence work, not a resend.
    expect(script.calls).toHaveLength(1);
  });

  it("keeps an unknown send unknown without evidence", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(unknownReport(), folder);
    const draft = await makeDraft();
    const queued = await queueSendOf(draft.id);
    await service.executeOutbound(queued.id);

    const summary = await service.reconcileUnknownOutcomes();
    expect(summary.resolved).toBe(0);

    const held = await loadRow(queued.id);
    expect(held.status).toBe("outcome_unknown");
    expect(held.logicalMessageId).toBeNull();
    expect((await eventTypesOf(queued.id)).filter((type) => type === "send.sent")).toHaveLength(0);
    expect(
      await db.select().from(messagesTable).where(eq(messagesTable.messageId, held.rfcMessageId)),
    ).toHaveLength(0);
  });

  it("keeps a definitive per-recipient statement when reconciliation proves acceptance", async () => {
    const folder = new FakeSentFolder("Sent");
    const report = unknownReportWithStatements(
      new Map([
        ["to@example.com", "250 recipient ok"],
        ["cc@example.com", "550 no such user"],
      ]),
    );
    const { service, script } = appendingService(report, folder);
    const draft = await makeDraft();
    const queued = await queueSendOf(draft.id);
    await service.executeOutbound(queued.id);

    const unknownRow = await loadRow(queued.id);
    expect(unknownRow.recipientResults).toEqual([
      { address: "to@example.com", accepted: true, response: "250 recipient ok" },
      { address: "cc@example.com", accepted: false, response: "550 no such user" },
      { address: "bcc@example.com", accepted: false, response: null },
    ]);

    folder.load(unknownRow.rfcMessageId, await storage.durable.get(unknownRow.mimeStorageKey));
    const summary = await service.reconcileUnknownOutcomes();
    expect(summary.resolved).toBe(1);

    // The server's own rejection of one recipient survives the evidence;
    // the recipient without a statement joins the proved acceptance.
    const resolved = await loadRow(queued.id);
    expect(resolved.recipientResults).toEqual([
      { address: "to@example.com", accepted: true, response: "250 recipient ok" },
      { address: "cc@example.com", accepted: false, response: "550 no such user" },
      { address: "bcc@example.com", accepted: true, response: null },
    ]);
    expect(script.calls).toHaveLength(1);
  });

  it("preserves a recorded unknown when the account maps no Sent folder", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(unknownReport(), folder);
    // An account of its own: earlier tests may have mapped Sent for the
    // shared bare account, and this test needs the mapping genuinely absent.
    const unmapped = await unmappedAccount();
    const draft = await makeDraft({ accountId: unmapped });
    const queued = await queueSendOf(draft.id);
    await service.executeOutbound(queued.id);
    expect((await loadRow(queued.id)).status).toBe("outcome_unknown");

    // A missing mapping answers nothing about the uncertain attempt; the
    // recorded reason stays for review instead of being overwritten.
    const summary = await service.reconcileUnknownOutcomes();
    expect(summary.resolved).toBe(0);
    const held = await loadRow(queued.id);
    expect(held.status).toBe("outcome_unknown");
    expect((held.lastError as { code: string }).code).toBe("ESOCKET");
  });

  it("keeps a recorded append unknown when the Sent folder is unmapped", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row } = await acceptedSend(service, { accountId: await unmappedAccount() });

    // The append attempt ended uncertain before the mapping went missing.
    await db
      .update(outboundMessages)
      .set({
        sentCopyStatus: "unknown",
        lastError: { code: "append_uncertain", message: "The Sent append response was lost." },
      })
      .where(eq(outboundMessages.id, row.id));

    const outcome = await service.executeSentCopyAppend(row.id);
    expect(outcome.attempted).toBe(false);
    const held = await loadRow(row.id);
    expect(held.sentCopyStatus).toBe("unknown");
    expect((held.lastError as { code: string }).code).toBe("append_uncertain");
    expect(folder.appendsOf(row.rfcMessageId)).toBe(0);
    // The unmapped answer recorded nothing over the unknown it found.
    expect((await eventTypesOf(row.id)).filter((type) => type === "send.sent_copy_failed")).toHaveLength(0);
  });

  it("keeps an unmapped unknown out of the append window and re-dues it on mapping", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row: stuck } = await acceptedSend(service, { accountId: await unmappedAccount() });

    // The append attempt ended uncertain while the mapping existed. Both rows
    // are backdated, so the window order is theirs alone whatever earlier
    // tests left due.
    await db
      .update(outboundMessages)
      .set({
        sentCopyStatus: "unknown",
        lastError: { code: "append_uncertain", message: "The Sent append response was lost." },
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      })
      .where(eq(outboundMessages.id, stuck.id));
    const { row: young } = await acceptedSend(service);
    await db
      .update(outboundMessages)
      .set({ createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(outboundMessages.id, young.id));

    // One window slot: the unmapped unknown may not fill it — the sweep can
    // make no progress on that row — so the younger copy stores instead.
    const windowed = await service.appendDueSentCopies(1);
    expect(windowed.scanned).toBe(1);
    expect(windowed.attempted).toBe(1);
    expect((await loadRow(stuck.id)).sentCopyStatus).toBe("unknown");
    expect((await loadRow(young.id)).sentCopyStatus).toBe("stored");
    expect(folder.appendsOf(stuck.rfcMessageId)).toBe(0);
    expect(folder.appendsOf(young.rfcMessageId)).toBe(1);

    // A fresh mapping makes the row due again the moment it exists.
    await db.insert(foldersTable).values({ accountId: stuck.accountId, name: "Sent", role: "sent" });
    await service.appendDueSentCopies(100);
    const stored = await loadRow(stuck.id);
    expect(stored.sentCopyStatus).toBe("stored");
    expect(folder.appendsOf(stuck.rfcMessageId)).toBe(1);
  });

  it("issues the deliberate resend copy of an unknown send without resubmitting it", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service, script } = appendingService(unknownReport(), folder);
    const draft = await makeDraft();
    const upload = await compose.createUpload(readyContext, {
      accountId,
      filename: "notes.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("attachment bytes"),
    });
    await compose.attachUpload(readyContext, draft.id, upload.id);
    const queued = await queueSendOf(draft.id);
    await service.executeOutbound(queued.id);
    expect((await loadRow(queued.id)).status).toBe("outcome_unknown");

    const copy = await compose.createResendDraft(readyContext, queued.id);
    expect(copy.id).not.toBe(draft.id);
    expect(copy.accountId).toBe(accountId);
    expect(copy.identity).toEqual({ address: "user@example.com", name: "Main User" });
    expect(copy.recipients).toEqual(RECIPIENTS);
    expect(copy.subject).toBe("One exact message");
    expect(copy.markdown).toBe(MARKDOWN);
    expect(copy.revision).toBe(1);
    expect(copy.lockedBySend).toBeNull();

    // The copy carries the frozen attachment links in their order.
    expect(await compose.listDraftAttachments(copy.id)).toEqual([
      expect.objectContaining({ id: upload.id, filename: "notes.txt", ordinal: 0 }),
    ]);

    // The uncertain attempt keeps its lock and its record; nothing resent.
    const original = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(original.lockedBySend).toBe(queued.id);
    expect((await loadRow(queued.id)).status).toBe("outcome_unknown");
    expect(script.calls).toHaveLength(1);
    expect(await eventTypesOf(copy.id)).toContain("draft.resend_created");
  });

  it("offers the resend copy only for an unresolved send", async () => {
    const folder = new FakeSentFolder("Sent");
    const accepted = appendingService(acceptedReport(), folder);
    const sent = await acceptedSend(accepted.service);
    expect(
      (await composeRejection(compose.createResendDraft(readyContext, sent.row.id))).code,
    ).toBe("invalid_request");

    const failed = executingService(rejectedReport());
    const draft = await makeDraft();
    const outbound = await queueSendOf(draft.id);
    await failed.service.executeOutbound(outbound.id);
    expect(
      (await composeRejection(compose.createResendDraft(readyContext, outbound.id))).code,
    ).toBe("invalid_request");

    expect(
      (await composeRejection(compose.createResendDraft(readyContext, randomUUID()))).code,
    ).toBe("not_found");
  });

  it("skips stale generations in the append and recovery sweeps", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row } = await acceptedSend(service);
    await db
      .update(outboundMessages)
      .set({ recoveryGeneration: OTHER_GENERATION })
      .where(eq(outboundMessages.id, row.id));

    const copies = await service.appendDueSentCopies();
    expect(copies.skippedStale).toBeGreaterThanOrEqual(1);
    expect(folder.appendsOf(row.rfcMessageId)).toBe(0);

    // A restored row mid-flight stays for operator reconciliation.
    const queued = await queueSendOf((await makeDraft()).id);
    await db
      .update(outboundMessages)
      .set({
        status: "sending",
        sendingStartedAt: new Date(Date.now() - ATTEMPT_LEASE_MS - 1000),
        recoveryGeneration: OTHER_GENERATION,
      })
      .where(eq(outboundMessages.id, queued.id));
    const recovered = await service.recoverAbandonedAttempts();
    expect(recovered.skippedStale).toBeGreaterThanOrEqual(1);
    expect((await loadRow(queued.id)).status).toBe("sending");
  });

  it("caps a permanently failing append and lets younger rows through", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(acceptedReport(), folder);
    const { row: stuck } = await acceptedSend(service);

    folder.scriptedAppend = { result: "rejected" };
    for (let pass = 0; pass < SEND_SWEEP_ATTEMPT_CAP; pass += 1) {
      await service.appendDueSentCopies(100);
    }
    const capped = await loadRow(stuck.id);
    expect(capped.sentCopyAttempts).toBe(SEND_SWEEP_ATTEMPT_CAP);
    expect(capped.sentCopyStatus).toBe("failed");
    expect(
      (await eventTypesOf(stuck.id)).filter((type) => type === "send.sent_copy_halted"),
    ).toHaveLength(1);

    // The capped row leaves the window: one more pass never appends it
    // again, while a younger row stores in that same pass.
    folder.scriptedAppend = null;
    const { row: young } = await acceptedSend(service);
    await service.appendDueSentCopies(100);
    expect((await loadRow(stuck.id)).sentCopyAttempts).toBe(SEND_SWEEP_ATTEMPT_CAP);
    expect(folder.appendsOf(stuck.rfcMessageId)).toBe(SEND_SWEEP_ATTEMPT_CAP);
    expect((await loadRow(young.id)).sentCopyStatus).toBe("stored");
  });

  it("caps evidence-less reconcile passes and lets younger unknowns resolve", async () => {
    const folder = new FakeSentFolder("Sent");
    const { service } = appendingService(unknownReport(), folder);
    const stuck = await queueSendOf((await makeDraft({ subject: "Evidence never arrives" })).id);
    await service.executeOutbound(stuck.id);
    expect((await loadRow(stuck.id)).status).toBe("outcome_unknown");

    for (let pass = 0; pass < SEND_SWEEP_ATTEMPT_CAP; pass += 1) {
      await service.reconcileUnknownOutcomes(100);
    }
    const capped = await loadRow(stuck.id);
    expect(capped.reconcileAttempts).toBe(SEND_SWEEP_ATTEMPT_CAP);
    expect(capped.status).toBe("outcome_unknown");
    expect(
      (await eventTypesOf(stuck.id)).filter((type) => type === "send.reconcile_halted"),
    ).toHaveLength(1);

    // The capped row leaves the window; a younger unknown with evidence
    // resolves in the same pass.
    const young = await queueSendOf((await makeDraft({ subject: "Evidence arrives" })).id);
    await service.executeOutbound(young.id);
    const youngRow = await loadRow(young.id);
    folder.load(youngRow.rfcMessageId, await storage.durable.get(youngRow.mimeStorageKey));
    await service.reconcileUnknownOutcomes(100);
    expect((await loadRow(young.id)).status).toBe("sent");
    expect((await loadRow(stuck.id)).reconcileAttempts).toBe(SEND_SWEEP_ATTEMPT_CAP);
  });

  /** The folder one account maps to the Sent role. */
  async function sentFolderOf(accountIdToResolve: string) {
    const rows = await db
      .select({ id: foldersTable.id })
      .from(foldersTable)
      .where(and(eq(foldersTable.accountId, accountIdToResolve), eq(foldersTable.role, "sent")))
      .limit(1);
    return rows[0] ?? null;
  }
});
