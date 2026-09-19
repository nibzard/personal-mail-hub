import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts,
  createDatabase,
  createStorage,
  folders,
  messages,
  messageOccurrences,
  runMigrations,
  type MailHubDatabase,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, RecoveryControls } from "@mail-hub/recovery";
import {
  AuthError,
  ConsoleAuthService,
  PasskeyAuthService,
  createRecoveryHooks,
  parseAuthConfig,
  type AuthConfig,
} from "@mail-hub/auth";
import { ComposeService } from "@mail-hub/compose";
import { OutboundService } from "@mail-hub/send";
import { ActionService, type ActionExecutor, type ActionMailbox } from "@mail-hub/actions";
import { submitSmtpMessage } from "@mail-hub/transport";
import { createTestAuthority, ScriptedSmtpServer, type TestAuthority, type TestCertificate } from "@mail-hub/harness";
import {
  createFakePasskey,
  fakeAuthenticationResponse,
  fakeRegistrationResponse,
} from "../../../packages/auth/test/fake-authenticator.ts";

/**
 * Restore, held operations, and client replay acceptance (SPEC section 12,
 * "Transport and authentication acceptance" and "Send safety"). One story
 * runs against real PostgreSQL and the scripted SMTP server: the owner works
 * under generation A, an off-box backup is taken, one send is accepted after
 * the backup, the live database is lost, and the backup returns under a new
 * generation B. Every rule the restore owes is asserted on the way through:
 * workers and mutations stay blocked, restored credentials grant nothing, the
 * replay answers 409 before and after recovery, held operations get their
 * explicit disposition, and only new-generation work submits again. Set
 * `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; two throwaway databases are created per run. Without the
 * variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://localhost:5173";
const RP_ID = "localhost";

const HOST = "localhost";
const USER = "user@example.com";
const PASSWORD = "mailbox-secret";
const TIMEOUTS = { connectMs: 4_000, greetingMs: 4_000, socketMs: 8_000 };

const RECIPIENTS = {
  to: [{ address: "to@example.com", name: null }],
  cc: [],
  bcc: [],
};

/**
 * The hold-only executor the admin command uses: holding a restored action
 * must never reach a remote write.
 */
const HOLD_ONLY_EXECUTOR: ActionExecutor<ActionMailbox> = {
  async apply() {
    throw new Error("Holding restored actions must not execute an item.");
  },
};

/** A mailbox double that fails the test the moment anything touches it. */
const UNTOUCHED_MAILBOX: ActionMailbox = {
  async select() {
    throw new Error("A held action must not select a folder.");
  },
  async fetchFlags() {
    throw new Error("A held action must not read flags.");
  },
  async revalidate() {
    throw new Error("A held action must not revalidate.");
  },
};

/** Convert a rejected promise into its `RecoveryBlockedError`. */
async function blockedBy(promise: Promise<unknown>): Promise<RecoveryBlockedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RecoveryBlockedError) {
      return error;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

/** Convert a rejected promise into its `AuthError` code. */
async function authCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

suite("restore, held operations, and client replay", () => {
  const liveName = `mail_hub_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const backupName = `${liveName}_backup`;

  let livePool: Pool;
  /** The pool of the database the deployment restored; set after the loss. */
  let restoredPool: Pool;
  let storage: Storage;
  let root: string;
  let smtpServer: ScriptedSmtpServer;
  let authority: TestAuthority;
  let config: AuthConfig;

  // The owner's first passkey and the session it opened under generation A.
  const heldPasskey = createFakePasskey();
  let ownerSessionToken = "";

  // Mail state the whole story shares.
  let accountId = "";
  let inboxFolderId = "";
  let draftId = "";
  let restoredActionId = "";

  async function adminQuery(sql: string): Promise<void> {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  }

  async function dropDb(name: string): Promise<void> {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    try {
      await dropTestDatabase(admin, name);
    } finally {
      await admin.end();
    }
  }

  function openPool(name: string): Pool {
    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${name}`;
    return new Pool({ connectionString: url.toString() });
  }

  /** The outbound service wired to the scripted server through real TLS. */
  function outbound(db: MailHubDatabase, controls: RecoveryControls): OutboundService {
    return new OutboundService(db, storage, controls, {
      submit: (request) =>
        submitSmtpMessage({ ...request, trustedCaPem: [authority.certPem], timeouts: TIMEOUTS }),
      resolveCredentials: async () => ({
        host: HOST,
        port: smtpServer.port,
        security: "starttls_required",
        username: USER,
        password: PASSWORD,
      }),
    });
  }

  function submissions(): number {
    return smtpServer.completedSubmissions().length;
  }

  beforeAll(async () => {
    authority = createTestAuthority();
    const certificate: TestCertificate = authority.issue({ hosts: [HOST], ips: ["127.0.0.1"] });
    smtpServer = await ScriptedSmtpServer.start({
      mode: "starttls",
      certificate,
      auth: { user: USER, pass: PASSWORD },
      submission: {},
    });

    const parsed = parseAuthConfig({ baseUrl: ORIGIN });
    if (parsed === null) {
      throw new Error("The test origin must parse.");
    }
    config = parsed;

    await adminQuery(`create database ${liveName}`);
    livePool = openPool(liveName);
    await runMigrations(livePool);

    root = await mkdtemp(join(tmpdir(), "mail-hub-restore-"));
    storage = createStorage(root);
  });

  afterAll(async () => {
    await livePool?.end().catch(() => undefined);
    await restoredPool?.end().catch(() => undefined);
    await dropDb(liveName);
    await dropDb(backupName);
    await smtpServer?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("enrolls the owner through the console bootstrap and queues work under generation A", async () => {
    const db = createDatabase(livePool);
    const controls = new RecoveryControls(db, { deploymentGeneration: GENERATION_A });

    // The bootstrap on an empty database also initializes the control state.
    const consoleAuth = new ConsoleAuthService(db, controls);
    const bootstrap = await consoleAuth.issueBootstrapGrant();
    expect(bootstrap.purpose).toBe("bootstrap");

    const auth = new PasskeyAuthService(db, config, controls);
    const options = await auth.startEnrollment(bootstrap.token);
    const response = fakeRegistrationResponse({ passkey: heldPasskey, options, rpId: RP_ID, origin: ORIGIN });
    const opened = await auth.completeEnrollment({ grantToken: bootstrap.token, label: "Laptop", response });
    expect(opened.session.kind).toBe("standard");
    ownerSessionToken = opened.token;

    // One account, an inbox folder, and one message in it.
    const [account] = await db
      .insert(accounts)
      .values({
        label: "Main mailbox",
        color: "#2563eb",
        username: USER,
        passwordEnc: "v1.unused",
        identities: [{ address: USER, name: "Main User", isDefault: true }],
      })
      .returning();
    accountId = account!.id;
    const inserted = await db
      .insert(folders)
      .values([
        { accountId, name: "INBOX", role: "inbox" },
        { accountId, name: "Sent", role: "sent" },
      ])
      .returning();
    inboxFolderId = inserted.find((folder) => folder.name === "INBOX")!.id;

    const [message] = await db
      .insert(messages)
      .values({ accountId, subject: "Restore story", snippet: "One message the restore must keep." })
      .returning();
    const [occurrence] = await db
      .insert(messageOccurrences)
      .values({
        accountId,
        messageId: message!.id,
        folderId: inboxFolderId,
        uidvalidity: 1,
        uid: 5,
        internalDate: new Date(),
      })
      .returning();

    // One draft, and one mail action frozen against the current generation.
    const compose = new ComposeService(db, storage, controls);
    const draft = await compose.createDraft({ requestGeneration: GENERATION_A }, {
      accountId,
      recipients: RECIPIENTS,
      subject: "Across the restore",
      markdown: "# Across the restore\n\nThe client keeps its own copy.",
    });
    draftId = draft.id;

    const actions = new ActionService(db, controls, HOLD_ONLY_EXECUTOR);
    const submitted = await actions.submit({
      accountId,
      kind: "mark_read",
      recoveryGeneration: GENERATION_A,
      idempotencyKey: `action-${randomUUID()}`,
      occurrenceIds: [occurrence!.id],
    });
    expect(submitted.created).toBe(true);
    expect(submitted.receipt.items[0]).toMatchObject({ status: "queued" });
    restoredActionId = submitted.receipt.actionId;
  });

  it("accepts one send after the backup window, then loses the live database", async () => {
    // The off-box backup: a consistent copy taken here, before the send.
    await livePool.end();
    await adminQuery(`create database ${backupName} template ${liveName}`);
    livePool = openPool(liveName);

    // The send the backup never sees. The client loses the acknowledgement.
    const db = createDatabase(livePool);
    const controls = new RecoveryControls(db, { deploymentGeneration: GENERATION_A });
    const send = outbound(db, controls);
    const queued = await send.queueSend({ requestGeneration: GENERATION_A }, {
      draftId,
      idempotencyKey: "replay-after-restore",
      baseRevision: 1,
    });
    expect(queued.created).toBe(true);
    const executed = await send.executeOutbound(queued.outbound.id);
    expect(executed.submitted).toBe(true);
    expect(executed.status).toBe("sent");
    expect(submissions()).toBe(1);

    // The live database is lost; the deployment restores the backup copy.
    await livePool.end();
    restoredPool = openPool(backupName);
    await restoredPool.query("select 1");
  });

  it("blocks the restored deployment and answers the replay with 409 before recovery", async () => {
    const db = createDatabase(restoredPool);
    const controls = new RecoveryControls(db, {
      deploymentGeneration: GENERATION_B,
      hooks: createRecoveryHooks(),
    });

    const status = await controls.readStatus();
    expect(status).toEqual({
      state: "generation_mismatch",
      deploymentGeneration: GENERATION_B,
      databaseGeneration: GENERATION_A,
      mode: "ready",
    });

    // Every worker sweep refuses; the accepted send stays the only one.
    const send = outbound(db, controls);
    await expect(send.executeQueued(10)).resolves.toMatchObject({ blocked: true, submitted: 0 });
    await expect(send.appendDueSentCopies(10)).resolves.toMatchObject({ blocked: true });
    await expect(send.recoverAbandonedAttempts()).resolves.toMatchObject({ blocked: true });
    expect(submissions()).toBe(1);

    // The restored queued action holds without touching any mailbox.
    const actions = new ActionService(db, controls, HOLD_ONLY_EXECUTOR);
    const held = await actions.execute(restoredActionId, UNTOUCHED_MAILBOX);
    expect(held).toMatchObject({ state: "held", reason: "recovery_blocked" });

    // Replay one: the gate runs before the idempotency lookup, so even a key
    // the restored database never heard of answers 409 (SPEC section 7).
    const replay = await blockedBy(
      send.queueSend({ requestGeneration: GENERATION_A }, {
        draftId,
        idempotencyKey: "replay-after-restore",
        baseRevision: 1,
      }),
    );
    expect(replay).toBeInstanceOf(RecoveryBlockedError);
    expect(replay.code).toBe("recovery_required");
    expect(replay.httpStatus).toBe(409);
    expect(replay.currentGeneration).toBe(GENERATION_B);
    expect(submissions()).toBe(1);

    // The restored session still matches the restored rows, but it grants no
    // access at all before recovery begins: reads, settings, passkey
    // enrollment, and mail mutations all refuse it (SPEC section 10).
    const auth = new PasskeyAuthService(db, config, controls);
    await expect(authCode(auth.verifySession(ownerSessionToken))).resolves.toBe("unauthorized");
    const compose = new ComposeService(db, storage, controls);
    const gated = await blockedBy(
      compose.updateDraft({ requestGeneration: GENERATION_A }, draftId, { baseRevision: 1, subject: "Edited after restore" }),
    );
    expect(gated.code).toBe("recovery_required");
    expect(await authCode(auth.startLogin())).toBe("login_blocked");

    // Missing deployment configuration keeps everything blocked and retryable.
    const unconfigured = new RecoveryControls(createDatabase(restoredPool), {});
    expect((await unconfigured.readStatus()).state).toBe("config_missing");
    const retryable = await blockedBy(unconfigured.gateMutation(GENERATION_B));
    expect(retryable.code).toBe("recovery_in_progress");
    expect(retryable.httpStatus).toBe(503);
  });

  it("holds restored work through recovery and rejects the old history after resume", async () => {
    const db = createDatabase(restoredPool);
    const controls = new RecoveryControls(db, {
      deploymentGeneration: GENERATION_B,
      hooks: createRecoveryHooks(),
    });
    const send = outbound(db, controls);
    const actions = new ActionService(db, controls, HOLD_ONLY_EXECUTOR);
    const auth = new PasskeyAuthService(db, config, controls);
    const compose = new ComposeService(db, storage, controls);

    // Recovery begin revokes the restored authentication state once.
    const begin = await controls.beginRecovery();
    expect(begin).toEqual({ result: "started", generation: GENERATION_B });
    await expect(authCode(auth.verifySession(ownerSessionToken))).resolves.toBe("unauthorized");

    // Replay two: still 409 while the service reconciles.
    const duringRecovery = await blockedBy(
      send.queueSend({ requestGeneration: GENERATION_A }, {
        draftId,
        idempotencyKey: "replay-after-restore",
        baseRevision: 1,
      }),
    );
    expect(duringRecovery.httpStatus).toBe(409);
    expect(submissions()).toBe(1);

    // Repeating the command resumes without repeating revocation.
    expect(await controls.beginRecovery()).toEqual({ result: "resumed", generation: GENERATION_B });
    const revocations = await restoredPool.query(
      "select count(*)::int as count from events where type = 'auth.revoked_on_recovery'",
    );
    expect(revocations.rows[0].count).toBe(1);

    // Completion refuses while a restored operation lacks a disposition.
    await expect(controls.completeRecovery()).resolves.toMatchObject({
      result: "rejected",
      reason: "pending_operations",
      pendingOperations: { actions: 1, outboundMessages: 0 },
    });

    // The operator holds the restored action; its items never execute.
    const disposition = await actions.dispositionRestoredActions(GENERATION_B);
    expect(disposition).toEqual({ actions: 1, conflicted: 1, unknown: 0 });
    const receipt = await actions.receipt(restoredActionId);
    expect(receipt.status).toBe("complete");
    expect(receipt.items[0]).toMatchObject({ status: "conflicted", outcome: { reason: "restored_generation" } });

    // No passkey is registered yet, so completion still refuses.
    await expect(controls.completeRecovery()).resolves.toMatchObject({ result: "rejected", reason: "owner_missing" });

    // Credential recovery: one replacement grant, one replacement passkey.
    const consoleAuth = new ConsoleAuthService(db, controls);
    const grant = await consoleAuth.issueRecoveryGrant();
    expect(grant.purpose).toBe("recovery");
    const options = await auth.startEnrollment(grant.token);
    const replacement = createFakePasskey();
    const response = fakeRegistrationResponse({ passkey: replacement, options, rpId: RP_ID, origin: ORIGIN });
    const opened = await auth.completeEnrollment({ grantToken: grant.token, label: "Replacement key", response });
    expect(opened.session.kind).toBe("inspection");

    // The old passkey is dead; the replacement signs in while reconciling.
    const refused = await auth.startLogin();
    const refusedResponse = fakeAuthenticationResponse({ passkey: heldPasskey, options: refused, rpId: RP_ID, origin: ORIGIN });
    expect(await authCode(auth.completeLogin(refusedResponse))).toBe("webauthn_invalid");
    const login = await auth.startLogin();
    const loginResponse = fakeAuthenticationResponse({ passkey: replacement, options: login, rpId: RP_ID, origin: ORIGIN });
    const replacementSession = await auth.completeLogin(loginResponse);
    expect(replacementSession.session.kind).toBe("inspection");

    // The mail survived the whole procedure, still unread: the held action
    // never ran (SPEC section 12: the replacement opens the same mail).
    const mail = await restoredPool.query(
      "select m.subject, o.unread from messages m join message_occurrences o on o.message_id = m.id where m.account_id = $1",
      [accountId],
    );
    expect(mail.rows).toEqual([{ subject: "Restore story", unread: true }]);

    const done = await controls.completeRecovery();
    expect(done).toEqual({ result: "completed", generation: GENERATION_B, ownerCheck: "verified" });
    await expect(auth.verifySession(replacementSession.token)).resolves.toMatchObject({ kind: "inspection" });

    // Replay three: the old history stays rejected after service resumes,
    // and the accepted send is still the only one the server saw.
    const afterResume = await blockedBy(
      send.queueSend({ requestGeneration: GENERATION_A }, {
        draftId,
        idempotencyKey: "replay-after-restore",
        baseRevision: 1,
      }),
    );
    expect(afterResume.code).toBe("recovery_required");
    expect(submissions()).toBe(1);

    // New work under the new generation proceeds: exactly one more send.
    const draft = await compose.createDraft({ requestGeneration: GENERATION_B }, {
      accountId,
      recipients: RECIPIENTS,
      subject: "After recovery",
      markdown: "# After recovery\n\nFresh work under the new generation.",
    });
    const queued = await send.queueSend({ requestGeneration: GENERATION_B }, {
      draftId: draft.id,
      idempotencyKey: `fresh-${randomUUID()}`,
      baseRevision: 1,
    });
    expect(queued.created).toBe(true);
    await expect(send.executeQueued(10)).resolves.toMatchObject({ blocked: false, submitted: 1 });
    expect(submissions()).toBe(2);

    // The held action keeps its disposition; nothing retried it.
    await expect(actions.receipt(restoredActionId)).resolves.toMatchObject({ status: "complete" });
  });
});
