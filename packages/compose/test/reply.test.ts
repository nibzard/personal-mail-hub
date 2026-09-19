import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accounts as accountsTable,
  bodies as bodiesTable,
  createDatabase,
  createStorage,
  drafts as draftsTable,
  events,
  messages as messagesTable,
  runMigrations,
  threads as threadsTable,
  type AccountIdentity,
  type EmailAddress,
  type MailHubDatabase,
  type Message,
  type Recipients,
  type Storage,
  dropTestDatabase,
} from "@mail-hub/database";
import { RecoveryControls } from "@mail-hub/recovery";
import {
  ComposeError,
  ComposeService,
  deriveReplyRecipients,
  extractValidMessageIds,
  freezeReplyReferences,
  preselectReplyIdentity,
  replySubject,
} from "../src/index.ts";

/**
 * Reply addressing and frozen reply headers (SPEC F6 and the reply
 * acceptance in section 12). The pure derivations run without a database;
 * the draft creation runs against a real PostgreSQL. Set
 * `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; without the variable the database suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";

const readyContext = { requestGeneration: GENERATION };
const staleGenerationContext = { requestGeneration: OTHER_GENERATION };

/** Convert one rejected promise into its typed rejection. */
async function rejection(promise: Promise<unknown>): Promise<ComposeError> {
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

/** Convert one throwing call into its typed rejection. */
function syncRejection(call: () => unknown): ComposeError {
  try {
    call();
  } catch (error) {
    if (error instanceof ComposeError) {
      return error;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it returned.");
}

const ALICE: EmailAddress = { address: "alice@example.com", name: "Alice" };
const BOB: EmailAddress = { address: "bob@example.com", name: null };
const USER: EmailAddress = { address: "user@example.com", name: "Main User" };
const ALIAS: EmailAddress = { address: "alias@example.com", name: null };

/** The configured identities the account fixtures carry. */
const IDENTITIES: AccountIdentity[] = [
  { ...USER, isDefault: true },
  { ...ALIAS, isDefault: false },
];

describe("reply derivation", () => {
  it("extracts only bracketed identifiers, deduplicated in order", () => {
    expect(extractValidMessageIds("<one@example.com> <two@example.com> <one@example.com>")).toEqual([
      "<one@example.com>",
      "<two@example.com>",
    ]);
    expect(extractValidMessageIds("one@example.com (no brackets)")).toEqual([]);
    expect(extractValidMessageIds(null)).toEqual([]);
  });

  it("freezes a chain: the parent's References followed by its identifier", () => {
    const frozen = freezeReplyReferences({
      messageId: "<three@example.com>",
      inReplyTo: "<two@example.com>",
      referenceIds: ["<one@example.com>", "<two@example.com>"],
    });
    expect(frozen).toEqual({
      inReplyTo: "<three@example.com>",
      referenceIds: ["<one@example.com>", "<two@example.com>", "<three@example.com>"],
    });
  });

  it("falls back to the single valid In-Reply-To when References is empty", () => {
    const frozen = freezeReplyReferences({
      messageId: "<three@example.com>",
      inReplyTo: "<two@example.com>",
      referenceIds: [],
    });
    expect(frozen).toEqual({
      inReplyTo: "<three@example.com>",
      referenceIds: ["<two@example.com>", "<three@example.com>"],
    });
  });

  it("omits unavailable identifiers and never invents them", () => {
    // No usable Message-ID: the reply carries no In-Reply-To, and the chain
    // keeps only the ancestor identifiers the parent itself provides.
    expect(
      freezeReplyReferences({ messageId: "junk", inReplyTo: "<two@example.com>", referenceIds: [] }),
    ).toEqual({ inReplyTo: null, referenceIds: ["<two@example.com>"] });
    // Several reply identifiers are not a single valid one; nothing is chosen.
    expect(
      freezeReplyReferences({
        messageId: null,
        inReplyTo: "<a@example.com> <b@example.com>",
        referenceIds: [],
      }),
    ).toEqual({ inReplyTo: null, referenceIds: [] });
    // A repeated identifier enters the chain once.
    expect(
      freezeReplyReferences({
        messageId: "<two@example.com>",
        inReplyTo: "<one@example.com>",
        referenceIds: ["<one@example.com>", "<two@example.com>"],
      }),
    ).toEqual({
      inReplyTo: "<two@example.com>",
      referenceIds: ["<one@example.com>", "<two@example.com>"],
    });
  });

  it("derives reply recipients from Reply-To, falling back to From", () => {
    expect(
      deriveReplyRecipients(
        { sender: ALICE, replyTo: [{ address: "Replies@Example.COM", name: "Replies" }], recipients: null },
        IDENTITIES,
        "reply",
      ),
    ).toEqual({ to: [{ address: "replies@example.com", name: "Replies" }], cc: [] });

    expect(deriveReplyRecipients({ sender: ALICE, replyTo: null, recipients: null }, IDENTITIES, "reply")).toEqual({
      to: [ALICE],
      cc: [],
    });
  });

  it("rejects a malformed or empty Reply-To and an empty result", () => {
    expect(
      syncRejection(() => deriveReplyRecipients({ sender: ALICE, replyTo: [], recipients: null }, IDENTITIES, "reply"))
        .code,
    ).toBe("recipients_required");
    expect(
      syncRejection(() => deriveReplyRecipients({ sender: null, replyTo: null, recipients: null }, IDENTITIES, "reply"))
        .code,
    ).toBe("recipients_required");
    // A Reply-To naming only this account's identities leaves nothing to send.
    expect(
      syncRejection(() =>
        deriveReplyRecipients(
          { sender: ALICE, replyTo: [USER, ALIAS], recipients: { to: [USER], cc: [] } },
          IDENTITIES,
          "reply_all",
        ),
      ).code,
    ).toBe("recipients_required");
  });

  it("derives reply-all lists without duplicates, identities, or Bcc copies", () => {
    const parent = {
      sender: ALICE,
      replyTo: null,
      recipients: {
        to: [BOB, { ...BOB }, USER],
        cc: [{ address: "BOB@example.com", name: "Duplicate" }, ALIAS],
        bcc: [{ address: "hidden@example.com", name: null }],
      } satisfies Recipients,
    };
    expect(deriveReplyRecipients(parent, IDENTITIES, "reply_all")).toEqual({
      to: [ALICE],
      cc: [BOB],
    });
  });

  it("reuses the visible recipients of your own sent message", () => {
    const parent = {
      sender: USER,
      replyTo: [ALICE],
      recipients: {
        to: [ALICE, USER],
        cc: [BOB],
        bcc: [{ address: "hidden@example.com", name: null }],
      } satisfies Recipients,
    };
    expect(deriveReplyRecipients(parent, IDENTITIES, "reply")).toEqual({
      to: [ALICE],
      cc: [BOB],
    });
    expect(deriveReplyRecipients(parent, IDENTITIES, "reply_all")).toEqual({
      to: [ALICE],
      cc: [BOB],
    });
  });

  it("preselects one identity only when exactly one matches To or Cc", () => {
    const configured = [
      { ...USER, isDefault: true },
      { ...ALIAS, isDefault: false },
    ];
    // Your own sent message reuses its sender identity.
    expect(preselectReplyIdentity({ sender: USER, replyTo: null, recipients: null }, configured)).toEqual({
      ...USER,
      isDefault: true,
    });
    // Exactly one alias match preselects.
    expect(
      preselectReplyIdentity(
        { sender: ALICE, replyTo: null, recipients: { to: [ALIAS], cc: [BOB] } },
        configured,
      ),
    ).toEqual({ ...ALIAS, isDefault: false });
    // Several matches stay ambiguous.
    expect(
      preselectReplyIdentity(
        { sender: ALICE, replyTo: null, recipients: { to: [USER], cc: [ALIAS] } },
        configured,
      ),
    ).toBeNull();
    // A blind copy has no visible match.
    expect(preselectReplyIdentity({ sender: ALICE, replyTo: null, recipients: null }, configured)).toBeNull();
  });

  it("prefixes the subject once and drops nothing else", () => {
    expect(replySubject("Quarterly report")).toBe("Re: Quarterly report");
    expect(replySubject("  RE: Quarterly report ")).toBe("RE: Quarterly report");
    expect(replySubject("  re: already answered")).toBe("re: already answered");
    expect(replySubject(null)).toBeNull();
    expect(replySubject("   ")).toBeNull();
  });
});

suite("reply drafts against PostgreSQL", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let db: MailHubDatabase;
  let pool: Pool;
  let storage: Storage;
  let service: ComposeService;
  let accountId: string;
  let secondAccountId: string;
  let threadId: string;

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
    storage = createStorage(await mkdtemp(join(tmpdir(), "mail-hub-reply-")));
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

    const thread = await db
      .insert(threadsTable)
      .values({ accountId, subjectNorm: "quarterly report" })
      .returning({ id: threadsTable.id });
    threadId = thread[0]!.id;
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  /** Insert one parent message row with explicit addressing headers. */
  async function insertMessage(row: {
    accountId: string;
    messageId?: string | null;
    inReplyTo?: string | null;
    referenceIds?: string[];
    sender?: EmailAddress | null;
    replyTo?: EmailAddress[] | null;
    recipients?: Recipients | null;
    subject?: string | null;
    threadId?: string | null;
    originalSha256?: string | null;
  }): Promise<Message> {
    const inserted = await db
      .insert(messagesTable)
      .values({
        accountId: row.accountId,
        messageId: row.messageId ?? null,
        inReplyTo: row.inReplyTo ?? null,
        referenceIds: row.referenceIds ?? [],
        sender: row.sender ?? null,
        replyTo: row.replyTo === undefined ? null : row.replyTo,
        recipients: row.recipients ?? null,
        subject: row.subject ?? null,
        threadId: row.threadId ?? null,
        originalSha256: row.originalSha256 ?? null,
      })
      .returning();
    return inserted[0]!;
  }

  it("seeds the quote from the parent body when no Markdown is given", async () => {
    const parent = await insertMessage({
      accountId,
      messageId: "<quoted@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
      subject: "Quote me",
      threadId,
    });
    await db.insert(bodiesTable).values({
      messageId: parent.id,
      htmlSanitized:
        "<div><p>The meter reading is 4021 on Thursday.</p>" +
        '<blockquote><p>Earlier reading was 3900.</p></blockquote></div>',
      textPlain: "The meter reading is 4021 on Thursday.",
      sanitizerVersion: "dompurify@3.4.15/config-1",
    });

    const draft = await service.createReplyDraft(readyContext, { messageId: parent.id, mode: "reply" });
    // The draft starts from the parent's Markdown blockquote, quoted chain
    // nested inside (SPEC F6). An explicit empty string stays empty.
    expect(draft.markdown).toBe(
      "> The meter reading is 4021 on Thursday.\n>\n> > Earlier reading was 3900.",
    );

    const explicit = await service.createReplyDraft(readyContext, {
      messageId: parent.id,
      mode: "reply",
      markdown: "",
    });
    expect(explicit.markdown).toBe("");

    // The audit event names the quote source, never the quoted text.
    const recorded = await db.select().from(events).where(eq(events.entityId, draft.id));
    expect(JSON.stringify(recorded)).toContain('"quoteSource":"extracted"');
    expect(JSON.stringify(recorded)).not.toContain("meter reading");
  });

  it("seeds the plain-text fallback for a parent without HTML", async () => {
    const parent = await insertMessage({
      accountId,
      messageId: "<plain-parent@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
      subject: "Plain parent",
      threadId,
    });
    await db.insert(bodiesTable).values({
      messageId: parent.id,
      htmlSanitized: null,
      textPlain: "Only a plain part exists.",
      sanitizerVersion: "dompurify@3.4.15/config-1",
    });

    const draft = await service.createReplyDraft(readyContext, { messageId: parent.id, mode: "reply" });
    expect(draft.markdown).toBe("> Only a plain part exists.");
  });

  it("addresses a reply from Reply-To and records an audit event", async () => {
    const parent = await insertMessage({
      accountId,
      messageId: "<parent@example.com>",
      sender: ALICE,
      replyTo: [{ address: "replies@lists.example.com", name: "List replies" }],
      recipients: { to: [USER], cc: [BOB] },
      subject: "Quarterly report",
      threadId,
    });

    const draft = await service.createReplyDraft(readyContext, { messageId: parent.id, mode: "reply" });
    expect(draft.accountId).toBe(accountId);
    expect(draft.identity).toEqual(USER);
    expect(draft.recipients).toEqual({
      to: [{ address: "replies@lists.example.com", name: "List replies" }],
      cc: [],
      bcc: [],
    });
    expect(draft.subject).toBe("Re: Quarterly report");
    expect(draft.replyParentId).toBe(parent.id);
    expect(draft.threadId).toBe(threadId);
    expect(draft.inReplyTo).toBe("<parent@example.com>");
    expect(draft.referenceIds).toEqual(["<parent@example.com>"]);
    expect(draft.markdown).toBe("");
    expect(draft.revision).toBe(1);

    const recorded = await db.select().from(events).where(eq(events.entityId, draft.id));
    expect(recorded.map((row) => row.type)).toContain("draft.reply_created");
    // Event payloads never carry message text (SPEC section 9).
    expect(JSON.stringify(recorded)).not.toContain("Quarterly report");
  });

  it("falls back to From when Reply-To is absent and requires correction when invalid", async () => {
    const absent = await insertMessage({
      accountId,
      messageId: "<absent@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
      threadId,
    });
    const draft = await service.createReplyDraft(readyContext, { messageId: absent.id, mode: "reply" });
    expect(draft.recipients.to).toEqual([ALICE]);

    const invalid = await insertMessage({
      accountId,
      messageId: "<invalid@example.com>",
      sender: ALICE,
      replyTo: [],
      recipients: { to: [USER] },
      threadId,
    });
    expect(
      (await rejection(service.createReplyDraft(readyContext, { messageId: invalid.id, mode: "reply" }))).code,
    ).toBe("recipients_required");

    // The correction path repeats the request with an explicit list.
    const corrected = await service.createReplyDraft(readyContext, {
      messageId: invalid.id,
      mode: "reply",
      recipients: { to: [ALICE] },
    });
    expect(corrected.recipients.to).toEqual([ALICE]);
  });

  it("derives reply-all lists without duplicates, identities, or Bcc copies", async () => {
    const parent = await insertMessage({
      accountId,
      messageId: "<all@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: {
        to: [USER, BOB, { address: "bob@example.com", name: "Duplicate Bob" }],
        cc: [ALIAS, { address: "carol@example.com", name: null }],
        bcc: [{ address: "hidden@example.com", name: null }],
      },
      subject: "Planning",
      threadId,
    });

    // To and Cc match both configured identities, so the From choice is
    // explicit; the derived lists still drop every configured identity.
    const draft = await service.createReplyDraft(readyContext, {
      messageId: parent.id,
      mode: "reply_all",
      identity: { address: "alias@example.com" },
    });
    expect(draft.identity).toEqual(ALIAS);
    expect(draft.recipients).toEqual({
      to: [ALICE],
      cc: [BOB, { address: "carol@example.com", name: null }],
      bcc: [],
    });
    expect(JSON.stringify(draft.recipients)).not.toContain("hidden@example.com");
    expect(JSON.stringify(draft.recipients)).not.toContain("user@example.com");
    expect(JSON.stringify(draft.recipients)).not.toContain("alias@example.com");
  });

  it("reuses the visible recipients and From of your own sent message", async () => {
    const parent = await insertMessage({
      accountId,
      messageId: "<own@example.com>",
      sender: USER,
      replyTo: null,
      recipients: {
        to: [ALICE, USER],
        cc: [BOB],
        bcc: [{ address: "hidden@example.com", name: null }],
      },
      subject: "Sent from here",
      threadId,
    });

    const draft = await service.createReplyDraft(readyContext, { messageId: parent.id, mode: "reply" });
    expect(draft.identity).toEqual(USER);
    expect(draft.recipients).toEqual({ to: [ALICE], cc: [BOB], bcc: [] });
    expect(JSON.stringify(draft.recipients)).not.toContain("hidden@example.com");
  });

  it("preselects one matching identity and requires a choice otherwise", async () => {
    const aliased = await insertMessage({
      accountId,
      messageId: "<aliased@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [ALIAS], cc: [BOB] },
      threadId,
    });
    const preselected = await service.createReplyDraft(readyContext, { messageId: aliased.id, mode: "reply" });
    expect(preselected.identity).toEqual(ALIAS);

    const ambiguous = await insertMessage({
      accountId,
      messageId: "<ambiguous@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER], cc: [ALIAS] },
      threadId,
    });
    expect(
      (await rejection(service.createReplyDraft(readyContext, { messageId: ambiguous.id, mode: "reply" }))).code,
    ).toBe("identity_choice_required");
    const chosen = await service.createReplyDraft(readyContext, {
      messageId: ambiguous.id,
      mode: "reply",
      identity: { address: "alias@example.com" },
    });
    expect(chosen.identity).toEqual(ALIAS);

    const blind = await insertMessage({
      accountId,
      messageId: "<blind@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: null,
      threadId,
    });
    expect(
      (await rejection(service.createReplyDraft(readyContext, { messageId: blind.id, mode: "reply" }))).code,
    ).toBe("identity_choice_required");
  });

  it("requires an account choice for a grouped copy held in two accounts", async () => {
    const sha256 = randomUUID();
    const held = await insertMessage({
      accountId,
      messageId: "<grouped@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
      originalSha256: sha256,
      threadId,
    });
    const copy = await insertMessage({
      accountId: secondAccountId,
      messageId: "<grouped@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [{ address: "second@example.com", name: "Second" }] },
      originalSha256: sha256,
    });

    expect(
      (await rejection(service.createReplyDraft(readyContext, { messageId: held.id, mode: "reply" }))).code,
    ).toBe("account_choice_required");

    // The chosen account must hold the byte-identical copy.
    expect(
      (
        await rejection(
          service.createReplyDraft(readyContext, {
            messageId: held.id,
            accountId: randomUUID(),
            mode: "reply",
          }),
        )
      ).code,
    ).toBe("invalid_request");

    const fromMain = await service.createReplyDraft(readyContext, {
      messageId: held.id,
      accountId,
      mode: "reply",
    });
    expect(fromMain.accountId).toBe(accountId);
    expect(fromMain.replyParentId).toBe(held.id);
    expect(fromMain.identity).toEqual(USER);

    // Replying through the second account targets its own copy row and
    // preselects the identity that copy addressed.
    const fromSecond = await service.createReplyDraft(readyContext, {
      messageId: held.id,
      accountId: secondAccountId,
      mode: "reply",
    });
    expect(fromSecond.accountId).toBe(secondAccountId);
    expect(fromSecond.replyParentId).toBe(copy.id);
    expect(fromSecond.identity).toEqual({ address: "second@example.com", name: "Second" });

    // Without a hash to group on, no choice is demanded.
    const ungrouped = await insertMessage({
      accountId,
      messageId: "<ungrouped@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
    });
    const plain = await service.createReplyDraft(readyContext, { messageId: ungrouped.id, mode: "reply" });
    expect(plain.accountId).toBe(accountId);
  });

  it("freezes the wire references across a three-message chain", async () => {
    await insertMessage({
      accountId,
      messageId: "<one@example.com>",
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
      subject: "Root",
      threadId,
    });
    await insertMessage({
      accountId,
      messageId: "<two@example.com>",
      inReplyTo: "<one@example.com>",
      referenceIds: ["<one@example.com>"],
      sender: USER,
      recipients: { to: [ALICE] },
      subject: "Re: Root",
      threadId,
    });
    const third = await insertMessage({
      accountId,
      messageId: "<three@example.com>",
      inReplyTo: "<two@example.com>",
      referenceIds: ["<one@example.com>", "<two@example.com>"],
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
      subject: "Re: Re: Root",
      threadId,
    });

    const draft = await service.createReplyDraft(readyContext, { messageId: third.id, mode: "reply_all" });
    expect(draft.inReplyTo).toBe("<three@example.com>");
    expect(draft.referenceIds).toEqual(["<one@example.com>", "<two@example.com>", "<three@example.com>"]);
  });

  it("keeps the frozen headers after a relink and after further edits", async () => {
    const parent = await insertMessage({
      accountId,
      messageId: "<frozen@example.com>",
      inReplyTo: "<one@example.com>",
      referenceIds: ["<one@example.com>"],
      sender: ALICE,
      replyTo: null,
      recipients: { to: [USER] },
      subject: "Frozen context",
      threadId,
    });
    const draft = await service.createReplyDraft(readyContext, { messageId: parent.id, mode: "reply" });

    // Thread membership changes after the draft exists (SPEC F6: the queued
    // snapshot preserves these headers even if thread membership changes).
    const moved = await db.insert(threadsTable).values({ accountId, subjectNorm: "moved" }).returning({ id: threadsTable.id });
    await db
      .update(messagesTable)
      .set({ threadId: moved[0]!.id })
      .where(eq(messagesTable.id, parent.id));

    const edited = await service.updateDraft(readyContext, draft.id, {
      baseRevision: draft.revision,
      markdown: "typed a reply",
      subject: "Re: Frozen context (edited)",
    });
    expect(edited.revision).toBe(draft.revision + 1);
    expect(edited.markdown).toBe("typed a reply");

    const stored = (await db.select().from(draftsTable).where(eq(draftsTable.id, draft.id)))[0]!;
    expect(stored.replyParentId).toBe(parent.id);
    expect(stored.threadId).toBe(threadId);
    expect(stored.inReplyTo).toBe("<frozen@example.com>");
    expect(stored.referenceIds).toEqual(["<one@example.com>", "<frozen@example.com>"]);
  });

  it("keeps the reply gate and identifier rules in force", async () => {
    await expect(
      service.createReplyDraft(staleGenerationContext, { messageId: randomUUID(), mode: "reply" }),
    ).rejects.toMatchObject({ code: "recovery_required" });
    expect(
      (await rejection(service.createReplyDraft(readyContext, { messageId: "not-a-uuid", mode: "reply" }))).code,
    ).toBe("invalid_request");
    expect(
      (
        await rejection(
          service.createReplyDraft(readyContext, {
            messageId: randomUUID(),
            mode: "forward" as unknown as "reply",
          }),
        )
      ).code,
    ).toBe("invalid_request");
    expect(
      (await rejection(service.createReplyDraft(readyContext, { messageId: randomUUID(), mode: "reply" }))).code,
    ).toBe("not_found");
  });
});
