import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts as accountsTable,
  bodies as bodiesTable,
  createDatabase,
  createStorage,
  drafts as draftsTable,
  folders as foldersTable,
  messages as messagesTable,
  messageOccurrences,
  outboundMessages,
  runMigrations,
  threads as threadsTable,
  type EmailAddress,
  type MailHubDatabase,
  type Message,
  type Recipients,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import { IngestionService, parseMime } from "@mail-hub/ingestion";
import { RecoveryControls } from "@mail-hub/recovery";
import { ComposeError, ComposeService } from "@mail-hub/compose";
import { BackfillService, BodyFetchService, ImapMailboxSessionFactory } from "@mail-hub/sync";
import { submitSmtpMessage } from "@mail-hub/transport";
import {
  createTestAuthority,
  ScriptedImapServer,
  ScriptedMailboxStore,
  ScriptedSmtpServer,
  type SmtpSubmissionScript,
  type TestAuthority,
  type TestCertificate,
} from "@mail-hub/harness";
import { OutboundService, SendError, ATTEMPT_LEASE_MS, type SentCopyMailbox } from "../src/index.ts";

/**
 * Compose and send safety acceptance (SPEC section 12, "Reply acceptance" and
 * "Send safety"). Every scenario runs the real services against a real
 * PostgreSQL, the filesystem store, the scripted SMTP server, and the
 * scripted IMAP harness, so SMTP submissions and Sent copies are counted on
 * two independent servers. Set `TEST_DATABASE_URL` to a connection string
 * whose user may create databases; throwaway databases are created per run.
 * Without the variable the suite skips.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const HOST = "localhost";
const USER = "user@example.com";
const ALIAS = "alias@example.com";
const PASSWORD = "mailbox-secret";
const TIMEOUTS = { connectMs: 4_000, greetingMs: 4_000, socketMs: 8_000 };

const TO = { address: "to@example.com", name: null } satisfies EmailAddress;
const CC = { address: "cc@example.com", name: null } satisfies EmailAddress;
const BCC = { address: "bcc@example.com", name: null } satisfies EmailAddress;

const RECIPIENTS: Recipients = { to: [TO], cc: [CC], bcc: [BCC] };

const MARKDOWN = "# Quarter report\n\nThe numbers **held** this quarter.";

/** The deployment generation the whole suite works under. */
const GENERATION = randomUUID();

const ready = { requestGeneration: GENERATION };

/** Addresses of the fixture cast. */
const ALICE = { address: "alice@example.com", name: "Alice Sender" } satisfies EmailAddress;
const BOB = { address: "bob@example.com", name: null } satisfies EmailAddress;
const CAROL = { address: "carol@example.com", name: null } satisfies EmailAddress;
const OWN = { address: USER, name: "Main User" } satisfies EmailAddress;
const HIDDEN = { address: "hidden@example.com", name: null } satisfies EmailAddress;

/** Convert one rejected promise into its error code, or fail the test. */
async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SendError || error instanceof ComposeError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The bytes one submission carried, without the trailing line break the wire
 * framing adds, so they compare equal to the stored snapshot.
 */
function withoutTrailingCrlf(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end >= 2 && bytes[end - 1] === 0x0a && bytes[end - 2] === 0x0d) {
    end -= 2;
  }
  return bytes.subarray(0, end);
}

/**
 * Wire text with every line break folded to `\n` and the trailing break
 * dropped: the transports normalize line endings and framing as they send,
 * so two byte strings that differ only there are the same message.
 */
function foldedToLf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n").replace(/\n+$/, "");
}

/** One parent message row with explicit addressing headers. */
interface ParentSpec {
  accountId?: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  referenceIds?: string[];
  sender?: EmailAddress | null;
  replyTo?: EmailAddress[] | null;
  recipients?: Recipients | null;
  subject?: string | null;
  threadId?: string | null;
  originalSha256?: string | null;
}

suite("compose and send safety on the wire", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let storage: Storage;
  let root: string;
  let controls: RecoveryControls;
  let compose: ComposeService;
  let accountId: string;
  let secondAccountId: string;
  let sentFolderId: string;
  let threadId: string;

  let authority: TestAuthority;
  let certificate: TestCertificate;
  let imapServer: ScriptedImapServer;
  /** The production IMAP session factory pointed at the harness server. */
  let imapFactory: ImapMailboxSessionFactory;
  const smtpServers: ScriptedSmtpServer[] = [];

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

    root = await mkdtemp(join(tmpdir(), "mail-hub-send-acceptance-"));
    storage = createStorage(root);
    compose = new ComposeService(db, storage, controls);

    const inserted = await db
      .insert(accountsTable)
      .values([
        {
          label: "Main mailbox",
          color: "#2563eb",
          username: USER,
          passwordEnc: "v1.unused",
          identities: [
            { address: USER, name: "Main User", isDefault: true },
            { address: ALIAS, name: null, isDefault: false },
          ],
        },
        {
          label: "Second mailbox",
          color: "#16a34a",
          username: "second@example.com",
          passwordEnc: "v1.unused",
          identities: [{ address: "second@example.com", name: "Second", isDefault: true }],
        },
      ])
      .returning({ id: accountsTable.id, label: accountsTable.label });
    accountId = inserted.find((row) => row.label === "Main mailbox")!.id;
    secondAccountId = inserted.find((row) => row.label === "Second mailbox")!.id;

    const folder = await db
      .insert(foldersTable)
      .values({ accountId, name: "Sent", role: "sent" })
      .returning({ id: foldersTable.id });
    sentFolderId = folder[0]!.id;

    const thread = await db
      .insert(threadsTable)
      .values({ accountId, subjectNorm: "quarterly report" })
      .returning({ id: threadsTable.id });
    threadId = thread[0]!.id;

    authority = createTestAuthority();
    certificate = authority.issue({ hosts: [HOST], ips: ["127.0.0.1"] });
    const store = new ScriptedMailboxStore();
    store.addFolder("Sent", { specialUse: ["\\Sent"] });
    imapServer = await ScriptedImapServer.start({
      certificate,
      auth: { user: USER, pass: PASSWORD },
      store,
    });
    imapFactory = new ImapMailboxSessionFactory();
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await Promise.all(smtpServers.map((server) => server.stop()));
    await imapServer?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  /** Start one scripted SMTP server this suite stops afterwards. */
  async function startSmtp(submission: SmtpSubmissionScript): Promise<ScriptedSmtpServer> {
    const server = await ScriptedSmtpServer.start({
      mode: "starttls",
      certificate,
      auth: { user: USER, pass: PASSWORD },
      submission,
    });
    smtpServers.push(server);
    return server;
  }

  /** The IMAP connection every Sent-copy job and import opens. */
  function imapConnection() {
    return {
      host: HOST,
      port: imapServer.port,
      username: USER,
      password: PASSWORD,
      trustedCaPem: [authority.certPem],
      timeouts: TIMEOUTS,
    };
  }

  /** One outbound service wired to one SMTP server through real TLS. */
  function outboundTo(
    server: ScriptedSmtpServer,
    openSentCopy: (accountId: string) => Promise<SentCopyMailbox> = async () =>
      imapFactory.open(imapConnection()),
  ): OutboundService {
    return new OutboundService(db, storage, controls, {
      submit: (request) =>
        submitSmtpMessage({ ...request, trustedCaPem: [authority.certPem], timeouts: TIMEOUTS }),
      resolveCredentials: async () => ({
        host: HOST,
        port: server.port,
        security: "starttls_required" as const,
        username: USER,
        password: PASSWORD,
      }),
      openSentCopy,
    });
  }

  /**
   * A Sent-copy factory that answers every call on the real wire except the
   * append itself, which it refuses with a tagged `NO`. Only the refusal is
   * scripted; the surrounding conversation stays the production one.
   */
  function refusingAppends(): (accountId: string) => Promise<SentCopyMailbox> {
    return async () => {
      const session = await imapFactory.open(imapConnection());
      return {
        select: (folder) => session.select(folder),
        searchByMessageId: (id2) => session.searchByMessageId(id2),
        fetchOriginal: (uid) => session.fetchOriginal(uid),
        appendMessage: (folder, bytes) => {
          imapServer.faults.push({ kind: "no", text: "Scripted append refusal" });
          return session.appendMessage(folder, bytes);
        },
        logout: () => session.logout(),
      };
    };
  }

  async function insertParent(spec: ParentSpec): Promise<Message> {
    const inserted = await db
      .insert(messagesTable)
      .values({
        accountId: spec.accountId ?? accountId,
        messageId: spec.messageId ?? null,
        inReplyTo: spec.inReplyTo ?? null,
        referenceIds: spec.referenceIds ?? [],
        sender: spec.sender ?? null,
        replyTo: spec.replyTo === undefined ? null : spec.replyTo,
        recipients: spec.recipients ?? null,
        subject: spec.subject ?? null,
        threadId: spec.threadId ?? null,
        originalSha256: spec.originalSha256 ?? null,
      })
      .returning();
    return inserted[0]!;
  }

  /** One fresh draft at revision 1, through the real compose service. */
  async function makeDraft(
    overrides: Partial<{ recipients: Recipients; markdown: string; subject: string | null }> = {},
  ) {
    return compose.createDraft(ready, {
      accountId,
      recipients: overrides.recipients ?? RECIPIENTS,
      subject: overrides.subject ?? "One exact message",
      markdown: overrides.markdown ?? MARKDOWN,
    });
  }

  /** Queue one send and return the stored outbound row. */
  async function queueSendOf(draftId: string, key = randomUUID(), baseRevision = 1) {
    const service = new OutboundService(db, storage, controls);
    const result = await service.queueSend(ready, { draftId, idempotencyKey: key, baseRevision });
    return result;
  }

  /** The outbound row as stored. */
  async function loadRow(outboundId: string) {
    const rows = await db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)).limit(1);
    return rows[0]!;
  }

  /** Submission attempts the server stored whose bytes carry the identifier. */
  function submissionsOf(server: ScriptedSmtpServer, rfcMessageId: string) {
    return server.submissions.filter(
      (attempt) => attempt.message !== null && attempt.message.toString("utf8").includes(rfcMessageId),
    );
  }

  /** Sent copies the IMAP server stored for one snapshot hash. */
  function sentCopiesOf(sha256: string) {
    return imapServer.appends.filter((append) => sha256Hex(append.bytes) === sha256);
  }

  /** The parsed form of one recorded wire message. */
  async function wireMessage(server: ScriptedSmtpServer, rfcMessageId: string) {
    const attempt = submissionsOf(server, rfcMessageId).at(-1);
    if (attempt?.message === undefined || attempt.message === null) {
      throw new Error(`The server never stored a message for ${rfcMessageId}.`);
    }
    return parseMime(new Uint8Array(attempt.message));
  }

  /** Queue one draft, submit it once, and return the stored row and bytes. */
  async function acceptedSend(
    service: OutboundService,
    overrides: Partial<{ recipients: Recipients; markdown: string; subject: string | null }> = {},
  ) {
    const draft = await makeDraft(overrides);
    const queued = await queueSendOf(draft.id);
    await service.executeOutbound(queued.outbound.id);
    const row = await loadRow(queued.outbound.id);
    expect(row.status).toBe("sent");
    return { row, bytes: await storage.durable.get(row.mimeStorageKey) };
  }

  /**
   * Run Sent-copy sweeps until none is due. Earlier tests leave due copies of
   * their own, and one pass moves at most `limit` rows, so a single sweep
   * proves nothing about a row queued moments ago.
   */
  async function settleSentCopies(service: OutboundService): Promise<void> {
    for (let pass = 0; pass < 40; pass += 1) {
      const outcome = await service.appendDueSentCopies(10);
      if (outcome.blocked) {
        throw new Error("The Sent-copy sweep was blocked by the control state.");
      }
      if (outcome.attempted === 0) {
        return;
      }
    }
    throw new Error("The Sent-copy sweeps did not settle.");
  }

  /**
   * Import everything the Sent folder holds, through the production backfill
   * and body-fetch services. Resetting the checkpoints first replays the
   * folder whole, the way a repeated full backfill does; already imported
   * occurrences are skipped, not duplicated.
   */
  async function importSentFolder(): Promise<void> {
    await db
      .update(foldersTable)
      .set({ backfillComplete: false, backfillBeforeUid: null, backfillUpperUid: null, uidvalidity: null })
      .where(eq(foldersTable.id, sentFolderId));
    const backfill = new BackfillService(db);
    const bodyFetch = new BodyFetchService(db, new IngestionService(db, storage));
    const session = await imapFactory.open(imapConnection());
    try {
      for (let pass = 0; pass < 20; pass += 1) {
        const outcome = await backfill.runBatch(session, accountId, sentFolderId);
        if (outcome.state === "complete") {
          break;
        }
        if (outcome.state === "generation_changed") {
          throw new Error("The Sent folder generation changed during the import.");
        }
      }
      for (let pass = 0; pass < 20; pass += 1) {
        const pending = await bodyFetch.pendingBodies(accountId, 10);
        if (pending.length === 0) {
          return;
        }
        for (const job of pending) {
          await bodyFetch.fetchBody(session, accountId, job);
        }
      }
      throw new Error("The Sent import did not settle.");
    } finally {
      await session.logout().catch(() => undefined);
    }
  }

  it("addresses a reply from Reply-To on the wire and freezes its references", async () => {
    const parent = await insertParent({
      messageId: "<parent-1@example.com>",
      sender: ALICE,
      replyTo: [{ address: "replies@lists.example.com", name: "List replies" }],
      recipients: { to: [OWN], cc: [BOB], bcc: [HIDDEN] },
      subject: "Quarterly report",
      threadId,
    });

    const draft = await compose.createReplyDraft(ready, {
      messageId: parent.id,
      mode: "reply",
      markdown: "One reply that quotes nothing yet.",
    });
    expect(draft.recipients).toEqual({
      to: [{ address: "replies@lists.example.com", name: "List replies" }],
      cc: [],
      bcc: [],
    });
    expect(draft.inReplyTo).toBe("<parent-1@example.com>");
    expect(draft.referenceIds).toEqual(["<parent-1@example.com>"]);

    // A malformed Reply-To requires correction instead of a guess.
    const broken = await insertParent({
      messageId: "<parent-1b@example.com>",
      sender: ALICE,
      replyTo: [],
      recipients: { to: [OWN] },
      subject: "Broken reply target",
    });
    expect(
      await errorCode(compose.createReplyDraft(ready, { messageId: broken.id, mode: "reply" })),
    ).toBe("recipients_required");

    const server = await startSmtp({});
    const queued = await queueSendOf(draft.id);
    await outboundTo(server).executeOutbound(queued.outbound.id);
    const row = await loadRow(queued.outbound.id);
    expect(row.status).toBe("sent");

    const wire = await wireMessage(server, row.rfcMessageId);
    expect(wire.sender).toEqual({ address: USER, name: "Main User" });
    expect(wire.recipients?.to).toEqual([{ address: "replies@lists.example.com", name: "List replies" }]);
    expect(wire.inReplyTo).toBe("<parent-1@example.com>");
    expect(wire.referenceIds).toEqual(["<parent-1@example.com>"]);
    // The parent's blind-copy list never reaches the reply, on the wire or in
    // the envelope (SPEC F6).
    const raw = submissionsOf(server, row.rfcMessageId).at(-1)!.message!.toString("utf8");
    expect(raw).not.toContain("hidden@example.com");
    expect(
      submissionsOf(server, row.rfcMessageId).at(-1)!.acceptedRecipients,
    ).toEqual(["replies@lists.example.com"]);
  });

  it("derives reply-all without duplicates, own identities, or Bcc copies", async () => {
    const parent = await insertParent({
      messageId: "<parent-2@example.com>",
      sender: ALICE,
      recipients: { to: [ALICE, OWN, BOB], cc: [BOB, CAROL], bcc: [HIDDEN] },
      subject: "Wide thread",
      threadId,
    });

    const draft = await compose.createReplyDraft(ready, {
      messageId: parent.id,
      mode: "reply_all",
      markdown: "One reply to everyone visible.",
    });
    expect(draft.recipients).toEqual({ to: [ALICE], cc: [BOB, CAROL], bcc: [] });

    const server = await startSmtp({});
    const queued = await queueSendOf(draft.id);
    await outboundTo(server).executeOutbound(queued.outbound.id);
    const row = await loadRow(queued.outbound.id);

    const wire = await wireMessage(server, row.rfcMessageId);
    expect(wire.recipients?.to).toEqual([ALICE]);
    expect(wire.recipients?.cc).toEqual([BOB, CAROL]);
    expect(wire.recipients?.bcc ?? []).toHaveLength(0);
    const attempt = submissionsOf(server, row.rfcMessageId).at(-1)!;
    expect(attempt.acceptedRecipients).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
    expect(attempt.mailFrom).toBe(USER);
    expect(attempt.message!.toString("utf8")).not.toContain("hidden@example.com");
  });

  it("reuses the visible recipients and From of your own sent message", async () => {
    const parent = await insertParent({
      messageId: "<own-sent@example.com>",
      sender: OWN,
      recipients: { to: [ALICE], cc: [BOB], bcc: [HIDDEN] },
      subject: "My own message",
      threadId,
    });

    const draft = await compose.createReplyDraft(ready, {
      messageId: parent.id,
      mode: "reply",
      markdown: "Following up on my own note.",
    });
    expect(draft.recipients).toEqual({ to: [ALICE], cc: [BOB], bcc: [] });
    expect(draft.identity).toEqual({ address: USER, name: "Main User" });

    const server = await startSmtp({});
    const queued = await queueSendOf(draft.id);
    await outboundTo(server).executeOutbound(queued.outbound.id);
    const row = await loadRow(queued.outbound.id);

    const wire = await wireMessage(server, row.rfcMessageId);
    expect(wire.sender).toEqual({ address: USER, name: "Main User" });
    expect(wire.recipients?.to).toEqual([ALICE]);
    expect(wire.recipients?.cc).toEqual([BOB]);
    expect(wire.recipients?.bcc ?? []).toHaveLength(0);
  });

  it("requires an account choice for a grouped copy and honors the chosen identity", async () => {
    // One original in two accounts: the grouped row the SPEC calls out.
    const sharedSha = sha256Hex(new TextEncoder().encode("grouped original"));
    const mine = await insertParent({
      messageId: "<grouped@example.com>",
      sender: ALICE,
      recipients: { to: [{ address: ALIAS, name: null }] },
      subject: "Grouped copy",
      threadId,
      originalSha256: sharedSha,
    });
    await insertParent({
      accountId: secondAccountId,
      messageId: "<grouped@example.com>",
      sender: ALICE,
      recipients: { to: [{ address: "second@example.com", name: null }] },
      subject: "Grouped copy",
      originalSha256: sharedSha,
    });

    expect(
      await errorCode(compose.createReplyDraft(ready, { messageId: mine.id, mode: "reply" })),
    ).toBe("account_choice_required");

    // One matching alias selects the From identity on its own.
    const chosen = await compose.createReplyDraft(ready, {
      messageId: mine.id,
      accountId,
      mode: "reply",
      markdown: "Replying from the account I chose.",
    });
    expect(chosen.accountId).toBe(accountId);
    expect(chosen.identity).toEqual({ address: ALIAS, name: null });

    const server = await startSmtp({});
    const queued = await queueSendOf(chosen.id);
    await outboundTo(server).executeOutbound(queued.outbound.id);
    const row = await loadRow(queued.outbound.id);
    const wire = await wireMessage(server, row.rfcMessageId);
    expect(wire.sender).toEqual({ address: ALIAS, name: null });
    expect(submissionsOf(server, row.rfcMessageId).at(-1)!.mailFrom).toBe(ALIAS);

    // Several matching aliases, and a blind copy without a match, both need an
    // explicit From choice; the choice lands in the draft.
    const ambiguous = await insertParent({
      messageId: "<ambiguous@example.com>",
      sender: ALICE,
      recipients: { to: [OWN, { address: ALIAS, name: null }] },
      subject: "Two aliases",
    });
    expect(
      await errorCode(compose.createReplyDraft(ready, { messageId: ambiguous.id, mode: "reply" })),
    ).toBe("identity_choice_required");
    const resolved = await compose.createReplyDraft(ready, {
      messageId: ambiguous.id,
      identity: { address: ALIAS },
      mode: "reply",
    });
    expect(resolved.identity).toEqual({ address: ALIAS, name: null });

    const blind = await insertParent({
      messageId: "<blind-copy@example.com>",
      sender: ALICE,
      recipients: { to: [{ address: "stranger@example.com", name: null }] },
      subject: "You were blind copied",
    });
    expect(
      await errorCode(compose.createReplyDraft(ready, { messageId: blind.id, mode: "reply" })),
    ).toBe("identity_choice_required");
    const explicit = await compose.createReplyDraft(ready, {
      messageId: blind.id,
      identity: { address: USER },
      mode: "reply",
    });
    expect(explicit.identity).toEqual({ address: USER, name: "Main User" });
    // A blind copy answers the sender alone; the visible recipients never
    // learn the author held a copy (SPEC F6).
    expect(explicit.recipients).toEqual({ to: [ALICE], cc: [], bcc: [] });
  });

  it("carries the chain references across three messages and keeps them after a relink", async () => {
    const first = await insertParent({
      messageId: "<chain-1@example.com>",
      sender: ALICE,
      recipients: { to: [OWN] },
      subject: "Chain start",
      threadId,
    });
    const second = await insertParent({
      messageId: "<chain-2@example.com>",
      inReplyTo: "<chain-1@example.com>",
      sender: ALICE,
      recipients: { to: [OWN] },
      subject: "Re: Chain start",
      threadId,
    });
    const third = await insertParent({
      messageId: "<chain-3@example.com>",
      inReplyTo: "<chain-2@example.com>",
      referenceIds: ["<chain-1@example.com>", "<chain-2@example.com>"],
      sender: ALICE,
      recipients: { to: [OWN] },
      subject: "Re: Re: Chain start",
      threadId,
    });

    // Reply to the newest message: its own identifier, preceded by the whole
    // chain its References carried (SPEC F6).
    const reply = await compose.createReplyDraft(ready, {
      messageId: third.id,
      mode: "reply",
      markdown: "Answering the newest message.",
    });
    expect(reply.inReplyTo).toBe("<chain-3@example.com>");
    expect(reply.referenceIds).toEqual(["<chain-1@example.com>", "<chain-2@example.com>", "<chain-3@example.com>"]);

    // The single-parent fallback: no References, one valid In-Reply-To.
    const fallback = await compose.createReplyDraft(ready, {
      messageId: second.id,
      mode: "reply",
    });
    expect(fallback.inReplyTo).toBe("<chain-2@example.com>");
    expect(fallback.referenceIds).toEqual(["<chain-1@example.com>", "<chain-2@example.com>"]);

    // A parent without a Message-ID omits both headers; nothing is invented.
    const anonymous = await insertParent({
      sender: ALICE,
      recipients: { to: [OWN] },
      subject: "No identifier",
    });
    const bare = await compose.createReplyDraft(ready, { messageId: anonymous.id, mode: "reply" });
    expect(bare.inReplyTo).toBeNull();
    expect(bare.referenceIds).toEqual([]);

    const server = await startSmtp({});
    const queued = await queueSendOf(reply.id);

    // The thread relinks after queueing; the frozen context does not move.
    const moved = await db
      .insert(threadsTable)
      .values({ accountId, subjectNorm: "a different thread" })
      .returning({ id: threadsTable.id });
    await db
      .update(messagesTable)
      .set({ threadId: moved[0]!.id })
      .where(eq(messagesTable.id, first.id));

    await outboundTo(server).executeOutbound(queued.outbound.id);
    const row = await loadRow(queued.outbound.id);
    expect(row.inReplyTo).toBe("<chain-3@example.com>");
    expect(row.referenceIds).toEqual([
      "<chain-1@example.com>",
      "<chain-2@example.com>",
      "<chain-3@example.com>",
    ]);

    const wire = await wireMessage(server, row.rfcMessageId);
    expect(wire.inReplyTo).toBe("<chain-3@example.com>");
    expect(wire.referenceIds).toEqual([
      "<chain-1@example.com>",
      "<chain-2@example.com>",
      "<chain-3@example.com>",
    ]);

    // The fallback and the bare reply reach the wire with the same rules.
    const fallbackSend = await queueSendOf(fallback.id);
    await outboundTo(server).executeOutbound(fallbackSend.outbound.id);
    const fallbackWire = await wireMessage(server, (await loadRow(fallbackSend.outbound.id)).rfcMessageId);
    expect(fallbackWire.inReplyTo).toBe("<chain-2@example.com>");
    expect(fallbackWire.referenceIds).toEqual(["<chain-1@example.com>", "<chain-2@example.com>"]);
  });

  it("keeps the snapshot immutable after a default-identity change and rejects edits", async () => {
    const draft = await makeDraft({ subject: "Frozen snapshot" });
    const uploadOne = await compose.createUpload(ready, {
      accountId,
      filename: "notes.txt",
      contentType: "text/plain",
      bytes: new TextEncoder().encode("attachment bytes one"),
    });
    const uploadTwo = await compose.createUpload(ready, {
      accountId,
      filename: "table.csv",
      contentType: "text/csv",
      bytes: new TextEncoder().encode("a,b\r\n1,2\r\n"),
    });
    await compose.attachUpload(ready, draft.id, uploadOne.id);
    await compose.attachUpload(ready, draft.id, uploadTwo.id);

    const queued = await queueSendOf(draft.id);
    const frozen = await loadRow(queued.outbound.id);
    const frozenBytes = await storage.durable.get(frozen.mimeStorageKey);

    // The account's default identity moves after queueing; the frozen From,
    // envelope, and headers must not (SPEC F7 step 1).
    await db
      .update(accountsTable)
      .set({
        identities: [
          { address: "newdefault@example.com", name: "New Default", isDefault: true },
          { address: USER, name: "Main User", isDefault: false },
        ],
      })
      .where(eq(accountsTable.id, accountId));

    expect(
      await errorCode(compose.updateDraft(ready, draft.id, { baseRevision: 1, markdown: "edited too late" })),
    ).toBe("draft_locked");
    const stillFrozen = await loadRow(queued.outbound.id);
    expect(stillFrozen.identity).toEqual({ address: USER, name: "Main User" });
    expect(stillFrozen.envelopeSender).toBe(USER);
    expect(stillFrozen.envelopeRecipients).toEqual(["to@example.com", "cc@example.com", "bcc@example.com"]);
    expect(stillFrozen.mimeSha256).toBe(frozen.mimeSha256);

    const server = await startSmtp({});
    await outboundTo(server).executeOutbound(queued.outbound.id);
    const attempt = submissionsOf(server, stillFrozen.rfcMessageId).at(-1)!;
    expect(attempt.mailFrom).toBe(USER);
    expect(foldedToLf(attempt.message!)).toBe(foldedToLf(frozenBytes));

    // Both body alternatives and every file survive parsing of what the wire
    // carried (SPEC section 12, reply acceptance).
    const wire = await parseMime(new Uint8Array(attempt.message!));
    expect(wire.sender).toEqual({ address: USER, name: "Main User" });
    expect(wire.textPlain).toBe(MARKDOWN);
    expect(wire.html).not.toBeNull();
    expect(wire.attachments.map((part) => part.filename).sort()).toEqual(["notes.txt", "table.csv"]);
    expect(wire.attachments.map((part) => part.contentType).sort()).toEqual(["text/csv", "text/plain"]);
  });

  it("creates one snapshot and one submission for repeated and concurrent requests", async () => {
    const draft = await makeDraft({ subject: "Idempotent queue" });
    const key = randomUUID();

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => queueSendOf(draft.id, key, 1)),
    );
    expect(concurrent.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(concurrent.map((result) => result.outbound.id)).size).toBe(1);

    const replay = await queueSendOf(draft.id, key, 1);
    expect(replay.created).toBe(false);
    expect(replay.outbound.id).toBe(concurrent[0]!.outbound.id);

    // A different request under the same key conflicts (SPEC F7 step 3).
    const other = await makeDraft({ subject: "Different payload" });
    expect(await errorCode(queueSendOf(other.id, key, 1))).toBe("idempotency_conflict");

    const rows = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(eq(outboundMessages.idempotencyKey, key));
    expect(rows).toHaveLength(1);

    const server = await startSmtp({});
    const service = outboundTo(server);
    const first = await service.executeQueued();
    expect(first.blocked).toBe(false);
    expect(first.submitted).toBe(1);
    const again = await service.executeQueued();
    expect(again.submitted).toBe(0);
    const row = await loadRow(concurrent[0]!.outbound.id);
    expect(submissionsOf(server, row.rfcMessageId)).toHaveLength(1);
  });

  it("records a definitive refusal as failed, releases the draft, and accepts a retried edit", async () => {
    const draft = await makeDraft({ subject: "Refused everywhere" });
    const queued = await queueSendOf(draft.id);

    // Every recipient is refused at the envelope: a definitive rejection.
    const refusing = await startSmtp({
      rejectedRecipients: ["to@example.com", "cc@example.com", "bcc@example.com"],
    });
    const outcome = await outboundTo(refusing).executeOutbound(queued.outbound.id);
    expect(outcome.status).toBe("failed");
    const row = await loadRow(queued.outbound.id);
    expect(row.logicalMessageId).toBeNull();
    expect(
      await db
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.accountId, accountId), eq(messagesTable.originalSha256, row.mimeSha256))),
    ).toHaveLength(0);
    expect(refusing.completedSubmissions()).toHaveLength(0);

    const unlocked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(unlocked.lockedBySend).toBeNull();

    // A confirmed failure can be edited and queued again under a new key.
    const edited = await compose.updateDraft(ready, draft.id, {
      baseRevision: 1,
      markdown: "# Edited after refusal\n\nThe retry carries new bytes.",
    });
    const retry = await queueSendOf(edited.id, randomUUID(), edited.revision);
    const server = await startSmtp({});
    await outboundTo(server).executeOutbound(retry.outbound.id);
    const retried = await loadRow(retry.outbound.id);
    expect(retried.status).toBe("sent");
    expect(submissionsOf(server, retried.rfcMessageId)).toHaveLength(1);
    expect(submissionsOf(refusing, retried.rfcMessageId)).toHaveLength(0);
  });

  it("reports partial acceptance exactly and never resends to accepted recipients", async () => {
    const draft = await makeDraft({ subject: "Partial acceptance" });
    const queued = await queueSendOf(draft.id);

    const partial = await startSmtp({ rejectedRecipients: ["cc@example.com"] });
    const outcome = await outboundTo(partial).executeOutbound(queued.outbound.id);
    expect(outcome.status).toBe("sent");

    const row = await loadRow(queued.outbound.id);
    expect(row.recipientResults).toEqual([
      { address: "to@example.com", accepted: true, response: expect.stringMatching(/^250/) },
      { address: "cc@example.com", accepted: false, response: expect.stringMatching(/^550/) },
      { address: "bcc@example.com", accepted: true, response: expect.stringMatching(/^250/) },
    ]);
    expect(submissionsOf(partial, row.rfcMessageId)).toHaveLength(1);
    // No automatic second attempt exists, partial or otherwise.
    await outboundTo(partial).executeQueued();
    expect(submissionsOf(partial, row.rfcMessageId)).toHaveLength(1);

    // The deliberate retry addresses the failed recipient alone; the accepted
    // ones never receive the message twice (SPEC F7).
    const retryDraft = await makeDraft({
      recipients: { to: [CC], cc: [], bcc: [] },
      subject: "Retry for the refused recipient",
    });
    const retry = await queueSendOf(retryDraft.id);
    const server = await startSmtp({});
    await outboundTo(server).executeOutbound(retry.outbound.id);
    const retried = await loadRow(retry.outbound.id);
    const attempt = submissionsOf(server, retried.rfcMessageId).at(-1)!;
    expect(attempt.acceptedRecipients).toEqual(["cc@example.com"]);
    expect(attempt.acceptedRecipients).not.toContain("to@example.com");
    expect(attempt.acceptedRecipients).not.toContain("bcc@example.com");
  });

  it("holds a lost final response as unknown; an empty Sent folder authorizes nothing", async () => {
    const draft = await makeDraft({ subject: "Acknowledgement lost" });
    const queued = await queueSendOf(draft.id);

    const server = await startSmtp({ dropAfterData: true });
    const service = outboundTo(server);
    const outcome = await service.executeOutbound(queued.outbound.id);
    expect(outcome.status).toBe("outcome_unknown");

    const row = await loadRow(queued.outbound.id);
    // The server stored the complete message, yet nothing in the database
    // claims acceptance (SPEC F7 step 6).
    expect(submissionsOf(server, row.rfcMessageId)).toHaveLength(1);
    expect(row.logicalMessageId).toBeNull();
    expect(
      await db
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.accountId, accountId), eq(messagesTable.originalSha256, row.mimeSha256))),
    ).toHaveLength(0);

    // An empty Sent folder is no evidence: the unknown stays, and neither the
    // queue nor the reconciliation sweep submits again.
    const reconciled = await service.reconcileUnknownOutcomes();
    expect(reconciled.resolved).toBe(0);
    const swept = await service.executeQueued();
    expect(swept.submitted).toBe(0);
    expect((await loadRow(queued.outbound.id)).status).toBe("outcome_unknown");
    expect(submissionsOf(server, row.rfcMessageId)).toHaveLength(1);
    // The draft stays locked; only a definitive failure releases it.
    const locked = (
      await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)).limit(1)
    )[0]!;
    expect(locked.lockedBySend).toBe(queued.outbound.id);
  });

  it("holds a cut-off transfer and an abandoned claim as unknown without replay", async () => {
    // The connection dies inside the message data: an incomplete, unclassifiable
    // attempt.
    const cutDraft = await makeDraft({ subject: "Cut off mid data" });
    const cutQueued = await queueSendOf(cutDraft.id);
    const cutServer = await startSmtp({ dropDuringData: true });
    const cut = await outboundTo(cutServer).executeOutbound(cutQueued.outbound.id);
    expect(cut.status).toBe("outcome_unknown");
    const cutRow = await loadRow(cutQueued.outbound.id);
    expect(submissionsOf(cutServer, cutRow.rfcMessageId)).toHaveLength(0);
    expect(cutServer.submissions.length).toBeGreaterThanOrEqual(1);

    // A crash after the claim, before any byte left: startup recovery holds
    // the attempt once its lease expires, and nothing replays it.
    const server = await startSmtp({});
    const service = outboundTo(server);
    const claimed = await makeDraft({ subject: "Crash before submission" });
    const claimedQueued = await queueSendOf(claimed.id);
    await db
      .update(outboundMessages)
      .set({
        status: "sending",
        sendingStartedAt: new Date(Date.now() - ATTEMPT_LEASE_MS - 1000),
      })
      .where(eq(outboundMessages.id, claimedQueued.outbound.id));

    const recovered = await service.recoverAbandonedAttempts();
    expect(recovered.heldSends).toBeGreaterThanOrEqual(1);
    const held = await loadRow(claimedQueued.outbound.id);
    expect(held.status).toBe("outcome_unknown");
    expect((held.lastError as { code: string }).code).toBe("sending_abandoned");
    const swept = await service.executeQueued();
    expect(swept.submitted).toBe(0);
    expect(submissionsOf(server, held.rfcMessageId)).toHaveLength(0);
  });

  it("appends the stored bytes once, retries only a refused append, and reconciles a lost one", async () => {
    const service = outboundTo(await startSmtp({}));
    const { row, bytes } = await acceptedSend(service, { subject: "Append once" });

    // One append of the exact stored bytes, with server coordinates recorded.
    await settleSentCopies(service);
    expect(sentCopiesOf(row.mimeSha256)).toHaveLength(1);
    expect(withoutTrailingCrlf(sentCopiesOf(row.mimeSha256)[0]!.bytes)).toEqual(withoutTrailingCrlf(bytes));
    const stored = await loadRow(row.id);
    expect(stored.sentCopyStatus).toBe("stored");
    expect(stored.sentUid).not.toBeNull();
    expect(stored.sentUidvalidity).toBe(1);

    // A refused append keeps `sent`; the retry stores the copy and never opens
    // SMTP (SPEC F7 step 5). The refusal stored nothing, so the folder still
    // holds no copy of the refused snapshot until the retry lands.
    const refusedService = outboundTo(await startSmtp({}), refusingAppends());
    const { row: refusedRow } = await acceptedSend(refusedService, { subject: "Append refused" });
    // Everything earlier is stored, so one sweep meets exactly this row.
    await refusedService.appendDueSentCopies(10);
    let refused = await loadRow(refusedRow.id);
    expect(refused.status).toBe("sent");
    expect(refused.sentCopyStatus).toBe("failed");
    expect((refused.lastError as { code: string }).code).toBe("append_rejected");
    expect(sentCopiesOf(refusedRow.mimeSha256)).toHaveLength(0);

    const retryService = outboundTo(await startSmtp({}));
    await retryService.appendDueSentCopies(10);
    refused = await loadRow(refusedRow.id);
    expect(refused.sentCopyStatus).toBe("stored");
    expect(sentCopiesOf(refusedRow.mimeSha256)).toHaveLength(1);

    // The append response disappears after the server stored the copy: the
    // outcome stays unknown until the next sweep verifies the copy that did
    // land, without appending a second time.
    const lostService = outboundTo(await startSmtp({}));
    const { row: lostRow } = await acceptedSend(lostService, { subject: "Append answer lost" });
    imapServer.faults.push({ kind: "lost-append-response" });
    await lostService.appendDueSentCopies(10);
    let lost = await loadRow(lostRow.id);
    expect(lost.sentCopyStatus).toBe("unknown");
    expect(sentCopiesOf(lostRow.mimeSha256)).toHaveLength(1);

    await lostService.appendDueSentCopies(10);
    lost = await loadRow(lostRow.id);
    expect(lost.sentCopyStatus).toBe("stored");
    expect(sentCopiesOf(lostRow.mimeSha256)).toHaveLength(1);
  }, 30_000);

  it("imports the eventual Sent copy onto the local message by hash, once", async () => {
    // Everything accepted so far has its copy stored; import the folder whole.
    const settleService = outboundTo(await startSmtp({}));
    await settleSentCopies(settleService);

    const sent = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.accountId, accountId), eq(outboundMessages.status, "sent")));
    expect(sent.length).toBeGreaterThanOrEqual(4);

    await importSentFolder();

    // Each accepted snapshot keeps exactly one local message, now carrying the
    // Sent occurrence; repeated acceptance and append jobs created nothing
    // twice (SPEC F7, local sent record).
    for (const row of await db.select().from(outboundMessages).where(eq(outboundMessages.accountId, accountId))) {
      if (row.status !== "sent") {
        continue;
      }
      const local = await db
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.accountId, accountId), eq(messagesTable.originalSha256, row.mimeSha256)));
      expect(local).toHaveLength(1);
      expect(local[0]!.id).toBe(row.logicalMessageId);
      const occurrences = await db
        .select()
        .from(messageOccurrences)
        .where(eq(messageOccurrences.messageId, row.logicalMessageId!));
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]!.folderId).toBe(sentFolderId);
      const body = (
        await db.select().from(bodiesTable).where(eq(bodiesTable.messageId, row.logicalMessageId!)).limit(1)
      )[0]!;
      expect(body.textPlain).toBe(row.markdownSource);
    }

    // A different body under the same generated identifier stays separate:
    // `Message-ID` alone merges nothing.
    const template = sent[0]!;
    const reference = await loadRow(template.id);
    const forged = Buffer.from(
      [
        `From: Main User <${USER}>`,
        "To: to@example.com",
        "Subject: Forged copy",
        `Message-ID: ${reference.rfcMessageId}`,
        "Date: Mon, 07 Sep 2026 10:00:00 +0000",
        "",
        "A different body that shares only the identifier.",
      ].join("\r\n"),
      "utf8",
    );
    imapServer.store.addMessage("Sent", { bytes: forged, flags: ["\\Seen"] });
    await importSentFolder();

    const sharing = await db
      .select({ id: messagesTable.id, sha: messagesTable.originalSha256 })
      .from(messagesTable)
      .where(and(eq(messagesTable.accountId, accountId), eq(messagesTable.messageId, reference.rfcMessageId)));
    expect(sharing).toHaveLength(2);
    expect(new Set(sharing.map((row2) => row2.sha)).size).toBe(2);
    // The accepted snapshot still owns exactly one of them.
    expect(
      await db
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.accountId, accountId), eq(messagesTable.originalSha256, reference.mimeSha256))),
    ).toHaveLength(1);
  }, 60_000);

  it("resolves an unknown send from imported evidence and reuses the racing import's row", async () => {
    const draft = await makeDraft({ subject: "Evidence arrives by import" });
    const queued = await queueSendOf(draft.id);

    const server = await startSmtp({ dropAfterData: true });
    const service = outboundTo(server);
    await service.executeOutbound(queued.outbound.id);
    const row = await loadRow(queued.outbound.id);
    expect(row.status).toBe("outcome_unknown");
    const bytes = await storage.durable.get(row.mimeStorageKey);

    // The lost submission really landed: the server holds the exact bytes, and
    // the Sent import — racing the acceptance handling — creates the local
    // message first.
    imapServer.store.addMessage("Sent", { bytes: Buffer.from(bytes), flags: ["\\Seen"] });
    await importSentFolder();
    const imported = await db
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.accountId, accountId), eq(messagesTable.originalSha256, row.mimeSha256)));
    expect(imported).toHaveLength(1);

    // Durable evidence resolves the unknown send, and the acceptance
    // transaction reuses the row the import created: one local message, sent
    // state, index, and append outcome together (SPEC F7 step 7).
    const summary = await service.reconcileUnknownOutcomes();
    expect(summary.resolved).toBeGreaterThanOrEqual(1);
    const resolved = await loadRow(row.id);
    expect(resolved.status).toBe("sent");
    expect(resolved.logicalMessageId).toBe(imported[0]!.id);
    expect(resolved.sentCopyStatus).toBe("stored");
    expect(resolved.lastError).toBeNull();

    const byHash = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.accountId, accountId), eq(messagesTable.originalSha256, row.mimeSha256)));
    expect(byHash).toHaveLength(1);

    // Resolution is evidence work, not a resend.
    expect(submissionsOf(server, row.rfcMessageId)).toHaveLength(1);
    expect(sentCopiesOf(row.mimeSha256)).toHaveLength(0);
  }, 30_000);
});

suite("restored queued sends stay held", () => {
  const liveName = `mail_hub_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const backupName = `${liveName}_backup`;

  const GENERATION_A = randomUUID();
  const GENERATION_B = randomUUID();

  let livePool: Pool;
  let restoredPool: Pool;
  let storage: Storage;
  let root: string;
  let smtpServer: ScriptedSmtpServer;
  let authority: TestAuthority;
  let accountId: string;
  let draftId = "";
  let outboundId = "";

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

    await adminQuery(`create database ${liveName}`);
    livePool = openPool(liveName);
    await runMigrations(livePool);
    root = await mkdtemp(join(tmpdir(), "mail-hub-restore-send-"));
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

  /** The outbound service wired to the restore story's SMTP server. */
  function outbound(pool: Pool, deploymentGeneration: string): OutboundService {
    const db = createDatabase(pool);
    const controls = new RecoveryControls(db, { deploymentGeneration });
    return new OutboundService(db, storage, controls, {
      submit: (request) =>
        submitSmtpMessage({ ...request, trustedCaPem: [authority.certPem], timeouts: TIMEOUTS }),
      resolveCredentials: async () => ({
        host: HOST,
        port: smtpServer.port,
        security: "starttls_required" as const,
        username: USER,
        password: PASSWORD,
      }),
    });
  }

  it("queues one send, backs up, and completes the send after the backup", async () => {
    const db = createDatabase(livePool);
    const controls = new RecoveryControls(db, { deploymentGeneration: GENERATION_A });
    await controls.initialize();
    const compose = new ComposeService(db, storage, controls);

    const [account] = await db
      .insert(accountsTable)
      .values({
        label: "Main mailbox",
        color: "#2563eb",
        username: USER,
        passwordEnc: "v1.unused",
        identities: [{ address: USER, name: "Main User", isDefault: true }],
      })
      .returning();
    accountId = account!.id;
    await db.insert(foldersTable).values({ accountId, name: "Sent", role: "sent" });

    const draft = await compose.createDraft(
      { requestGeneration: GENERATION_A },
      {
        accountId,
        recipients: { to: [TO], cc: [], bcc: [] },
        subject: "Across the restore",
        markdown: "# Across the restore\n\nThe backup holds this row as queued.",
      },
    );
    draftId = draft.id;

    const queued = await outbound(livePool, GENERATION_A).queueSend(
      { requestGeneration: GENERATION_A },
      { draftId, idempotencyKey: "restore-queued-send", baseRevision: 1 },
    );
    outboundId = queued.outbound.id;
    expect(queued.created).toBe(true);

    // The off-box backup: a consistent copy that still sees the row queued.
    await livePool.end();
    await adminQuery(`create database ${backupName} template ${liveName}`);
    livePool = openPool(liveName);

    // The worker completes the send after the backup window.
    const executed = await outbound(livePool, GENERATION_A).executeOutbound(outboundId);
    expect(executed.submitted).toBe(true);
    expect(executed.status).toBe("sent");
    expect(submissions()).toBe(1);

    // The live database is lost; the backup returns under generation B.
    await livePool.end();
    restoredPool = openPool(backupName);
    await restoredPool.query("select 1");
  });

  it("keeps outbound workers paused and refuses completion while the send is undispositioned", async () => {
    const db = createDatabase(restoredPool);
    const controls = new RecoveryControls(db, { deploymentGeneration: GENERATION_B });
    const send = outbound(restoredPool, GENERATION_B);

    // The restored row is queued under the old generation.
    const rows = await db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId));
    expect(rows[0]!.status).toBe("queued");

    await expect(controls.readStatus()).resolves.toMatchObject({ state: "generation_mismatch" });
    await expect(send.executeQueued(10)).resolves.toMatchObject({ blocked: true, submitted: 0 });
    await expect(send.appendDueSentCopies(10)).resolves.toMatchObject({ blocked: true });
    await expect(send.recoverAbandonedAttempts()).resolves.toMatchObject({ blocked: true });
    expect(submissions()).toBe(1);

    // Recovery begins; the workers stay paused while the service reconciles,
    // and the restored row keeps its own generation (SPEC section 10).
    await expect(controls.beginRecovery()).resolves.toMatchObject({ result: "started" });
    await expect(send.executeQueued(10)).resolves.toMatchObject({ blocked: true, submitted: 0 });
    await expect(send.reconcileUnknownOutcomes(10)).resolves.toMatchObject({ blocked: true });
    expect((await db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)))[0]!.status).toBe(
      "queued",
    );
    expect(submissions()).toBe(1);

    // Completion refuses while the restored send lacks a disposition.
    await expect(controls.completeRecovery()).resolves.toMatchObject({
      result: "rejected",
      reason: "pending_operations",
      pendingOperations: { outboundMessages: 1 },
    });
  });

  it("holds the restored send as unknown, completes recovery, and keeps old jobs disabled", async () => {
    const db = createDatabase(restoredPool);
    const controls = new RecoveryControls(db, { deploymentGeneration: GENERATION_B });
    const send = outbound(restoredPool, GENERATION_B);

    // The operator's reconciliation of a restored pending send (SPEC section
    // 10, step 4): the server's durable response is not in the backup, so the
    // unresolved send is held as `outcome_unknown`. The admin command that
    // automates this hold does not exist yet; the state is the operator's.
    await db
      .update(outboundMessages)
      .set({
        status: "outcome_unknown",
        lastError: {
          code: "restored_generation",
          message: "The restored backup predates this send's outcome; it is held for review.",
        },
      })
      .where(eq(outboundMessages.id, outboundId));

    await expect(controls.completeRecovery()).resolves.toMatchObject({
      result: "completed",
      generation: GENERATION_B,
    });

    // Old jobs stay disabled after completion: the held send is not queued
    // work anymore, the reconciliation sweep skips it as stale, no evidence
    // exists to resolve it, and nothing submits it again.
    const swept = await send.executeQueued(10);
    expect(swept).toMatchObject({ blocked: false, submitted: 0, scanned: 0 });
    const reconciled = await send.reconcileUnknownOutcomes(10);
    expect(reconciled).toMatchObject({ skippedStale: 1, resolved: 0, blocked: false });
    const held = (await db.select().from(outboundMessages).where(eq(outboundMessages.id, outboundId)))[0]!;
    expect(held.status).toBe("outcome_unknown");
    expect(submissions()).toBe(1);

    // New work under the new generation submits exactly once more.
    const compose = new ComposeService(db, storage, controls);
    const draft = await compose.createDraft(
      { requestGeneration: GENERATION_B },
      {
        accountId,
        recipients: { to: [TO], cc: [], bcc: [] },
        subject: "After recovery",
        markdown: "# After recovery\n\nFresh work under the new generation.",
      },
    );
    const queued = await send.queueSend(
      { requestGeneration: GENERATION_B },
      { draftId: draft.id, idempotencyKey: `fresh-${randomUUID()}`, baseRevision: 1 },
    );
    await expect(send.executeQueued(10)).resolves.toMatchObject({ blocked: false, submitted: 1 });
    expect(
      (await db.select().from(outboundMessages).where(eq(outboundMessages.id, queued.outbound.id)))[0]!.status,
    ).toBe("sent");
    expect(submissions()).toBe(2);
  });
});
