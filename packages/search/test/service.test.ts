import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  dropTestDatabase,
  runMigrations,
  type EmailAddress,
  type MailHubDatabase,
  type Recipients,
} from "@mail-hub/database";
import { RecoveryBlockedError, type MutationGate } from "@mail-hub/recovery";
import { SearchService, type SearchHit } from "../src/index.ts";

/**
 * Search behavior against a real PostgreSQL (SPEC F5): one box across
 * accounts, headers before bodies, operators, ranking, highlights, scope,
 * retained local records, and saved-search query state. Set
 * `TEST_DATABASE_URL` to a connection string whose user may create
 * databases; a throwaway database is created per run. Without the variable
 * the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "11111111-1111-4111-8111-111111111111";

/** One seeded message with every column the search reads. */
interface SeedMessage {
  accountId: string;
  subject: string | null;
  subjectText: string;
  senderText: string;
  sender?: EmailAddress | null;
  recipients?: Recipients | null;
  recipientsText?: string;
  bodyIndexText?: string;
  fetchedBody?: boolean;
  sentAt?: Date | null;
  hasAttachments?: boolean;
  classHint?: string | null;
  asksAction?: boolean | null;
}

suite("SearchService", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let db: MailHubDatabase;
  let service: SearchService;
  let gate: MutationGate;

  // The seeded world: two accounts, three folders, eight messages.
  let accountA: string;
  let accountB: string;
  let inboxA: string;
  let archiveA: string;
  let inboxB: string;
  let m1: string;
  let m2: string;
  let m3: string;
  let m4: string;
  let m5: string;
  let m6: string;
  let m7: string;
  let m8: string;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await admin.query(`create database ${databaseName}`);
    await admin.end();

    const url = new URL(testDatabaseUrl!);
    url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.toString() });
    await runMigrations(pool);
    db = createDatabase(pool);

    gate = { gateMutation: vi.fn(async () => ({ generation: GENERATION })) };
    service = new SearchService(db, gate);

    accountA = await seedAccount("Main", "#2563eb", "main@hub.example");
    accountB = await seedAccount("Side", "#dc2626", "side@hub.example");
    inboxA = await seedFolder(accountA, "INBOX", "inbox");
    archiveA = await seedFolder(accountA, "Archive", "archive");
    inboxB = await seedFolder(accountB, "INBOX", "inbox");

    m1 = await seedMessage({
      accountId: accountA,
      subject: "Quarterly report",
      subjectText: "quarterly report",
      senderText: "alice alice@work.example",
      sender: { address: "alice@work.example", name: "Alice" },
      recipients: { to: [{ address: "team@work.example", name: null }] },
      recipientsText: "team@work.example",
      bodyIndexText: "numbers are great in the appendix",
      fetchedBody: true,
      sentAt: new Date("2026-09-10T12:00:00Z"),
    });
    await seedOccurrence(m1, accountA, inboxA, "2026-09-10T12:01:00Z", { unread: true });

    m2 = await seedMessage({
      accountId: accountB,
      subject: "Travel plans",
      subjectText: "travel plans",
      senderText: "bob bob@other.example",
      sender: { address: "bob@other.example", name: "Bob" },
      recipients: { to: [{ address: "hr@work.example", name: null }] },
      recipientsText: "hr@work.example",
      bodyIndexText: "nothing but postcards",
      fetchedBody: true,
      sentAt: new Date("2026-09-12T09:00:00Z"),
    });
    await seedOccurrence(m2, accountB, inboxB, "2026-09-12T09:01:00Z", { flagged: true });

    // Header-only import: no body text yet, so only the header matches.
    m3 = await seedMessage({
      accountId: accountA,
      subject: "Quarterly report followup",
      subjectText: "quarterly report followup",
      senderText: "carol carol@work.example",
      sender: { address: "carol@work.example", name: "Carol" },
      fetchedBody: false,
      sentAt: new Date("2026-09-11T08:00:00Z"),
    });
    await seedOccurrence(m3, accountA, archiveA, "2026-09-11T08:01:00Z");

    // Body-only match: the subject says nothing about the term.
    m4 = await seedMessage({
      accountId: accountA,
      subject: "Lunch",
      subjectText: "lunch",
      senderText: "dave dave@side.example",
      sender: { address: "dave@side.example", name: "Dave" },
      bodyIndexText: "the quarterly numbers attach tomorrow",
      fetchedBody: true,
      sentAt: new Date("2026-09-13T10:00:00Z"),
    });
    await seedOccurrence(m4, accountA, inboxA, "2026-09-13T10:01:00Z", { unread: true, flagged: true });

    // Retained local record: every occurrence left the server.
    m5 = await seedMessage({
      accountId: accountA,
      subject: "Quarterly ghost",
      subjectText: "quarterly ghost",
      senderText: "erin erin@old.example",
      fetchedBody: false,
      sentAt: new Date("2026-09-14T10:00:00Z"),
    });
    await seedOccurrence(m5, accountA, inboxA, "2026-09-14T10:01:00Z");
    await pool.query(`update message_occurrences set expunged_at = now() where message_id = $1`, [m5]);

    m6 = await seedMessage({
      accountId: accountB,
      subject: "Newsletter",
      subjectText: "newsletter",
      senderText: "picks picks@news.example",
      bodyIndexText: "weekly picks and a receipt",
      fetchedBody: true,
      sentAt: new Date("2026-09-15T10:00:00Z"),
      hasAttachments: true,
      classHint: "newsletter",
      asksAction: true,
    });
    await seedOccurrence(m6, accountB, inboxB, "2026-09-15T10:01:00Z");

    // Outgoing record: accepted, Sent copy still pending, no occurrence yet.
    m7 = await seedMessage({
      accountId: accountA,
      subject: "Re: Quarterly report",
      subjectText: "re: quarterly report",
      senderText: "main main@hub.example",
      bodyIndexText: "sending the numbers along",
      fetchedBody: true,
      sentAt: new Date("2026-09-16T10:00:00Z"),
    });
    await pool.query(
      `insert into outbound_messages (
         account_id, recovery_generation, idempotency_key, request_hash, draft_revision,
         identity, envelope_sender, envelope_recipients, status, logical_message_id,
         recipients, subject, markdown_source, rfc_message_id, mime_storage_key, mime_sha256
       ) values ($1,$2,$3,$4,1,$5,$6,$7,'sent',$8,$9,$10,'','<out-1@hub.example>','out/1','${"0".repeat(64)}')`,
      [
        accountA,
        GENERATION,
        `send-${randomUUID()}`,
        "hash",
        JSON.stringify({ address: "main@hub.example", name: null }),
        "main@hub.example",
        JSON.stringify(["team@work.example"]),
        m7,
        JSON.stringify({ to: [{ address: "team@work.example", name: null }] }),
        "Re: Quarterly report",
      ],
    );

    // No sent time: the earliest server internal date answers date operators.
    m8 = await seedMessage({
      accountId: accountA,
      subject: "Server dated",
      subjectText: "server dated",
      senderText: "frank frank@work.example",
      fetchedBody: false,
      sentAt: null,
    });
    await seedOccurrence(m8, accountA, inboxA, "2026-08-15T09:00:00Z");
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: maintenanceUrl() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

  function maintenanceUrl(): string {
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    return url.toString();
  }

  async function seedAccount(label: string, color: string, username: string): Promise<string> {
    const result = await pool.query(
      `insert into accounts (label, color, username, password_enc) values ($1,$2,$3,'v1:ct') returning id`,
      [label, color, username],
    );
    return result.rows[0]!.id as string;
  }

  async function seedFolder(accountId: string, name: string, role: string): Promise<string> {
    const result = await pool.query(
      `insert into folders (account_id, name, role, uidvalidity) values ($1,$2,$3,1) returning id`,
      [accountId, name, role],
    );
    return result.rows[0]!.id as string;
  }

  async function seedMessage(message: SeedMessage): Promise<string> {
    const result = await pool.query(
      `insert into messages (
         account_id, subject, subject_text, sender_text, sender, recipients, recipients_text,
         body_index_text, fetched_body, sent_at, has_attachments, class_hint, asks_action,
         thread_link_state, thread_dirty
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'root',false) returning id`,
      [
        message.accountId,
        message.subject,
        message.subjectText,
        message.senderText,
        message.sender === null || message.sender === undefined ? null : JSON.stringify(message.sender),
        message.recipients === null || message.recipients === undefined
          ? null
          : JSON.stringify(message.recipients),
        message.recipientsText ?? "",
        message.bodyIndexText ?? "",
        message.fetchedBody ?? false,
        message.sentAt ?? null,
        message.hasAttachments ?? false,
        message.classHint ?? null,
        message.asksAction ?? null,
      ],
    );
    return result.rows[0]!.id as string;
  }

  async function seedOccurrence(
    messageId: string,
    accountId: string,
    folderId: string,
    internalDate: string,
    flags: { unread?: boolean; flagged?: boolean } = {},
  ): Promise<void> {
    await pool.query(
      `insert into message_occurrences (account_id, message_id, folder_id, uidvalidity, uid, internal_date, unread, flagged)
       values ($1,$2,$3,1,(select coalesce(max(uid),0)+1 from message_occurrences where folder_id = $3),$4,$5,$6)`,
      [accountId, messageId, folderId, internalDate, flags.unread ?? false, flags.flagged ?? false],
    );
  }

  /** Run one search and index the hits by message id. */
  async function searchMap(input: {
    query: string;
    accountIds?: string[] | null;
    folderId?: string | null;
    domains?: string[] | null;
    localOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<Map<string, SearchHit>> {
    const result = await service.search(input);
    return new Map(result.results.map((hit) => [hit.messageId, hit]));
  }

  it("searches free text across every account", async () => {
    const hits = await searchMap({ query: "quarterly" });
    expect([...hits.keys()].sort()).toEqual([m1, m3, m4, m5, m7].sort());
    expect(hits.get(m1)!.accountLabel).toBe("Main");
    expect(hits.get(m1)!.accountColor).toBe("#2563eb");
    expect(hits.get(m3)!.fetchedBody).toBe(false);
  });

  it("matches a phrase only when the words stay adjacent", async () => {
    const hits = await searchMap({ query: '"quarterly report"' });
    expect([...hits.keys()].sort()).toEqual([m1, m3, m7].sort());
  });

  it("finds body text only where the body was indexed", async () => {
    const hits = await searchMap({ query: "appendix" });
    expect([...hits.keys()]).toEqual([m1]);
    expect(hits.get(m1)!.highlightSource).toBe("body");
    expect(hits.get(m1)!.highlight).toContain("[appendix]");
  });

  it("ranks a header hit above a body hit", async () => {
    const hits = await searchMap({ query: "quarterly" });
    expect(hits.get(m1)!.rank).not.toBeNull();
    expect(hits.get(m1)!.rank!).toBeGreaterThan(hits.get(m4)!.rank!);
    expect(hits.get(m1)!.highlightSource).toBe("subject");
    expect(hits.get(m1)!.highlight).toContain("[Quarterly]");
  });

  it("orders operator-only results by effective date, newest first", async () => {
    const result = await service.search({ query: "" });
    expect(result.total).toBe(8);
    expect(result.results.map((hit) => hit.messageId)).toEqual([m7, m6, m5, m4, m2, m3, m1, m8]);
    expect(result.results[0]!.rank).toBeNull();
    expect(result.results[0]!.highlight).toBeNull();
  });

  it("answers from:, to:, and domain: operators", async () => {
    expect([...(await searchMap({ query: "from:alice" })).keys()]).toEqual([m1]);
    expect([...(await searchMap({ query: "to:hr" })).keys()]).toEqual([m2]);
    const byDomain = await searchMap({ query: "domain:work.example" });
    // alice, carol, and frank send from the domain; m2 only receives there.
    expect([...byDomain.keys()].sort()).toEqual([m1, m2, m3, m8].sort());
    const chips = await searchMap({ query: "", domains: ["work.example"] });
    expect([...chips.keys()].sort()).toEqual([m1, m2, m3, m8].sort());
  });

  it("escapes wildcard characters in operator values", async () => {
    // Without escaping, `bo_` would match the sender text of m2 ("bob").
    expect([...(await searchMap({ query: "from:bo_" })).keys()]).toEqual([]);
    expect([...(await searchMap({ query: "to:team%" })).keys()]).toEqual([]);
  });

  it("matches flags against active occurrences in the selected scope", async () => {
    const unread = await searchMap({ query: "is:unread" });
    expect([...unread.keys()].sort()).toEqual([m1, m4].sort());
    const flaggedInArchive = await searchMap({ query: "is:flagged", folderId: archiveA });
    expect([...flaggedInArchive.keys()]).toEqual([]);
    const unreadInInboxA = await searchMap({ query: "is:unread", folderId: inboxA });
    expect([...unreadInInboxA.keys()].sort()).toEqual([m1, m4].sort());

    // The row freezes its occurrences for mail actions (SPEC F4): a folder
    // scope carries only its own, and a retained record carries none.
    expect(unreadInInboxA.get(m1)!.occurrences).toHaveLength(1);
    expect(unreadInInboxA.get(m1)!.occurrences[0]!.folderId).toBe(inboxA);
    const local = await searchMap({ query: "", localOnly: true });
    expect(local.get(m5)!.occurrences).toEqual([]);
  });

  it("narrows by account chips and folder scope", async () => {
    const accountScoped = await searchMap({ query: "quarterly", accountIds: [accountA] });
    expect([...accountScoped.keys()].sort()).toEqual([m1, m3, m4, m5, m7].sort());
    const folderScoped = await searchMap({ query: "quarterly", folderId: inboxA });
    expect([...folderScoped.keys()].sort()).toEqual([m1, m4].sort());
  });

  it("answers attachment, type, and action operators", async () => {
    expect([...(await searchMap({ query: "has:attachment" })).keys()]).toEqual([m6]);
    expect([...(await searchMap({ query: "type:newsletter" })).keys()]).toEqual([m6]);
    expect([...(await searchMap({ query: "is:action" })).keys()]).toEqual([m6]);
  });

  it("uses exclusive UTC date boundaries against the effective send time", async () => {
    const before = await searchMap({ query: "before:2026-09-10" });
    expect(before.has(m1)).toBe(false);
    expect(before.has(m8)).toBe(true);

    const after = await searchMap({ query: "after:2026-09-10" });
    expect(after.has(m1)).toBe(true);

    const serverDated = await searchMap({ query: "server after:2026-08-15" });
    expect([...serverDated.keys()]).toEqual([m8]);
    expect(serverDated.get(m8)!.sentAt!.toISOString()).toBe("2026-08-15T09:00:00.000Z");
  });

  it("selects retained local records and reports outgoing copies", async () => {
    const local = await searchMap({ query: "", localOnly: true });
    expect([...local.keys()].sort()).toEqual([m5, m7].sort());
    expect(local.get(m5)!.noServerCopy).toBe(true);
    expect(local.get(m7)!.sentCopyStatus).toBe("pending");

    const sent = await searchMap({ query: "sending" });
    expect([...sent.keys()]).toEqual([m7]);
    expect(sent.get(m7)!.noServerCopy).toBe(true);
    expect(sent.get(m7)!.activeOccurrences).toBe(0);
  });

  it("pages results and reports the full total", async () => {
    const page = await service.search({ query: "", limit: 3, offset: 3 });
    expect(page.total).toBe(8);
    expect(page.results.map((hit) => hit.messageId)).toEqual([m4, m2, m3]);
  });

  it("reports body-indexing progress across the account scope", async () => {
    const result = await service.search({ query: "quarterly", accountIds: [accountA] });
    expect(result.indexing).toEqual({ messages: 6, bodies: 3 });
  });

  it("rejects invalid queries and filters", async () => {
    await expect(service.search({ query: "color:red" })).rejects.toMatchObject({
      code: "invalid_query",
      httpStatus: 400,
    });
    await expect(service.search({ query: "before:2026-02-30" })).rejects.toMatchObject({
      code: "invalid_query",
    });
    await expect(
      service.search({ query: "", accountIds: [accountA, "not-a-uuid"] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.search({ query: "", domains: ["bad_domain"] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.search({ query: "", limit: 0 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.search({ query: "", limit: 101 })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.search({ query: "", folderId: "nope" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.search({ query: "x".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  describe("saved searches", () => {
    it("stores query state, lists it, and deletes it", async () => {
      const saved = await service.createSavedSearch(
        { requestGeneration: GENERATION },
        { name: "Unread work", query: "is:unread from:work.example", scope: { accountIds: [accountA] } },
      );
      expect(saved.query).toBe("is:unread from:work.example");
      expect(saved.scope).toEqual({ accountIds: [accountA] });

      const listed = await service.listSavedSearches();
      expect(listed.map((row) => row.id)).toContain(saved.id);

      await service.deleteSavedSearch({ requestGeneration: GENERATION }, saved.id);
      expect((await service.listSavedSearches()).map((row) => row.id)).not.toContain(saved.id);
      await expect(service.deleteSavedSearch({ requestGeneration: GENERATION }, saved.id)).rejects.toMatchObject(
        { code: "not_found" },
      );

      const events = await pool.query(
        `select type from events where entity_type = 'saved_search' order by at`,
      );
      expect(events.rows.map((row) => row.type)).toEqual(["search.saved_created", "search.saved_deleted"]);
    });

    it("rejects invalid names, invalid queries, and duplicate names", async () => {
      await expect(
        service.createSavedSearch({ requestGeneration: GENERATION }, { name: "  ", query: "x" }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        service.createSavedSearch({ requestGeneration: GENERATION }, { name: "Broken", query: "color:red" }),
      ).rejects.toMatchObject({ code: "invalid_query" });
      await expect(
        service.createSavedSearch(
          { requestGeneration: GENERATION },
          { name: "Broken", query: "x", scope: { accountIds: ["nope"] } },
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });

      await service.createSavedSearch({ requestGeneration: GENERATION }, { name: "One", query: "receipts" });
      await expect(
        service.createSavedSearch({ requestGeneration: GENERATION }, { name: "One", query: "invoices" }),
      ).rejects.toMatchObject({ code: "name_conflict", httpStatus: 409 });
      await service.deleteSavedSearch({ requestGeneration: GENERATION }, (await service.listSavedSearches()).find((row) => row.name === "One")!.id);
    });

    it("gates mutations with the recovery generation before writing", async () => {
      // This vitest major clears mock state between tests, so the call is
      // observed from this test's own mutation.
      const gated = vi.mocked(gate.gateMutation);
      await service.createSavedSearch({ requestGeneration: GENERATION }, { name: "Gated", query: "receipts" });
      expect(gated).toHaveBeenCalledWith(GENERATION);
      expect(gated.mock.calls.at(-1)).toEqual([GENERATION]);
      const blocked: MutationGate = {
        gateMutation: async () => {
          throw new RecoveryBlockedError("recovery_required", "22222222-2222-4222-8222-222222222222");
        },
      };
      const blockedService = new SearchService(db, blocked);
      await expect(
        blockedService.createSavedSearch({ requestGeneration: "00000000-0000-4000-8000-000000000000" }, { name: "Nope", query: "x" }),
      ).rejects.toBeInstanceOf(RecoveryBlockedError);
      await expect(blockedService.deleteSavedSearch({}, randomUUID())).rejects.toBeInstanceOf(
        RecoveryBlockedError,
      );
      // Reads never touch the gate.
      await expect(blockedService.search({ query: "quarterly" })).resolves.toBeDefined();
      await expect(blockedService.listSavedSearches()).resolves.toBeDefined();
    });
  });

  it("matches from: and to: against addresses, not display names", async () => {
    // A spoofed sender: the display name carries the bait, the address does
    // not. The recipient list hides a mid-list address behind a name too.
    const spoof = await seedMessage({
      accountId: accountB,
      subject: "Account suspended",
      subjectText: "account suspended",
      senderText: "paypal support support@phish.example",
      sender: { address: "support@phish.example", name: "paypal support" },
      recipients: { to: [{ address: "payroll@corp.example", name: null }] },
      recipientsText: "main main@hub.example payrolldept payroll@corp.example",
      fetchedBody: false,
      sentAt: new Date("2026-09-17T10:00:00Z"),
    });
    await seedOccurrence(spoof, accountB, inboxB, "2026-09-17T10:01:00Z");

    // The bait in a display name never satisfies the filter.
    expect([...(await searchMap({ query: "from:paypal" })).keys()]).toEqual([]);
    expect([...(await searchMap({ query: "to:payrolldept" })).keys()]).toEqual([]);
    // The address answers: local part, domain, and full address.
    expect([...(await searchMap({ query: "from:support" })).keys()]).toEqual([spoof]);
    expect([...(await searchMap({ query: "from:@phish.example" })).keys()]).toEqual([spoof]);
    expect([...(await searchMap({ query: "from:support@phish.example" })).keys()]).toEqual([spoof]);
    // A mid-list address still answers a to: filter.
    expect([...(await searchMap({ query: "to:payroll@corp.example" })).keys()]).toEqual([spoof]);
  });

  it("reports the true total on a page past the last match", async () => {
    const pastEnd = await service.search({ query: "from:@phish.example", limit: 3, offset: 30 });
    expect(pastEnd.results).toEqual([]);
    // The page is out of range, not empty: the total still says one match
    // exists, so a client can page back instead of showing "no results".
    expect(pastEnd.total).toBe(1);

    // A filter with no matches at all reports zero, not a phantom count.
    const none = await service.search({ query: "from:ghost@nowhere.example", limit: 3, offset: 30 });
    expect(none.total).toBe(0);
  });
});
