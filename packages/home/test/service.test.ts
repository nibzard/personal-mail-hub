import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppSettings, MessageClass, SuggestionSource } from "@mail-hub/contracts";
import {
  createDatabase,
  dropTestDatabase,
  events,
  homeWork,
  runMigrations,
  type MailHubDatabase,
} from "@mail-hub/database";
import { RecoveryBlockedError, type MutationGate } from "@mail-hub/recovery";
import {
  compareAttention,
  attentionTier,
  HomeError,
  HomeService,
  type CircuitReader,
  type HomeMutationContext,
  type HomeSectionResult,
  type SettingsReader,
} from "../src/index.ts";

/**
 * Home behavior against a real PostgreSQL (SPEC F13): the five sections,
 * deterministic ranking that resolves before pagination, conversation
 * grouping, visit tracking, coverage, dismissals, and the recovery-gated
 * work mutations with revision conflicts. Set `TEST_DATABASE_URL` to a
 * connection string whose user may create databases; a throwaway database
 * is created per run. Without the variable the suite skips.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const suite = testDatabaseUrl === undefined ? describe.skip : describe;

const GENERATION = "11111111-1111-4111-8111-111111111111";
const OTHER_GENERATION = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-20T12:00:00Z");
const DEVICE = "device-test-0001";

const readyContext: HomeMutationContext = { requestGeneration: GENERATION };

/** Convert a rejected promise into its Home or recovery rejection. */
async function rejection(promise: Promise<unknown>): Promise<HomeError | RecoveryBlockedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HomeError || error instanceof RecoveryBlockedError) {
      return error;
    }
    throw error;
  }
  throw new Error("The call was expected to reject, but it resolved.");
}

suite("HomeService", () => {
  const databaseName = `mail_hub_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let pool: Pool;
  let db: MailHubDatabase;
  let service: HomeService;

  // The mutable readers coverage depends on.
  const settingsState: AppSettings = {
    theme: "system",
    density: "compact",
    singleKeyShortcuts: true,
    cleanViewDefault: false,
    classificationEnabled: true,
    homeEnabled: true,
    classificationMonthlyCostCapUsd: null,
    backfillClassification: false,
  };
  const settingsReader: SettingsReader = { readSettings: async () => ({ ...settingsState }) };
  const circuitState: { circuit: "closed" | "open"; description: string } = {
    circuit: "closed",
    description: "Classification is running.",
  };
  const circuitReader: CircuitReader = { readCircuit: async () => ({ ...circuitState }) };

  const gate: MutationGate = {
    async gateMutation(requestGeneration?: string | null) {
      if (requestGeneration === undefined || requestGeneration === null) {
        throw new RecoveryBlockedError("invalid_recovery_generation");
      }
      if (requestGeneration !== GENERATION) {
        throw new RecoveryBlockedError("recovery_required", GENERATION);
      }
      return { generation: GENERATION };
    },
  };

  // The seeded world.
  let accountA: string;
  let accountB: string;
  let inboxA: string;
  let archiveA: string;
  let junkA: string;
  let inboxB: string;
  const ids = new Map<string, string>();
  const THREAD = "33333333-3333-4333-8333-333333333333";

  let reminderFutureId: string;

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

    service = new HomeService(db, gate, {
      settings: settingsReader,
      circuit: circuitReader,
      now: () => NOW,
    });

    accountA = await seedAccount("Main", "#2563eb", "main@hub.example");
    accountB = await seedAccount("Side", "#dc2626", "side@hub.example");
    inboxA = await seedFolder(accountA, "INBOX", "inbox");
    archiveA = await seedFolder(accountA, "Archive", "archive");
    junkA = await seedFolder(accountA, "Junk", "junk");
    inboxB = await seedFolder(accountB, "INBOX", "inbox");

    // Attention tier 0: a security alert, a protected high-confidence action
    // answer, and an old message an explicit sender priority covers.
    await seed("sec", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-18T10:00:00Z",
      classHint: "security_alert",
      classSource: "jev",
      unread: true,
    });
    await seed("highAction", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-15T09:00:00Z",
      asksAction: true,
      classSource: "jev",
      actionConfidence: 0.9,
    });
    await seed("priorityOld", {
      account: accountA,
      folder: inboxA,
      sentAt: "2020-01-01T00:00:00Z",
      sender: "bank@old.example",
    });

    // Attention tier 1: an action answer below the threshold, a reply
    // suggestion from a rule, a manual answer the owner made, and a
    // two-message conversation that must group into one entry.
    await seed("lowAction", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-19T09:00:00Z",
      asksAction: true,
      classSource: "jev",
      actionConfidence: 0.4,
    });
    await seed("reply", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-17T09:00:00Z",
      asksReply: true,
      classSource: "rule",
    });
    await seed("manualAction", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-16T09:00:00Z",
      asksAction: true,
      classSource: "manual",
    });
    // The conversation both thread messages belong to.
    await pool.query(`insert into threads (id, account_id) values ($1,$2)`, [THREAD, accountA]);
    await seed("threadA", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-02T09:00:00Z",
      asksReply: true,
      classSource: "jev",
      thread: THREAD,
    });
    await seed("threadB", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-03T09:00:00Z",
      asksReply: true,
      classSource: "jev",
      thread: THREAD,
    });

    // Hidden from attention: no signal, dismissed, or outside the inbox.
    await seed("plain", { account: accountA, folder: inboxA, sentAt: "2026-09-19T12:00:00Z" });
    await seed("dismissedMsg", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-19T10:00:00Z",
      asksReply: true,
      classSource: "jev",
    });
    await pool.query(`insert into home_dismissals (account_id, message_id) values ($1,$2)`, [
      accountA,
      ids.get("dismissedMsg"),
    ]);
    await seed("archivedAction", {
      account: accountA,
      folder: archiveA,
      sentAt: "2026-09-19T11:00:00Z",
      asksAction: true,
      classSource: "jev",
    });

    // Saved: stars in two accounts, with junk stars excluded.
    await seed("flaggedSaved", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-05T09:00:00Z",
      flagged: true,
    });
    await seed("flaggedJunk", {
      account: accountA,
      folder: junkA,
      sentAt: "2026-09-06T09:00:00Z",
      flagged: true,
    });
    await seed("flaggedB", {
      account: accountB,
      folder: inboxB,
      sentAt: "2026-09-07T09:00:00Z",
      flagged: true,
    });

    // Work anchors: a due reminder, a future reminder, and reply-later
    // commitments on two conversations.
    await seed("reminderDue", { account: accountA, folder: inboxA, sentAt: "2026-09-01T09:00:00Z" });
    await seed("reminderFuture", { account: accountA, folder: inboxA, sentAt: "2026-08-30T09:00:00Z" });
    await seed("replyLaterAnchor", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-04T09:00:00Z",
    });

    await pool.query(
      `insert into home_work (account_id, anchor_message_id, thread_id, kind, status, due_at, time_zone, created_at, updated_at)
       values ($1,$2,null,'reminder','open',$3,'UTC','2026-09-01T08:00:00Z','2026-09-01T08:00:00Z')`,
      [accountA, ids.get("reminderDue"), "2026-09-20T11:00:00Z"],
    );
    await pool.query(
      `insert into home_work (account_id, anchor_message_id, thread_id, kind, status, due_at, time_zone, created_at, updated_at)
       values ($1,$2,null,'reminder','open',$3,'Europe/Berlin','2026-09-01T09:00:00Z','2026-09-01T09:00:00Z')`,
      [accountA, ids.get("reminderFuture"), "2026-09-21T09:00:00Z"],
    );
    reminderFutureId = (
      await pool.query(`select id from home_work where anchor_message_id = $1`, [ids.get("reminderFuture")])
    ).rows[0]!.id as string;
    await pool.query(
      `insert into home_work (account_id, anchor_message_id, thread_id, kind, status, created_at, updated_at)
       values ($1,$2,null,'reply_later','open','2026-09-10T08:00:00Z','2026-09-10T08:00:00Z')`,
      [accountA, ids.get("replyLaterAnchor")],
    );
    await pool.query(
      `insert into home_work (account_id, anchor_message_id, thread_id, kind, status, created_at, updated_at)
       values ($1,$2,$3,'reply_later','open','2026-09-12T08:00:00Z','2026-09-12T08:00:00Z')`,
      [accountA, ids.get("threadB"), THREAD],
    );

    // The explicit priority choice, recorded through the service itself.
    await service.setPriority(readyContext, {
      accountId: accountA,
      target: { kind: "sender", sender: "Bank@Old.example" },
      prioritized: true,
    });
  });

  afterAll(async () => {
    await pool?.end();
    const url = new URL(testDatabaseUrl!);
    url.pathname = "/postgres";
    const admin = new Pool({ connectionString: url.toString() });
    await dropTestDatabase(admin, databaseName);
    await admin.end();
  });

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

  /** Seed one message with an occurrence; the arrival time equals the send time. */
  async function seed(
    key: string,
    input: {
      account: string;
      folder: string;
      sentAt: string;
      sender?: string;
      subject?: string;
      thread?: string;
      classHint?: string;
      classSource?: string;
      asksAction?: boolean;
      asksReply?: boolean;
      timeSensitive?: boolean;
      actionConfidence?: number;
      unread?: boolean;
      flagged?: boolean;
      ingestedAt?: string;
    },
  ): Promise<void> {
    const inserted = await pool.query(
      `insert into messages (
         account_id, thread_id, subject, sender, sent_at, ingested_at, snippet,
         class_hint, asks_action, asks_reply, time_sensitive,
         metadata, thread_link_state, thread_dirty
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'root',false) returning id`,
      [
        input.account,
        input.thread ?? null,
        input.subject ?? `Message ${key}`,
        input.sender === undefined ? null : JSON.stringify({ address: input.sender, name: null }),
        input.sentAt,
        input.ingestedAt ?? input.sentAt,
        `Snippet of ${key}`,
        input.classHint ?? null,
        input.asksAction ?? null,
        input.asksReply ?? null,
        input.timeSensitive ?? null,
        input.classSource === undefined ? {} : JSON.stringify({ classSource: input.classSource }),
      ],
    );
    const id = inserted.rows[0]!.id as string;
    ids.set(key, id);
    await pool.query(
      `insert into message_occurrences (account_id, message_id, folder_id, uidvalidity, uid, internal_date, unread, flagged)
       values ($1,$2,$3,1,(select coalesce(max(uid),0)+1 from message_occurrences where folder_id = $3),$4,$5,$6)`,
      [input.account, id, input.folder, input.sentAt, input.unread ?? false, input.flagged ?? false],
    );
    if (input.actionConfidence !== undefined) {
      await pool.query(
        `insert into decisions (message_id, input_hash, model, question_set, answers, confidence, created_at)
         values ($1,'hash','jev-test','v1','{}',$2,$3)`,
        [id, JSON.stringify({ asks_action: input.actionConfidence }), input.sentAt],
      );
    }
  }

  function id(key: string): string {
    return ids.get(key)!;
  }

  /** The section with the given id, from one full read. */
  async function readSectionOnce(section: string, deviceId = DEVICE): Promise<HomeSectionResult> {
    const answer = await service.readHome({ deviceId });
    return answer.sections.find((entry) => entry.id === section)!;
  }

  it("assembles every section with accurate totals", async () => {
    const answer = await service.readHome({ deviceId: DEVICE });
    expect(answer.sections.map((section) => section.id)).toEqual([
      "due_now",
      "needs_attention",
      "reply_later",
      "since_visit",
      "saved",
    ]);
    const byId = new Map(answer.sections.map((section) => [section.id, section]));
    expect(byId.get("due_now")!.total).toBe(1);
    expect(byId.get("needs_attention")!.total).toBe(7);
    expect(byId.get("reply_later")!.total).toBe(2);
    expect(byId.get("since_visit")!.total).toBe(0);
    expect(byId.get("saved")!.total).toBe(2);
    expect(answer.generatedAt).toBe(NOW.toISOString());
  });

  it("ranks attention deterministically and resolves it before the page", async () => {
    const section = await readSectionOnce("needs_attention");
    // Tier 0 first: the alert, the protected action, then the old message
    // the owner prioritized — present although it is six years old.
    // Then tier 1 by recency, and the two-message thread as one entry.
    expect(section.items.map((item) => item.message.messageId)).toEqual([
      id("sec"),
      id("highAction"),
      id("priorityOld"),
      id("lowAction"),
      id("reply"),
      id("manualAction"),
      id("threadB"),
    ]);
    // Conversation grouping: one entry covers both thread messages.
    const threadEntry = section.items.at(-1)!;
    expect([...threadEntry.messageIds].sort()).toEqual([id("threadA"), id("threadB")].sort());
    // The entry carries the open work anchored in the conversation.
    expect(threadEntry.work.length).toBe(1);
    // Frozen occurrences let mail actions run from Home.
    expect(section.items[0]!.occurrences[0]!.folderId).toBe(inboxA);
    expect(section.items[0]!.noServerCopy).toBe(false);
  });

  it("matches the stored ranking the pure module computes", async () => {
    // Recompute the expected order in JavaScript, from the same stored
    // answers, and require the SQL ranking to agree entry for entry.
    const priorities = await service.listPriorities();
    const senderChoices = new Set(priorities.map((choice) => `${choice.accountId}:${choice.target.kind === "sender" ? choice.target.sender : ""}`));
    const candidates = [
      candidateOf("sec", { classHint: "security_alert", classSource: "jev" }),
      candidateOf("highAction", { asksAction: true, classSource: "jev", actionConfidence: 0.9 }),
      candidateOf("priorityOld", {
        prioritySender: senderChoices.has(`${accountA}:bank@old.example`),
      }),
      candidateOf("lowAction", { asksAction: true, classSource: "jev", actionConfidence: 0.4 }),
      candidateOf("reply", { asksReply: true, classSource: "rule" }),
      candidateOf("manualAction", { asksAction: true, classSource: "manual" }),
      candidateOf("threadA", { asksReply: true, classSource: "jev", thread: THREAD }),
      candidateOf("threadB", { asksReply: true, classSource: "jev", thread: THREAD }),
    ];
    expect(candidates.every((entry) => attentionTier(entry) !== null)).toBe(true);
    const ordered = [...candidates].sort(compareAttention);
    const expectedLeads: string[] = [];
    const seenThreads = new Set<string>();
    for (const entry of ordered) {
      const key = entry.threadId ?? entry.messageId;
      if (!seenThreads.has(key)) {
        seenThreads.add(key);
        expectedLeads.push(entry.messageId);
      }
    }
    const section = await readSectionOnce("needs_attention");
    expect(section.items.map((item) => item.message.messageId)).toEqual(expectedLeads);
  });

  it("carries the fixed reason vocabulary with its origins", async () => {
    const section = await readSectionOnce("needs_attention");
    const byId = new Map(section.items.map((item) => [item.message.messageId, item]));
    expect(byId.get(id("priorityOld"))!.reasons).toEqual([
      { code: "you_prioritized_sender", origin: "choice" },
    ]);
    expect(byId.get(id("sec"))!.reasons).toEqual([{ code: "security_alert", origin: "suggestion" }]);
    expect(byId.get(id("highAction"))!.reasons).toEqual([
      { code: "may_need_action", origin: "suggestion" },
    ]);
    expect(byId.get(id("manualAction"))!.reasons).toEqual([
      { code: "may_need_action", origin: "choice" },
    ]);
    expect(byId.get(id("threadB"))!.reasons).toEqual([{ code: "may_need_reply", origin: "suggestion" }]);
  });

  it("hides dismissed suggestions and messages outside the inbox", async () => {
    const section = await readSectionOnce("needs_attention");
    const present = section.items.flatMap((item) => item.messageIds);
    expect(present).not.toContain(id("dismissedMsg"));
    expect(present).not.toContain(id("archivedAction"));
    expect(present).not.toContain(id("plain"));
  });

  it("lists due reminders earliest first, with their frozen occurrences", async () => {
    const section = await readSectionOnce("due_now");
    expect(section.items.map((item) => item.message.messageId)).toEqual([id("reminderDue")]);
    expect(section.items[0]!.reasons).toEqual([{ code: "reminder_due", origin: "choice" }]);
    expect(section.items[0]!.work[0]!.dueAt).toBe("2026-09-20T11:00:00.000Z");
    expect(section.items[0]!.occurrences[0]!.folderId).toBe(inboxA);
  });

  it("lists reply-later commitments oldest first", async () => {
    const section = await readSectionOnce("reply_later");
    expect(section.items.map((item) => item.message.messageId)).toEqual([
      id("replyLaterAnchor"),
      id("threadB"),
    ]);
    expect(section.items[0]!.reasons).toEqual([{ code: "reply_planned", origin: "choice" }]);
  });

  it("lists saved stars across accounts and excludes junk", async () => {
    const section = await readSectionOnce("saved");
    expect(section.items.map((item) => item.message.messageId)).toEqual([id("flaggedB"), id("flaggedSaved")]);
    expect(section.items[0]!.reasons).toEqual([{ code: "you_starred", origin: "choice" }]);
    expect(section.items[0]!.message.accountLabel).toBe("Side");
  });

  it("keeps future reminders out of the default sections but listed for review", async () => {
    const answer = await service.readHome({ deviceId: DEVICE });
    for (const section of answer.sections) {
      expect(section.items.flatMap((item) => item.messageIds)).not.toContain(id("reminderFuture"));
    }
    const work = await service.listWork({ kind: "reminder", status: "open" });
    expect(work.map((row) => row.anchorMessageId)).toContain(id("reminderFuture"));
  });

  it("tracks the visit boundary per device, advancing only after a load", async () => {
    // A device's first visit has no boundary: Since your last visit stays
    // empty and the answer names the boundary it used.
    const visitDevice = "device-visit-0001";
    const first = await service.readHome({ deviceId: visitDevice });
    expect(first.visitBoundary).toBeNull();
    expect(first.sections.find((section) => section.id === "since_visit")!.total).toBe(0);

    // One new arrival after the boundary.
    await seed("arrival", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-20T11:00:00Z",
      ingestedAt: "2026-09-20T11:30:00Z",
    });

    const second = await service.readHome({ deviceId: visitDevice });
    const since = second.sections.find((section) => section.id === "since_visit")!;
    expect(since.total).toBe(1);
    expect(since.items[0]!.message.messageId).toBe(id("arrival"));
    expect(since.items[0]!.reasons).toEqual([{ code: "new_arrival", origin: "notice" }]);
    // The answer names the boundary it used, not the one it advanced to.
    expect(second.visitBoundary).toBe("2026-09-19T12:00:00.000Z");

    // The boundary advanced: nothing is new on the third visit.
    const third = await service.readHome({ deviceId: visitDevice });
    expect(third.sections.find((section) => section.id === "since_visit")!.total).toBe(0);

    // Another device keeps its own overview until it visits.
    const otherFirst = await service.readHome({ deviceId: "device-visit-0002" });
    expect(otherFirst.visitBoundary).toBeNull();
    const otherSecond = await service.readHome({ deviceId: "device-visit-0002" });
    expect(otherSecond.sections.find((section) => section.id === "since_visit")!.total).toBe(0);
  });

  it("dismisses a suggestion and restores it on undo", async () => {
    // The suggestion the owner hides: a reply suggestion the rules made.
    const target = id("reply");
    await service.dismiss(readyContext, { accountId: accountA, messageId: target });
    const hidden = await service.readSection({ section: "needs_attention" });
    expect(hidden.items.flatMap((item) => item.messageIds)).not.toContain(target);

    // Undo returns the suggestion with its next answer. A device whose visit
    // boundary already passed the message still sees the restore here,
    // because attention re-reads every stored answer on every load.
    await service.undismiss(readyContext, { accountId: accountA, messageId: target });
    const restored = await service.readSection({ section: "needs_attention" });
    expect(restored.items.flatMap((item) => item.messageIds)).toContain(target);

    // Dismissal also hides the message from the since window: this device's
    // boundary predates both arrivals, so the window is live. The undismissed
    // arrival stays; the dismissed one goes.
    await seed("later", {
      account: accountA,
      folder: inboxA,
      sentAt: "2026-09-20T11:40:00Z",
      ingestedAt: "2026-09-20T11:45:00Z",
    });
    await service.dismiss(readyContext, { accountId: accountA, messageId: id("later") });
    const answer = await service.readHome({ deviceId: DEVICE });
    const since = answer.sections.find((section) => section.id === "since_visit")!;
    expect(since.items.flatMap((item) => item.messageIds)).toContain(id("arrival"));
    expect(since.items.flatMap((item) => item.messageIds)).not.toContain(id("later"));

    // Undo succeeds once; no dismissal stands for a second undo.
    await service.undismiss(readyContext, { accountId: accountA, messageId: id("later") });
    const undone = await rejection(
      service.undismiss(readyContext, { accountId: accountA, messageId: id("later") }),
    );
    expect((undone as HomeError).code).toBe("not_found");
  });

  it("pages a section with a keyset cursor, without skips or repeats", async () => {
    const first = await service.readSection({ section: "needs_attention", limit: 3 });
    expect(first.items.map((item) => item.message.messageId)).toEqual([
      id("sec"),
      id("highAction"),
      id("priorityOld"),
    ]);
    expect(first.total).toBe(7);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await service.readSection({ section: "needs_attention", cursor: first.nextCursor, limit: 3 });
    expect(second.items.map((item) => item.message.messageId)).toEqual([
      id("lowAction"),
      id("reply"),
      id("manualAction"),
    ]);
    expect(second.total).toBe(7);

    const third = await service.readSection({ section: "needs_attention", cursor: second.nextCursor, limit: 3 });
    expect(third.items.map((item) => item.message.messageId)).toEqual([id("threadB")]);
    expect(third.nextCursor).toBeNull();

    // A cursor from another section, or one that is not a cursor, is refused.
    const dueNow = await service.readSection({ section: "due_now" });
    expect(dueNow.nextCursor).toBeNull();
    const mismatch = await rejection(
      service.readSection({ section: "needs_attention", cursor: Buffer.from("nope").toString("base64url") }),
    );
    expect((mismatch as HomeError).code).toBe("invalid_request");
  });

  it("reports classification coverage from the stored records", async () => {
    const answer = await service.readHome({ deviceId: DEVICE });
    expect(answer.classification.state).toBe("active");
    // Considered counts the inbox window; answered counts stored answers.
    const considered = Number(
      (await pool.query(`select count(*)::int as total from messages m
        where exists (select 1 from message_occurrences o join folders f on f.id = o.folder_id
          where o.message_id = m.id and o.expunged_at is null and o.invalidated_at is null and f.role = 'inbox')`))
        .rows[0]!.total,
    );
    const answered = Number(
      (await pool.query(`select count(*)::int as total from messages m
        where (m.class_hint is not null or m.metadata ->> 'classSource' is not null)
          and exists (select 1 from message_occurrences o join folders f on f.id = o.folder_id
            where o.message_id = m.id and o.expunged_at is null and o.invalidated_at is null and f.role = 'inbox')`))
        .rows[0]!.total,
    );
    expect(answer.classification.considered).toBe(considered);
    expect(answer.classification.answered).toBe(answered);
    expect(answer.classification.newestAnswerAt).not.toBeNull();

    circuitState.circuit = "open";
    try {
      expect((await service.readHome({ deviceId: DEVICE })).classification.state).toBe("paused");
    } finally {
      circuitState.circuit = "closed";
    }
    settingsState.classificationEnabled = false;
    try {
      expect((await service.readHome({ deviceId: DEVICE })).classification.state).toBe("disabled");
    } finally {
      settingsState.classificationEnabled = true;
    }
  });

  it("saves work idempotently and records one event per creation", async () => {
    const eventsBefore = await countEvents("home.work.created");
    const duplicate = await service.createWork(readyContext, {
      accountId: accountA,
      anchorMessageId: id("replyLaterAnchor"),
      kind: "reply_later",
    });
    expect(duplicate.kind).toBe("reply_later");
    expect(await countEvents("home.work.created")).toBe(eventsBefore);

    const fresh = await service.createWork(readyContext, {
      accountId: accountA,
      anchorMessageId: id("plain"),
      kind: "reply_later",
    });
    expect(fresh.revision).toBe(1);
    expect(fresh.anchor!.messageId).toBe(id("plain"));
    expect(await countEvents("home.work.created")).toBe(eventsBefore + 1);

    // A reminder and reply later coexist on one message (SPEC F13).
    const reminder = await service.createWork(readyContext, {
      accountId: accountA,
      anchorMessageId: id("plain"),
      kind: "reminder",
      dueAt: "2026-09-21T10:00:00Z",
      timeZone: "America/New_York",
    });
    expect(reminder.kind).toBe("reminder");
    expect(reminder.dueAt).toBe("2026-09-21T10:00:00.000Z");
    expect(reminder.timeZone).toBe("America/New_York");
  });

  it("refuses work that names the wrong anchor, time, or zone", async () => {
    const cases: Parameters<typeof service.createWork>[1][] = [
      { accountId: accountA, anchorMessageId: randomUUID(), kind: "reply_later" },
      { accountId: accountB, anchorMessageId: id("plain"), kind: "reply_later" },
      {
        accountId: accountA,
        anchorMessageId: id("plain"),
        kind: "reminder",
        dueAt: "2026-09-19T00:00:00Z",
        timeZone: "UTC",
      },
      { accountId: accountA, anchorMessageId: id("plain"), kind: "reminder", timeZone: "UTC" },
      {
        accountId: accountA,
        anchorMessageId: id("plain"),
        kind: "reminder",
        dueAt: "2260-01-01T00:00:00Z",
        timeZone: "UTC",
      },
      {
        accountId: accountA,
        anchorMessageId: id("plain"),
        kind: "reminder",
        dueAt: "2026-09-22T00:00:00Z",
        timeZone: "Mars/Olympus",
      },
    ];
    const expected = ["not_found", "not_found", "due_time_invalid", "due_time_invalid", "due_time_invalid", "time_zone_invalid"];
    for (const [index, input] of cases.entries()) {
      const error = await rejection(service.createWork(readyContext, input));
      expect((error as HomeError).code, `case ${index}`).toBe(expected[index]);
    }
  });

  it("reschedules, completes, and reopens by revision", async () => {
    const rescheduled = await service.rescheduleWork(readyContext, reminderFutureId, {
      revision: 1,
      dueAt: "2026-09-22T09:00:00Z",
      timeZone: "Europe/Berlin",
    });
    expect(rescheduled.revision).toBe(2);
    expect(rescheduled.dueAt).toBe("2026-09-22T09:00:00.000Z");

    const stale = await rejection(
      service.rescheduleWork(readyContext, reminderFutureId, {
        revision: 1,
        dueAt: "2026-09-23T09:00:00Z",
        timeZone: "Europe/Berlin",
      }),
    );
    expect((stale as HomeError).code).toBe("work_stale");
    expect((stale as HomeError).currentRevision).toBe(2);
    expect((stale as HomeError).httpStatus).toBe(409);

    const completed = await service.completeWork(readyContext, reminderFutureId, { revision: 2 });
    expect(completed.status).toBe("done");
    expect(completed.completedAt).toBe(NOW.toISOString());
    expect(completed.revision).toBe(3);

    // A reschedule from the pre-completion revision conflicts: reading or
    // archiving never completes work, and old work never overwrites new.
    const conflict = await rejection(
      service.rescheduleWork(readyContext, reminderFutureId, {
        revision: 2,
        dueAt: "2026-09-24T09:00:00Z",
        timeZone: "Europe/Berlin",
      }),
    );
    expect((conflict as HomeError).code).toBe("invalid_request");

    const reopened = await service.reopenWork(readyContext, reminderFutureId, { revision: 3 });
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();

    // Completing, then saving a new open reminder, then reopening the old
    // one refuses: two open records cannot hold one message.
    await service.completeWork(readyContext, reminderFutureId, { revision: 4 });
    await service.createWork(readyContext, {
      accountId: accountA,
      anchorMessageId: id("reminderFuture"),
      kind: "reminder",
      dueAt: "2026-09-25T09:00:00Z",
      timeZone: "UTC",
    });
    const competing = await rejection(
      service.reopenWork(readyContext, reminderFutureId, { revision: 5 }),
    );
    expect((competing as HomeError).code).toBe("invalid_request");
  });

  it("cancels open work and keeps completed history reviewable", async () => {
    const created = await service.createWork(readyContext, {
      accountId: accountA,
      anchorMessageId: id("lowAction"),
      kind: "reply_later",
    });
    await service.cancelWork(readyContext, created.id, { revision: 1 });
    const remaining = await service.listWork({ kind: "reply_later" });
    expect(remaining.map((row) => row.id)).not.toContain(created.id);

    const cancelled = await rejection(service.cancelWork(readyContext, created.id, { revision: 1 }));
    expect((cancelled as HomeError).code).toBe("not_found");
  });

  it("reports work whose anchor message disappeared", async () => {
    // The anchor carries no foreign key on purpose: the record survives and
    // says the message is unavailable instead of blocking anything (SPEC F13).
    await pool.query(`delete from message_occurrences where message_id = $1`, [id("replyLaterAnchor")]);
    await pool.query(`delete from messages where id = $1`, [id("replyLaterAnchor")]);
    const work = await service.listWork({ kind: "reply_later", status: "open" });
    const orphan = work.find((row) => row.anchorMessageId === id("replyLaterAnchor"));
    expect(orphan).toBeDefined();
    expect(orphan!.anchorUnavailable).toBe(true);
    expect(orphan!.anchor).toBeNull();

    const section = await service.readSection({ section: "reply_later" });
    const entry = section.items.find((item) => item.message.messageId === id("replyLaterAnchor"));
    expect(entry).toBeDefined();
    expect(entry!.work[0]!.anchorUnavailable).toBe(true);
    expect(entry!.noServerCopy).toBe(true);
  });

  it("records and removes priority choices idempotently", async () => {
    const created = await service.setPriority(readyContext, {
      accountId: accountA,
      target: { kind: "thread", threadId: THREAD },
      prioritized: true,
    });
    expect(created!.target).toEqual({ kind: "thread", threadId: THREAD });
    const eventsBefore = await countEvents("home.priority.set");
    const again = await service.setPriority(readyContext, {
      accountId: accountA,
      target: { kind: "thread", threadId: THREAD },
      prioritized: true,
    });
    expect(again!.id).toBe(created!.id);
    expect(await countEvents("home.priority.set")).toBe(eventsBefore);

    const removed = await service.setPriority(readyContext, {
      accountId: accountA,
      target: { kind: "thread", threadId: THREAD },
      prioritized: false,
    });
    expect(removed).toBeNull();
    const listed = await service.listPriorities();
    expect(listed.map((choice) => choice.id)).not.toContain(created!.id);

    const bad = await rejection(
      service.setPriority(readyContext, {
        accountId: accountA,
        target: { kind: "sender", sender: "not-an-address" },
        prioritized: true,
      }),
    );
    expect((bad as HomeError).code).toBe("invalid_request");
  });

  it("gates every mutation on the recovery generation, before duplicates", async () => {
    // Even a duplicate create — which would resolve to the standing record —
    // never reaches that lookup with an old generation (SPEC F13).
    const blocked = await rejection(
      service.createWork(
        { requestGeneration: OTHER_GENERATION },
        { accountId: accountA, anchorMessageId: id("replyLaterAnchor"), kind: "reply_later" },
      ),
    );
    expect(blocked).toBeInstanceOf(RecoveryBlockedError);
    expect((blocked as RecoveryBlockedError).code).toBe("recovery_required");

    const missing = await rejection(
      service.createWork(
        { requestGeneration: undefined },
        { accountId: accountA, anchorMessageId: id("replyLaterAnchor"), kind: "reply_later" },
      ),
    );
    expect((missing as RecoveryBlockedError).code).toBe("invalid_recovery_generation");

    for (const call of [
      service.dismiss({ requestGeneration: OTHER_GENERATION }, { accountId: accountA, messageId: id("plain") }),
      service.setPriority({ requestGeneration: OTHER_GENERATION }, {
        accountId: accountA,
        target: { kind: "sender", sender: "who@example.com" },
        prioritized: true,
      }),
    ]) {
      const error = await rejection(call);
      expect((error as RecoveryBlockedError).code).toBe("recovery_required");
    }
  });

  it("records audit events without message bodies or credentials", async () => {
    const work = (
      await db
        .select()
        .from(homeWork)
        .where(and(eq(homeWork.anchorMessageId, id("plain")), eq(homeWork.kind, "reminder")))
        .limit(1)
    )[0]!;
    await service.completeWork(readyContext, work.id, { revision: 1 });
    const event = (
      await db
        .select()
        .from(events)
        .where(and(eq(events.type, "home.work.completed"), eq(events.entityId, work.id)))
    )[0]!;
    expect(event.actor).toBe("user");
    expect(event.entityType).toBe("home_work");
    expect(Object.keys(event.payload).sort()).toEqual(["kind"]);
  });

  it("validates the read inputs at the boundary", async () => {
    const shortDevice = await rejection(service.readHome({ deviceId: "short" }));
    expect((shortDevice as HomeError).code).toBe("invalid_request");
    const badLimit = await rejection(service.readHome({ deviceId: DEVICE, limit: 0 }));
    expect((badLimit as HomeError).code).toBe("invalid_request");
    const badSection = await rejection(service.readSection({ section: "favorites" as never }));
    expect((badSection as HomeError).code).toBe("invalid_request");
    const sinceWithoutDevice = await rejection(service.readSection({ section: "since_visit" }));
    expect((sinceWithoutDevice as HomeError).code).toBe("invalid_request");
  });

  async function countEvents(type: string): Promise<number> {
    const rows = await db.select({ id: events.id }).from(events).where(eq(events.type, type));
    return rows.length;
  }

  /** Rebuild one ranked candidate exactly as the service maps stored answers. */
  function candidateOf(
    key: string,
    stored: {
      classHint?: string;
      classSource?: string;
      asksAction?: boolean;
      asksReply?: boolean;
      timeSensitive?: boolean;
      actionConfidence?: number;
      prioritySender?: boolean;
      thread?: string;
    },
  ) {
    return {
      messageId: id(key),
      accountId: accountA,
      threadId: stored.thread ?? null,
      sentAt: new Date(sentAtOf(key)),
      senderAddress: null,
      classHint: (stored.classHint ?? null) as MessageClass | null,
      classSource: (stored.classSource ?? null) as SuggestionSource | null,
      asksAction: stored.asksAction ?? null,
      asksReply: stored.asksReply ?? null,
      timeSensitive: stored.timeSensitive ?? null,
      actionConfidence: stored.actionConfidence ?? null,
      prioritySender: stored.prioritySender ?? false,
      priorityThread: false,
    };
  }

  function sentAtOf(key: string): string {
    const table: Record<string, string> = {
      sec: "2026-09-18T10:00:00Z",
      highAction: "2026-09-15T09:00:00Z",
      priorityOld: "2020-01-01T00:00:00Z",
      lowAction: "2026-09-19T09:00:00Z",
      reply: "2026-09-17T09:00:00Z",
      manualAction: "2026-09-16T09:00:00Z",
      threadA: "2026-09-02T09:00:00Z",
      threadB: "2026-09-03T09:00:00Z",
    };
    return table[key]!;
  }
});
