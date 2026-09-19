import { mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts as accountsTable,
  createDatabase,
  createStorage,
  drafts as draftsTable,
  events,
  outboundMessages,
  runMigrations,
  uploads as uploadsTable,
  uploadKey,
  type MailHubDatabase,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls, type MailHubTransaction } from "@mail-hub/recovery";
import {
  ComposeError,
  ComposeService,
  lockDraftForSend,
  unlockDraftAfterFailure,
  type DraftRecord,
} from "../src/index.ts";

/**
 * Draft editing and durable-upload acceptance against a real PostgreSQL and
 * a real filesystem store (SPEC F6, F7, and F9). Set `TEST_DATABASE_URL` to
 * a connection string whose user may create databases; a throwaway database
 * is created per run. Without the variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";

const readyContext = { requestGeneration: GENERATION };
const staleGenerationContext = { requestGeneration: OTHER_GENERATION };

/** Convert a rejected promise into its typed code and stale revision. */
async function rejection(promise: Promise<unknown>): Promise<{
  code: string;
  message: string;
  currentRevision?: number;
}> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ComposeError || error instanceof RecoveryBlockedError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

/** Convert a rejection and also capture the stale revision it carries. */
async function staleRejection(promise: Promise<unknown>): Promise<ComposeError> {
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

suite("draft editing and durable uploads", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let storage: Storage;
  let service: ComposeService;
  let controls: RecoveryControls;
  let storageRoot: string;
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

    storageRoot = await mkdtemp(join(tmpdir(), "mail-hub-compose-"));
    storage = createStorage(storageRoot);
    service = new ComposeService(db, storage, controls);

    const inserted = await db
      .insert(accountsTable)
      .values([
        {
          label: "Main mailbox",
          color: "#2563eb",
          username: "user@example.com",
          passwordEnc: "v1.unused",
          identities: [
            { address: "user@example.com", name: "Main User", isDefault: true },
            { address: "alias@example.com", name: null, isDefault: false },
          ],
        },
        {
          label: "Bare mailbox",
          color: "#16a34a",
          username: "bare@example.com",
          passwordEnc: "v1.unused",
          identities: [],
        },
      ])
      .returning({ id: accountsTable.id, label: accountsTable.label });
    accountId = inserted.find((row) => row.label === "Main mailbox")!.id;
    bareAccountId = inserted.find((row) => row.label === "Bare mailbox")!.id;
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  it("selects the default identity for a new draft and records an audit event", async () => {
    const draft = await service.createDraft(readyContext, {
      accountId,
      recipients: { to: [{ address: "Friend@Example.COM ", name: " Friend " }] },
      subject: "  Hello  ",
      markdown: "**Hi** there",
    });

    expect(draft.identity).toEqual({ address: "user@example.com", name: "Main User" });
    expect(draft.recipients).toEqual({ to: [{ address: "friend@example.com", name: "Friend" }], cc: [], bcc: [] });
    expect(draft.subject).toBe("Hello");
    expect(draft.markdown).toBe("**Hi** there");
    expect(draft.revision).toBe(1);
    expect(draft.lockedBySend).toBeNull();

    const recorded = await db.select().from(events).where(eq(events.entityId, draft.id));
    expect(recorded.map((row) => row.type)).toContain("draft.created");
    // Event payloads never carry message text (SPEC section 9).
    expect(JSON.stringify(recorded)).not.toContain("Hi");
  });

  it("accepts an explicit identity only when the account configures it", async () => {
    const aliased = await service.createDraft(readyContext, {
      accountId,
      identity: { address: "ALIAS@example.com" },
    });
    expect(aliased.identity).toEqual({ address: "alias@example.com", name: null });

    expect(
      (await staleRejection(
        service.createDraft(readyContext, { accountId, identity: { address: "ghost@example.com" } }),
      )).code,
    ).toBe("identity_invalid");

    expect(
      (await staleRejection(service.createDraft(readyContext, { accountId: bareAccountId }))).code,
    ).toBe("identity_invalid");

    expect(
      (await staleRejection(service.createDraft(readyContext, { accountId: randomUUID() }))).code,
    ).toBe("not_found");
  });

  it("applies revision-aware edits and rejects a stale base revision", async () => {
    const draft = await service.createDraft(readyContext, { accountId });

    const first = await service.updateDraft(readyContext, draft.id, {
      baseRevision: 1,
      markdown: "First edit",
      subject: null,
    });
    expect(first.revision).toBe(2);
    expect(first.markdown).toBe("First edit");
    expect(first.subject).toBeNull();

    const second = await service.updateDraft(readyContext, draft.id, {
      baseRevision: 2,
      identity: null,
      recipients: null,
      markdown: "Second edit",
    });
    // `identity: null` returns to the default; `recipients: null` clears.
    expect(second.revision).toBe(3);
    expect(second.identity.address).toBe("user@example.com");
    expect(second.recipients).toEqual({ to: [], cc: [], bcc: [] });

    // A second device still basing its edit on revision 2 must not overwrite.
    const stale = await staleRejection(
      service.updateDraft(readyContext, draft.id, { baseRevision: 2, markdown: "Other device" }),
    );
    expect(stale.code).toBe("draft_stale");
    expect(stale.currentRevision).toBe(3);

    const untouched = await service.readDraft(draft.id);
    expect(untouched.markdown).toBe("Second edit");

    // An edit with no fields changes nothing and keeps the revision.
    const empty = await service.updateDraft(readyContext, draft.id, { baseRevision: 3 });
    expect(empty.revision).toBe(3);
  });

  it("rejects edits when the recovery generation is stale", async () => {
    const result = await rejection(
      service.createDraft(staleGenerationContext, { accountId }),
    );
    expect(result.code).toBe("recovery_required");
  });

  it("writes uploads to durable storage before acknowledging them", async () => {
    const bytes = new TextEncoder().encode("attachment-bytes-1");
    const upload = await service.createUpload(readyContext, {
      accountId,
      filename: " notes.txt ",
      contentType: "text/plain; charset=utf-8",
      bytes,
    });

    expect(upload.filename).toBe("notes.txt");
    expect(upload.contentType).toBe("text/plain");
    expect(upload.sizeBytes).toBe(bytes.byteLength);
    expect(upload.sha256).toHaveLength(64);

    // The durable object exists and matches before any acknowledgement.
    const stored = await storage.durable.get(uploadKey(upload.id));
    expect(Buffer.from(stored).equals(Buffer.from(bytes))).toBe(true);
    await expect(storage.durable.verify(uploadKey(upload.id), upload.sha256)).resolves.toBe(true);

    expect((await staleRejection(service.createUpload(readyContext, {
      accountId,
      filename: "empty.bin",
      contentType: "application/octet-stream",
      bytes: new Uint8Array(0),
    }))).code).toBe("invalid_request");
  });

  it("attaches uploads in order and enforces account boundaries", async () => {
    const draft = await service.createDraft(readyContext, { accountId });
    const first = await service.createUpload(readyContext, {
      accountId,
      filename: "a.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("aaaa"),
    });
    const second = await service.createUpload(readyContext, {
      accountId,
      filename: "b.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("bbbb"),
    });
    const foreign = await service.createUpload(readyContext, {
      accountId: bareAccountId,
      filename: "c.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("cccc"),
    });

    await service.attachUpload(readyContext, draft.id, first.id);
    await service.attachUpload(readyContext, draft.id, second.id);
    const attachments = await service.listDraftAttachments(draft.id);
    expect(attachments.map((row) => [row.filename, row.ordinal])).toEqual([
      ["a.pdf", 0],
      ["b.pdf", 1],
    ]);

    expect(
      (await staleRejection(service.attachUpload(readyContext, draft.id, foreign.id))).code,
    ).toBe("invalid_request");

    await service.detachUpload(readyContext, draft.id, first.id);
    expect((await service.listDraftAttachments(draft.id)).map((row) => row.filename)).toEqual(["b.pdf"]);
    expect(
      (await staleRejection(service.detachUpload(readyContext, draft.id, first.id))).code,
    ).toBe("not_found");
  });

  it("verifies every referenced upload against its durable bytes", async () => {
    const draft = await service.createDraft(readyContext, { accountId });
    const upload = await service.createUpload(readyContext, {
      accountId,
      filename: "report.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("report-bytes"),
    });
    await service.attachUpload(readyContext, draft.id, upload.id);

    const before = await service.verifyDraftUploads(draft.id);
    expect(before).toEqual({
      draftId: draft.id,
      ok: true,
      uploads: [{ uploadId: upload.id, filename: "report.pdf", verified: true }],
    });

    // Tampered bytes fail the recorded hash even though the file exists.
    await storage.durable.put(uploadKey(upload.id), new TextEncoder().encode("tampered"));
    const tampered = await service.verifyDraftUploads(draft.id);
    expect(tampered.ok).toBe(false);
    expect(tampered.uploads[0]!.verified).toBe(false);

    // A missing object fails too.
    await storage.durable.remove(uploadKey(upload.id));
    const missing = await service.verifyDraftUploads(draft.id);
    expect(missing.ok).toBe(false);
  });

  it("locks a draft for its queued send and only a failure unlocks it", async () => {
    const draft = await service.createDraft(readyContext, { accountId });
    const upload = await service.createUpload(readyContext, {
      accountId,
      filename: "lock.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("lock"),
    });
    await service.attachUpload(readyContext, draft.id, upload.id);

    const outboundId = randomUUID();
    await db.transaction(async (tx) => {
      await insertOutbound(tx, outboundId, accountId, draft);
      const locked = await lockDraftForSend(tx, draft.id, draft.revision, outboundId);
      expect(locked.lockedBySend).toBe(outboundId);
    });

    // Every edit path rejects while the draft is locked (SPEC F7).
    expect(
      (await staleRejection(
        service.updateDraft(readyContext, draft.id, { baseRevision: draft.revision, markdown: "too late" }),
      )).code,
    ).toBe("draft_locked");
    expect(
      (await staleRejection(service.attachUpload(readyContext, draft.id, upload.id))).code,
    ).toBe("draft_locked");
    expect((await staleRejection(service.deleteDraft(readyContext, draft.id))).code).toBe("draft_locked");

    // Repeating the same lock is idempotent; another attempt cannot take it.
    await db.transaction(async (tx) => {
      const again = await lockDraftForSend(tx, draft.id, draft.revision, outboundId);
      expect(again.lockedBySend).toBe(outboundId);
    });
    const otherOutbound = randomUUID();
    await db.transaction(async (tx) => {
      await insertOutbound(tx, otherOutbound, accountId, draft);
      expect((await staleRejection(lockDraftForSend(tx, draft.id, draft.revision, otherOutbound))).code).toBe(
        "draft_locked",
      );
    });

    // An unresolved attempt never releases the draft.
    expect(
      (await staleRejection(db.transaction((tx) => unlockDraftAfterFailure(tx, outboundId)))).code,
    ).toBe("invalid_request");

    await db
      .update(outboundMessages)
      .set({ status: "failed" })
      .where(eq(outboundMessages.id, outboundId));
    const released = await db.transaction((tx) => unlockDraftAfterFailure(tx, outboundId));
    expect(released).toBe(1);

    const unlocked = await service.updateDraft(readyContext, draft.id, {
      baseRevision: draft.revision,
      markdown: "editable again",
    });
    expect(unlocked.revision).toBe(draft.revision + 1);
  });

  it("rejects a send lock that does not match the frozen revision", async () => {
    const draft = await service.createDraft(readyContext, { accountId });
    await service.updateDraft(readyContext, draft.id, { baseRevision: 1, markdown: "moved on" });

    const outboundId = randomUUID();
    const error = await db.transaction(async (tx) => {
      await insertOutbound(tx, outboundId, accountId, draft);
      return staleRejection(lockDraftForSend(tx, draft.id, 1, outboundId));
    });
    expect(error.code).toBe("draft_stale");
    expect(error.currentRevision).toBe(2);

    const row = (await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)))[0]!;
    expect(row.lockedBySend).toBeNull();
  });

  it("soft-deletes a draft while its uploads live on", async () => {
    const draft = await service.createDraft(readyContext, { accountId });
    const upload = await service.createUpload(readyContext, {
      accountId,
      filename: "keep.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("keep"),
    });
    await service.attachUpload(readyContext, draft.id, upload.id);

    await service.deleteDraft(readyContext, draft.id);
    expect((await staleRejection(service.readDraft(draft.id))).code).toBe("not_found");
    expect((await staleRejection(service.listDraftAttachments(draft.id))).code).toBe("not_found");
    expect(await service.listDrafts()).not.toContainEqual(expect.objectContaining({ id: draft.id }));
    expect(
      (await staleRejection(
        service.updateDraft(readyContext, draft.id, { baseRevision: 1, markdown: "no" }),
      )).code,
    ).toBe("not_found");

    // Upload rows never disappear with a draft (SPEC F6).
    const rows = await db.select().from(uploadsTable).where(eq(uploadsTable.id, upload.id));
    expect(rows).toHaveLength(1);
    await expect(storage.durable.verify(uploadKey(upload.id), upload.sha256)).resolves.toBe(true);
  });

  it("lists drafts newest edit first", async () => {
    const older = await service.createDraft(readyContext, { accountId, subject: "older" });
    const newer = await service.createDraft(readyContext, { accountId, subject: "newer" });
    await service.updateDraft(readyContext, older.id, { baseRevision: older.revision, subject: "older touched" });

    const listed = await service.listDrafts(accountId);
    expect(listed.slice(0, 2).map((row) => row.id)).toEqual([older.id, newer.id]);
  });
});

/** Insert the outbound row a draft lock points at, with frozen snapshot fields. */
async function insertOutbound(
  tx: MailHubTransaction,
  outboundId: string,
  accountId: string,
  draft: DraftRecord,
): Promise<void> {
  await tx.insert(outboundMessages).values({
    id: outboundId,
    accountId,
    recoveryGeneration: GENERATION,
    idempotencyKey: `key-${outboundId}`,
    requestHash: `hash-${outboundId}`,
    draftId: draft.id,
    draftRevision: draft.revision,
    identity: draft.identity,
    envelopeSender: draft.identity.address,
    envelopeRecipients: ["friend@example.com"],
    status: "queued",
    recipients: draft.recipients,
    markdownSource: draft.markdown,
    rfcMessageId: `<${outboundId}@example.com>`,
    mimeStorageKey: "outbound/pending.eml",
    mimeSha256: "pending",
  });
}
