import { and, eq, sql } from "drizzle-orm";
import type {
  AppSettings,
  HomeClassificationCoverage,
  HomeItemView,
  HomeMessageSummary,
  HomePriorityTargetWire,
  HomePriorityView,
  HomeReasonCode,
  HomeReasonOrigin,
  HomeReasonView,
  HomeSectionIdWire,
  HomeWorkKindWire,
  HomeWorkListResponse,
  HomeWorkRecordView,
  HomeWorkSummary,
  MessageAddress,
  OccurrenceRefWire,
} from "@mail-hub/contracts";
import {
  accounts,
  events,
  homeDismissals,
  homePriorities,
  homeVisits,
  homeWork,
  messages,
  type MailHubDatabase,
} from "@mail-hub/database";
import type { MutationGate } from "@mail-hub/recovery";
import { HomeError } from "./errors.ts";
import {
  ACTION_BREAKOUT_CONFIDENCE,
  attentionReasons,
  type AttentionCandidate,
} from "./ranking.ts";

/**
 * The Home application service (SPEC F13).
 *
 * Reads assemble the five sections from stored choices, stored work, and
 * stored classification answers — never from a model call and never from a
 * mailbox mutation. Mutations are the explicit owner actions: priority
 * choices, saved work, and dismissals. Every mutation passes the
 * recovery-generation gate before any duplicate resolution, validates its
 * input, rejects conflicting edits by revision, and records one audit event
 * without message bodies or credentials.
 */

/** The circuit verdict shape Home reads; `ClassificationService` satisfies it. */
export interface CircuitReader {
  readCircuit(): Promise<{ circuit: "closed" | "open" | "not_configured" | "unknown"; description: string }>;
}

/** The settings shape Home reads; `SettingsService` satisfies it. */
export interface SettingsReader {
  readSettings(): Promise<AppSettings>;
}

export interface HomeServiceOptions {
  settings: SettingsReader;
  /** Classification circuit state, read from the same durable records. */
  circuit: CircuitReader;
  /** Injectable clock, so tests can move due times. */
  now?: () => Date;
}

/** Context for one durable mutation: the generation the client captured. */
export interface HomeMutationContext {
  requestGeneration?: string | null;
}

/** How many entries one section page returns by default (SPEC F13). */
export const DEFAULT_SECTION_LIMIT = 8;

/** The most entries one section page may return. */
export const MAX_SECTION_LIMIT = 50;

/** How far a reminder may be scheduled into the future. */
export const MAX_REMINDER_AHEAD_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** The coverage window: the newest inbox messages coverage examines. */
const COVERAGE_WINDOW = 200;

/** How many work records the review lists return. */
const WORK_LIST_LIMIT = 200;

/** The longest device identifier and sender address accepted. */
const MAX_DEVICE_ID_CHARS = 100;
const MAX_SENDER_CHARS = 254;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One full Home answer. */
export interface HomeReadResult {
  generatedAt: string;
  sections: HomeSectionResult[];
  classification: HomeClassificationCoverage;
  /** The visit boundary this answer used; `null` on the device's first visit. */
  visitBoundary: string | null;
}

/** One section with its page and its accurate total. */
export interface HomeSectionResult {
  id: HomeSectionIdWire;
  total: number;
  items: HomeItemView[];
  nextCursor: string | null;
}

/** A conversation cursor preserves the database order and the visit boundary. */
export interface HomeSectionCursor {
  section: HomeSectionIdWire;
  tier: number;
  /** Decimal epoch seconds, signed for ascending or descending time order. */
  sortValue: string;
  id: string;
  boundary: string | null;
}

const SECTION_ORDER: HomeSectionIdWire[] = ["due_now", "needs_attention", "reply_later", "since_visit", "saved"];

/** What one Home read asks for. */
export interface HomeReadInput {
  /** The per-device visit identifier the client generated and kept. */
  deviceId: string;
  /** Entries per section; defaults to 8, capped at 50. */
  limit?: number;
}

/** What one section page asks for. */
export interface HomeSectionInput {
  section: HomeSectionIdWire;
  /** The cursor the previous page returned, for the next page. */
  cursor?: string | null;
  limit?: number;
  /** The device whose visit boundary a first Since page uses. */
  deviceId?: string;
  /** Freeze the previous visit across section refreshes; null means the first visit. */
  visitBoundary?: string | null;
}

export class HomeService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly gate: MutationGate,
    private readonly options: HomeServiceOptions,
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Assemble the whole Home answer. The read performs no model request and
   * no mailbox mutation (SPEC F13). The visit boundary advances only after
   * every section query succeeded, so a failed or offline read never clears
   * another device's overview.
   */
  async readHome(input: HomeReadInput): Promise<HomeReadResult> {
    const deviceId = requireDeviceId(input.deviceId);
    const limit = pageLimit(input.limit);
    const boundary = await this.readVisitBoundary(deviceId);
    const generatedAt = this.now();

    const sections: HomeSectionResult[] = [];
    for (const section of SECTION_ORDER) {
      sections.push(await this.readRankedSection(section, limit, null, boundary));
    }
    const classification = await this.readCoverage();

    await this.advanceVisitBoundary(deviceId);
    return {
      generatedAt: generatedAt.toISOString(),
      sections,
      classification,
      visitBoundary: boundary?.toISOString() ?? null,
    };
  }

  /** Read one section page, continuing from a cursor when one is given. */
  async readSection(input: HomeSectionInput): Promise<HomeSectionResult> {
    const limit = pageLimit(input.limit);
    const cursor =
      input.cursor === undefined || input.cursor === null ? null : decodeCursor(input.cursor);
    if (cursor !== null && cursor.section !== input.section) {
      throw new HomeError("invalid_request", "The cursor names a different section.");
    }
    if (!SECTION_ORDER.includes(input.section)) {
      throw new HomeError("invalid_request", "Unknown section.");
    }
    const boundary = cursor !== null ? cursor.boundary
      : input.visitBoundary !== undefined ? input.visitBoundary
      : input.deviceId !== undefined || input.section === "since_visit"
        ? (await this.readVisitBoundary(requireDeviceId(input.deviceId)))?.toISOString() ?? null
        : null;
    return this.readRankedSection(input.section, limit, cursor,
      boundary === null ? null : parseInstant(boundary, "visit boundary"));
  }

  /** Rank conversations before paging, then attach their messages and work. */
  private async readRankedSection(
    section: HomeSectionIdWire,
    limit: number,
    cursor: HomeSectionCursor | null,
    boundary: Date | null,
  ): Promise<HomeSectionResult> {
    const sectionIndex = SECTION_ORDER.indexOf(section);
    const now = this.now();
    const after = cursor === null ? sql`` : sql`and (
      tier > ${cursor.tier} or (tier = ${cursor.tier} and (
        sort_value > ${cursor.sortValue}::numeric or
        (sort_value = ${cursor.sortValue}::numeric and sort_id > ${cursor.id}::uuid)
      )))`;
    const result = await this.db.execute(sql`
      with signals as (
        select m.id, m.account_id, m.thread_id, m.subject, m.sender, m.sent_at, m.ingested_at,
          m.snippet, m.has_attachments, m.class_hint, m.asks_action, m.asks_reply, m.time_sensitive,
          a.label as account_label, a.color as account_color,
          ${inboxOccurrence} as in_inbox, ${starredOccurrence} as starred,
          ${notDismissed} as not_dismissed,
          exists (select 1 from home_priorities p where p.account_id = m.account_id
            and p.target_kind = 'sender' and p.sender = lower(m.sender ->> 'address')) as priority_sender,
          exists (select 1 from home_priorities p where p.account_id = m.account_id
            and p.target_kind = 'thread' and p.thread_id = m.thread_id) as priority_thread,
          m.metadata ->> 'classSource' as class_source,
          conf.action_confidence
        from messages m join accounts a on a.id = m.account_id
        left join lateral (
          select (d.confidence ->> 'asks_action')::float8 as action_confidence
          from decisions d where d.message_id = m.id and m.metadata ->> 'classSource' = 'jev'
          order by d.created_at desc, d.id desc limit 1
        ) conf on true
      ), work as (
        select w.*, case when m.id is null then coalesce(w.thread_id, w.anchor_message_id)
          else coalesce(m.thread_id, m.id) end as entry_key,
          m.id is null as anchor_unavailable,
          a.label as account_label, a.color as account_color
        from home_work w join accounts a on a.id = w.account_id
        left join messages m on m.id = w.anchor_message_id where w.status = 'open'
      ), candidates as (
        select entry_key, anchor_message_id as message_id, id as sort_id,
          0 as section, 0 as tier, extract(epoch from due_at) as sort_value
        from work where kind = 'reminder' and due_at <= ${now}
        union all
        select coalesce(thread_id, id), id, id, 1,
          case when priority_sender or priority_thread or class_hint = 'security_alert'
            or (asks_action is true and action_confidence >= ${ACTION_BREAKOUT_CONFIDENCE})
            then 0 else 1 end,
          -extract(epoch from coalesce(sent_at, ingested_at))
        from signals where in_inbox and not_dismissed and
          (priority_sender or priority_thread or class_hint = 'security_alert'
            or asks_action is true or asks_reply is true or time_sensitive is true)
        union all
        select entry_key, anchor_message_id, id, 2, 0, extract(epoch from created_at)
        from work where kind = 'reply_later'
        union all
        select coalesce(thread_id, id), id, id, 3, 0, -extract(epoch from ingested_at)
        from signals where in_inbox and not_dismissed and ingested_at > ${boundary}::timestamptz
        union all
        select coalesce(thread_id, id), id, id, 4, 0,
          -extract(epoch from coalesce(sent_at, ingested_at)) from signals where starred
      ), leaders as (
        select distinct on (entry_key) * from candidates
        order by entry_key, section, tier, sort_value, sort_id
      ), page as (
        select * from leaders where section = ${sectionIndex} ${after}
        order by tier, sort_value, sort_id limit ${limit + 1}
      )
      select (select count(*)::int from leaders where section = ${sectionIndex}) as total,
        coalesce((select jsonb_agg(row_data order by tier, sort_value, sort_id) from (
          select p.tier, p.sort_value, p.sort_id, jsonb_build_object(
            'entry_key', p.entry_key, 'message_id', p.message_id, 'sort_id', p.sort_id,
            'tier', p.tier, 'sort_value', p.sort_value::text,
            'members', coalesce((select jsonb_agg(s order by s.id) from signals s
              where coalesce(s.thread_id, s.id) = p.entry_key), '[]'::jsonb),
            'work', coalesce((select jsonb_agg(w order by w.due_at nulls last, w.created_at, w.id)
              from work w where w.entry_key = p.entry_key), '[]'::jsonb),
            'reasons', (select jsonb_agg(c order by c.section, c.tier, c.sort_value, c.sort_id) from candidates c where c.entry_key = p.entry_key)
          ) as row_data from page p
        ) details), '[]'::jsonb) as page
    `);
    const rows = result.rows[0]?.page as Record<string, unknown>[] ?? [];
    const items = rows.slice(0, limit).map((row) => this.rankedEntry(row));
    const flags = await this.loadOccurrences(items.map((item) => item.message.messageId));
    for (const item of items) {
      const active = flags.get(item.message.messageId);
      item.occurrences = active?.refs ?? [];
      item.noServerCopy = item.occurrences.length === 0;
      item.message.unread = active?.unread ?? false;
      item.message.flagged = active?.flagged ?? false;
    }
    const last = rows[limit - 1];
    return {
      id: section,
      total: Number(result.rows[0]?.total ?? 0),
      items,
      nextCursor: rows.length > limit && last !== undefined ? encodeCursor({
        section, tier: Number(last.tier), sortValue: String(last.sort_value),
        id: String(last.sort_id), boundary: boundary?.toISOString() ?? null,
      }) : null,
    };
  }

  private rankedEntry(row: Record<string, unknown>): HomeItemView {
    const members = row.members as Record<string, unknown>[];
    const work = row.work as Record<string, unknown>[];
    const candidates = row.reasons as Record<string, unknown>[];
    const lead = members.find((member) => member.id === row.message_id);
    const reasons: HomeReasonView[] = [];
    for (const candidate of candidates) {
      const member = members.find((item) => item.id === candidate.message_id);
      const next = candidate.section === 1 && member !== undefined
        ? attentionReasons(toAttentionCandidate(member))
        : [reason(
            candidate.section === 0 ? "reminder_due" : candidate.section === 2 ? "reply_planned"
              : candidate.section === 3 ? "new_arrival" : "you_starred",
            candidate.section === 3 ? "notice" : "choice",
          )];
      for (const value of next) {
        if (!reasons.some((existing) => existing.code === value.code && existing.origin === value.origin)) {
          reasons.push(value);
        }
      }
    }
    const source = lead ?? work[0]!;
    const message = workMessageSummary({
      ...source, anchor_message_id: row.message_id, current_thread_id: lead?.thread_id,
    }, lead === undefined);
    return {
      entryKey: String(row.entry_key), message,
      messageIds: [...new Set([String(row.message_id), ...members.map((member) => String(member.id)),
        ...work.map((record) => String(record.anchor_message_id))])],
      reasons,
      work: work.map((record) => ({
        id: String(record.id), kind: record.kind as HomeWorkKindWire, status: "open",
        dueAt: isoOf(record.due_at), timeZone: record.time_zone as string | null,
        revision: Number(record.revision), anchorUnavailable: record.anchor_unavailable === true,
      })),
      occurrences: [], noServerCopy: false,
    };
  }

  // ---------------------------------------------------------------------
  // Coverage and visit tracking
  // ---------------------------------------------------------------------

  /** Classification coverage behind the suggestions (SPEC F13). */
  private async readCoverage(): Promise<HomeClassificationCoverage> {
    const [settings, circuit] = await Promise.all([
      this.options.settings.readSettings(),
      this.options.circuit.readCircuit(),
    ]);
    const state: HomeClassificationCoverage["state"] = !settings.classificationEnabled
      ? "disabled"
      : circuit.circuit === "closed"
        ? "active"
        : circuit.circuit === "open"
          ? "paused"
          : "not_configured";
    const windowRows = await this.db.execute(sql`
      select count(*)::int as considered,
             count(*) filter (
               where m.class_hint is not null or m.metadata ->> 'classSource' is not null
             )::int as answered
      from (
        select m.class_hint, m.metadata
        from messages m
        where ${inboxOccurrence}
        order by coalesce(m.sent_at, m.ingested_at) desc
        limit ${COVERAGE_WINDOW}
      ) m
    `);
    const newestRows = await this.db.execute(sql`
      select max(created_at) as newest from decisions
    `);
    return {
      state,
      description: circuit.description,
      considered: Number(windowRows.rows[0]?.considered ?? 0),
      answered: Number(windowRows.rows[0]?.answered ?? 0),
      newestAnswerAt: isoOf(newestRows.rows[0]?.newest),
    };
  }

  /** The device's stored visit boundary, or `null` before its first visit. */
  private async readVisitBoundary(deviceId: string): Promise<Date | null> {
    const rows = await this.db.select().from(homeVisits).where(eq(homeVisits.deviceId, deviceId)).limit(1);
    return rows[0]?.boundary ?? null;
  }

  /**
   * Record the next boundary after a successful load: the newest ingestion
   * instant the server knows. Messages that arrive during the session keep
   * a later instant, so they surface on the next visit. The boundary never
   * moves backwards, even if the newest row later disappeared.
   */
  private async advanceVisitBoundary(deviceId: string): Promise<void> {
    const rows = await this.db.execute(sql`select max(ingested_at) as boundary from messages`);
    const next = dateOf(rows.rows[0]?.boundary);
    if (next === null) {
      return;
    }
    await this.db
      .insert(homeVisits)
      .values({ deviceId, boundary: next })
      .onConflictDoUpdate({
        target: homeVisits.deviceId,
        set: { boundary: sql`greatest(${homeVisits.boundary}, ${next})`, updatedAt: this.now() },
      });
  }

  // ---------------------------------------------------------------------
  // Work mutations
  // ---------------------------------------------------------------------

  /** Save one work record; an identical open record answers idempotently. */
  async createWork(
    context: HomeMutationContext,
    input: {
      accountId: string;
      anchorMessageId: string;
      kind: HomeWorkKindWire;
      dueAt?: string | null;
      timeZone?: string | null;
    },
  ): Promise<HomeWorkRecordView> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("account id", input.accountId);
    requireUuid("anchor message id", input.anchorMessageId);
    if (input.kind !== "reply_later" && input.kind !== "reminder") {
      throw new HomeError("invalid_request", "Kind must be reply_later or reminder.");
    }
    const now = this.now();
    const dueAt = input.kind === "reminder" ? validateDueAt(input.dueAt ?? null, now) : null;
    const timeZone = input.kind === "reminder" ? validateTimeZone(input.timeZone ?? null) : null;

    await requireAccount(this.db, input.accountId);
    const anchor = await this.db
      .select({ id: messages.id, threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.id, input.anchorMessageId), eq(messages.accountId, input.accountId)))
      .limit(1);
    const anchorRow = anchor[0];
    if (anchorRow === undefined) {
      throw new HomeError("not_found", "The anchor message does not exist in this account.", 404);
    }

    const inserted = await this.db
      .insert(homeWork)
      .values({
        accountId: input.accountId,
        anchorMessageId: input.anchorMessageId,
        threadId: anchorRow.threadId,
        kind: input.kind,
        status: "open",
        dueAt,
        timeZone,
      })
      .onConflictDoNothing({
        target: [homeWork.accountId, homeWork.kind, homeWork.anchorMessageId],
        // The unique index covers open records only, so the conflict target
        // repeats that predicate for PostgreSQL to infer it. Drizzle's
        // do-nothing builder emits this field, and ignores `targetWhere`.
        where: sql`${homeWork.status} = 'open'`,
      })
      .returning();
    let record = inserted[0];
    if (record === undefined) {
      // The recovery gate ran before this duplicate resolution (SPEC F13):
      // the open record this anchor already holds answers unchanged.
      const rows = await this.db
        .select()
        .from(homeWork)
        .where(
          and(
            eq(homeWork.accountId, input.accountId),
            eq(homeWork.kind, input.kind),
            eq(homeWork.anchorMessageId, input.anchorMessageId),
            eq(homeWork.status, "open"),
          ),
        )
        .limit(1);
      record = rows[0];
      if (record === undefined) {
        throw new HomeError("not_found", "The saved work record disappeared.", 404);
      }
    } else {
      await this.recordEvent("home.work.created", "home_work", record.id, {
        accountId: input.accountId,
        kind: input.kind,
        anchorMessageId: input.anchorMessageId,
        dueAt: dueAt?.toISOString() ?? null,
      });
    }
    return this.toWorkRecord(record);
  }

  /** Reschedule one open reminder to a new instant and zone. */
  async rescheduleWork(
    context: HomeMutationContext,
    id: string,
    input: { revision: number; dueAt: string; timeZone: string },
  ): Promise<HomeWorkRecordView> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("work id", id);
    requireRevision(input.revision);
    const dueAt = validateDueAt(input.dueAt, this.now());
    const timeZone = validateTimeZone(input.timeZone);
    const record = await this.loadWorkForMutation(id);
    if (record.kind !== "reminder" || record.status !== "open") {
      throw new HomeError("invalid_request", "Only an open reminder reschedules.");
    }
    requireCurrentRevision(record, input.revision);
    const updated = await this.db
      .update(homeWork)
      .set({ dueAt, timeZone, revision: record.revision + 1, updatedAt: this.now() })
      .where(and(eq(homeWork.id, id), eq(homeWork.revision, record.revision)))
      .returning();
    if (updated[0] === undefined) {
      throw staleError(record.revision + 1);
    }
    await this.recordEvent("home.work.rescheduled", "home_work", id, {
      dueAt: dueAt.toISOString(),
      timeZone,
    });
    return this.toWorkRecord(updated[0]);
  }

  /** Complete one saved work item. Provider mail never moves (SPEC F13). */
  async completeWork(
    context: HomeMutationContext,
    id: string,
    input: { revision: number },
  ): Promise<HomeWorkRecordView> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("work id", id);
    requireRevision(input.revision);
    const record = await this.loadWorkForMutation(id);
    if (record.status !== "open") {
      throw new HomeError("invalid_request", "Only open work completes.");
    }
    requireCurrentRevision(record, input.revision);
    const now = this.now();
    const updated = await this.db
      .update(homeWork)
      .set({ status: "done", completedAt: now, revision: record.revision + 1, updatedAt: now })
      .where(and(eq(homeWork.id, id), eq(homeWork.revision, record.revision)))
      .returning();
    if (updated[0] === undefined) {
      throw staleError(record.revision + 1);
    }
    await this.recordEvent("home.work.completed", "home_work", id, { kind: record.kind });
    return this.toWorkRecord(updated[0]);
  }

  /** Reopen one completed item; a competing open record refuses. */
  async reopenWork(
    context: HomeMutationContext,
    id: string,
    input: { revision: number },
  ): Promise<HomeWorkRecordView> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("work id", id);
    requireRevision(input.revision);
    const record = await this.loadWorkForMutation(id);
    if (record.status !== "done") {
      throw new HomeError("invalid_request", "Only completed work reopens.");
    }
    requireCurrentRevision(record, input.revision);
    try {
      const updated = await this.db
        .update(homeWork)
        .set({ status: "open", completedAt: null, revision: record.revision + 1, updatedAt: this.now() })
        .where(and(eq(homeWork.id, id), eq(homeWork.revision, record.revision)))
        .returning();
      if (updated[0] === undefined) {
        throw staleError(record.revision + 1);
      }
      await this.recordEvent("home.work.reopened", "home_work", id, { kind: record.kind });
      return this.toWorkRecord(updated[0]);
    } catch (cause) {
      if (isUniqueViolation(cause)) {
        throw new HomeError(
          "invalid_request",
          "Another open record already holds this message. Review it before reopening.",
        );
      }
      throw cause;
    }
  }

  /** Cancel one open work record. Completed history stays reviewable. */
  async cancelWork(
    context: HomeMutationContext,
    id: string,
    input: { revision: number },
  ): Promise<void> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("work id", id);
    requireRevision(input.revision);
    const record = await this.loadWorkForMutation(id);
    if (record.status !== "open") {
      throw new HomeError("invalid_request", "Only open work cancels; completed history stays.");
    }
    requireCurrentRevision(record, input.revision);
    const removed = await this.db
      .delete(homeWork)
      .where(and(eq(homeWork.id, id), eq(homeWork.revision, record.revision)))
      .returning({ id: homeWork.id });
    if (removed.length === 0) {
      throw staleError(record.revision + 1);
    }
    await this.recordEvent("home.work.cancelled", "home_work", id, { kind: record.kind });
  }

  /** The first page, retained for application callers that need a short list. */
  async listWork(input: { status?: "open" | "done"; kind?: HomeWorkKindWire } = {}): Promise<HomeWorkRecordView[]> {
    return (await this.listWorkPage(input)).work;
  }

  /** Page all saved work, including future reminders and completed records. */
  async listWorkPage(input: {
    status?: "open" | "done"; kind?: HomeWorkKindWire; cursor?: string; limit?: number;
  } = {}): Promise<HomeWorkListResponse> {
    const conditions = [];
    const limit = input.limit === undefined ? WORK_LIST_LIMIT : pageLimit(input.limit);
    if (input.status !== undefined) conditions.push(eq(homeWork.status, input.status));
    if (input.kind !== undefined) conditions.push(eq(homeWork.kind, input.kind));
    const order = sql`(case when status = 'open' then 0 else 1 end,
      case when kind = 'reminder' then 0 else 1 end,
      coalesce(due_at, 'infinity'::timestamptz), date_trunc('milliseconds', created_at), id)`;
    if (input.cursor !== undefined) {
      let cursor: { status: number; kind: number; dueAt: string | null; createdAt: string; id: string };
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (cursor === null || ![0, 1].includes(cursor.status) || ![0, 1].includes(cursor.kind)) throw new Error();
        requireUuid("work cursor id", cursor.id);
        parseInstant(cursor.createdAt, "work cursor creation time");
        if (cursor.dueAt !== null) parseInstant(cursor.dueAt, "work cursor due time");
      } catch {
        throw new HomeError("invalid_request", "The work cursor is not valid.");
      }
      conditions.push(sql`${order} > (${cursor.status}, ${cursor.kind},
        coalesce(${cursor.dueAt}::timestamptz, 'infinity'::timestamptz),
        ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`);
    }
    const rows = await this.db.select().from(homeWork)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(order).limit(limit + 1);
    const work = await Promise.all(rows.slice(0, limit).map((row) => this.toWorkRecord(row)));
    const last = work[work.length - 1];
    return { work, nextCursor: rows.length > limit && last !== undefined
      ? Buffer.from(JSON.stringify({ status: last.status === "open" ? 0 : 1,
          kind: last.kind === "reminder" ? 0 : 1, dueAt: last.dueAt,
          createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
  }

  // ---------------------------------------------------------------------
  // Priority choices
  // ---------------------------------------------------------------------

  /** Record or remove one priority choice, idempotently. */
  async setPriority(
    context: HomeMutationContext,
    input: { accountId: string; target: HomePriorityTargetWire; prioritized: boolean },
  ): Promise<HomePriorityView | null> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("account id", input.accountId);
    const target = normalizeTarget(input.target);
    await requireAccount(this.db, input.accountId);
    if (input.prioritized) {
      const inserted = await this.db
        .insert(homePriorities)
        .values({
          accountId: input.accountId,
          targetKind: target.kind,
          sender: target.kind === "sender" ? target.sender : null,
          threadId: target.kind === "thread" ? target.threadId : null,
        })
        .onConflictDoNothing()
        .returning();
      // The gate ran before this duplicate resolution: an identical choice
      // answers unchanged, without a second event.
      if (inserted[0] === undefined) {
        const existing = await this.findPriority(input.accountId, target);
        if (existing === null) {
          throw new HomeError("not_found", "The priority choice disappeared.", 404);
        }
        return this.toPriority(existing);
      }
      const record = inserted[0];
      await this.recordEvent("home.priority.set", "home_priority", record.id, {
        accountId: input.accountId,
        targetKind: target.kind,
        sender: target.kind === "sender" ? target.sender : null,
        threadId: target.kind === "thread" ? target.threadId : null,
      });
      return this.toPriority(record);
    }
    const existing = await this.findPriority(input.accountId, target);
    if (existing !== null) {
      await this.db.delete(homePriorities).where(eq(homePriorities.id, existing.id));
      await this.recordEvent("home.priority.removed", "home_priority", existing.id, {
        accountId: input.accountId,
        targetKind: target.kind,
      });
    }
    return null;
  }

  /** Every priority choice, for review. */
  async listPriorities(): Promise<HomePriorityView[]> {
    const rows = await this.db
      .select()
      .from(homePriorities)
      .orderBy(homePriorities.createdAt, homePriorities.id);
    return rows.map((row) => this.toPriority(row));
  }

  private async findPriority(
    accountId: string,
    target: NormalizedTarget,
  ): Promise<typeof homePriorities.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(homePriorities)
      .where(
        and(
          eq(homePriorities.accountId, accountId),
          eq(homePriorities.targetKind, target.kind),
          target.kind === "sender"
            ? eq(homePriorities.sender, target.sender)
            : eq(homePriorities.threadId, target.threadId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------------
  // Dismissals
  // ---------------------------------------------------------------------

  /** Dismiss one incoming message's suggestion from Home (SPEC F13). */
  async dismiss(
    context: HomeMutationContext,
    input: { accountId: string; messageId: string },
  ): Promise<{ accountId: string; messageId: string }> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("account id", input.accountId);
    requireUuid("message id", input.messageId);
    const rows = await this.db
      .select({ accountId: messages.accountId })
      .from(messages)
      .where(eq(messages.id, input.messageId))
      .limit(1);
    if (rows[0] === undefined || rows[0].accountId !== input.accountId) {
      throw new HomeError("not_found", "The message does not exist in this account.", 404);
    }
    await this.db
      .insert(homeDismissals)
      .values({ accountId: input.accountId, messageId: input.messageId })
      .onConflictDoNothing();
    await this.recordEvent("home.suggestion.dismissed", "message", input.messageId, {
      accountId: input.accountId,
    });
    return input;
  }

  /** Undo one dismissal; the suggestion returns with its next answer. */
  async undismiss(
    context: HomeMutationContext,
    input: { accountId: string; messageId: string },
  ): Promise<void> {
    await this.gate.gateMutation(context.requestGeneration);
    requireUuid("account id", input.accountId);
    requireUuid("message id", input.messageId);
    const removed = await this.db
      .delete(homeDismissals)
      .where(
        and(eq(homeDismissals.accountId, input.accountId), eq(homeDismissals.messageId, input.messageId)),
      )
      .returning({ id: homeDismissals.id });
    if (removed.length === 0) {
      throw new HomeError("not_found", "No dismissal stands for this message.", 404);
    }
    await this.recordEvent("home.suggestion.restored", "message", input.messageId, {
      accountId: input.accountId,
    });
  }

  // ---------------------------------------------------------------------
  // Entry assembly
  // ---------------------------------------------------------------------

  /** Active occurrence flags and frozen action refs for messages. */
  private async loadOccurrences(
    messageIds: string[],
  ): Promise<Map<string, { unread: boolean; flagged: boolean; refs: OccurrenceRefWire[] }>> {
    if (messageIds.length === 0) {
      return new Map();
    }
    const rows = await this.db.execute(sql`
      select o.message_id, o.id, o.folder_id, o.revision, o.modseq, o.unread, o.flagged
      from message_occurrences o
      where o.expunged_at is null and o.invalidated_at is null
        and o.message_id in (${uuidList(messageIds)})
    `);
    const result = new Map<string, { unread: boolean; flagged: boolean; refs: OccurrenceRefWire[] }>();
    for (const row of rows.rows) {
      const id = String(row.message_id);
      const entry = result.get(id) ?? { unread: false, flagged: false, refs: [] };
      entry.unread = entry.unread || row.unread === true;
      entry.flagged = entry.flagged || row.flagged === true;
      entry.refs.push({
        occurrenceId: String(row.id),
        folderId: String(row.folder_id),
        revision: Number(row.revision ?? 1),
        modseq: row.modseq === null || row.modseq === undefined ? null : String(row.modseq),
      });
      result.set(id, entry);
    }
    return result;
  }

  /** One work record with its anchor summary, for the list responses. */
  private async toWorkRecord(record: typeof homeWork.$inferSelect): Promise<HomeWorkRecordView> {
    const anchorRows = await this.db
      .select({
        id: messages.id,
        accountId: messages.accountId,
        threadId: messages.threadId,
        subject: messages.subject,
        sender: messages.sender,
        sentAt: messages.sentAt,
        snippet: messages.snippet,
        hasAttachments: messages.hasAttachments,
        label: accounts.label,
        color: accounts.color,
      })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(eq(messages.id, record.anchorMessageId))
      .limit(1);
    const anchorRow = anchorRows[0];
    let anchor: HomeMessageSummary | null = null;
    let occurrences: OccurrenceRefWire[] = [];
    if (anchorRow !== undefined) {
      const flags = (await this.loadOccurrences([anchorRow.id])).get(anchorRow.id);
      occurrences = flags?.refs ?? [];
      anchor = {
        messageId: anchorRow.id,
        accountId: anchorRow.accountId,
        accountLabel: anchorRow.label,
        accountColor: anchorRow.color,
        threadId: anchorRow.threadId,
        subject: anchorRow.subject,
        snippet: anchorRow.snippet,
        sender: anchorRow.sender ?? null,
        sentAt: anchorRow.sentAt?.toISOString() ?? null,
        unread: flags?.unread ?? false,
        flagged: flags?.flagged ?? false,
        hasAttachments: anchorRow.hasAttachments,
      };
    }
    return {
      ...toWorkSummary(record, anchor === null),
      accountId: record.accountId,
      anchorMessageId: record.anchorMessageId,
      anchor,
      occurrences,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      completedAt: record.completedAt?.toISOString() ?? null,
    };
  }

  private toPriority(row: typeof homePriorities.$inferSelect): HomePriorityView {
    return {
      id: row.id,
      accountId: row.accountId,
      target:
        row.targetKind === "sender"
          ? { kind: "sender", sender: row.sender ?? "" }
          : { kind: "thread", threadId: row.threadId ?? "" },
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async loadWorkForMutation(id: string): Promise<typeof homeWork.$inferSelect> {
    const rows = await this.db.select().from(homeWork).where(eq(homeWork.id, id)).limit(1);
    const record = rows[0];
    if (record === undefined) {
      throw new HomeError("not_found", "The saved work record does not exist.", 404);
    }
    return record;
  }

  /** One audit event, ids and timestamps only (SPEC F13). */
  private async recordEvent(
    type: string,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(events).values({
      actor: "user",
      type,
      entityType,
      entityId,
      payload,
    });
  }
}

// -------------------------------------------------------------------------
// Shared SQL fragments
// -------------------------------------------------------------------------

/** An active occurrence in an inbox-role folder (SPEC F13 exclusions). */
const inboxOccurrence = sql`exists (
  select 1 from message_occurrences o
  join folders f on f.id = o.folder_id
  where o.message_id = m.id
    and o.expunged_at is null and o.invalidated_at is null
    and f.role = 'inbox'
)`;

/** An active flagged occurrence outside junk, trash, and drafts. */
const starredOccurrence = sql`exists (
  select 1 from message_occurrences o
  join folders f on f.id = o.folder_id
  where o.message_id = m.id
    and o.expunged_at is null and o.invalidated_at is null
    and o.flagged
    and coalesce(f.role, 'inbox') not in ('junk', 'trash', 'drafts')
)`;

/** No dismissal hides this message from Home. */
const notDismissed = sql`not exists (
  select 1 from home_dismissals hd
  where hd.account_id = m.account_id and hd.message_id = m.id
)`;

/** A UUID list literal for `in (...)` clauses. */
function uuidList(ids: string[]): ReturnType<typeof sql> {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

// -------------------------------------------------------------------------
// Candidate and row mapping
// -------------------------------------------------------------------------

/** Read the current stored signals for one message's reason labels. */
function toAttentionCandidate(row: Record<string, unknown>): AttentionCandidate {
  return {
    messageId: String(row.id),
    accountId: String(row.account_id),
    threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
    sentAt: dateOf(row.sent_at) ?? dateOf(row.ingested_at),
    senderAddress: readSenderAddress(row.sender),
    classHint: (row.class_hint as AttentionCandidate["classHint"]) ?? null,
    classSource: (row.class_source as AttentionCandidate["classSource"]) ?? null,
    asksAction: nullableBoolean(row.asks_action),
    asksReply: nullableBoolean(row.asks_reply),
    timeSensitive: nullableBoolean(row.time_sensitive),
    actionConfidence: row.action_confidence === null || row.action_confidence === undefined
      ? null : Number(row.action_confidence),
    prioritySender: row.priority_sender === true,
    priorityThread: row.priority_thread === true,
  };
}

function readSenderAddress(sender: unknown): string | null {
  if (sender === null || typeof sender !== "object") {
    return null;
  }
  const address = (sender as { address?: unknown }).address;
  return typeof address === "string" && address.length > 0 ? address.toLowerCase() : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

function toWorkSummary(
  record: typeof homeWork.$inferSelect,
  anchorUnavailable: boolean,
): HomeWorkSummary {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    dueAt: record.dueAt?.toISOString() ?? null,
    timeZone: record.timeZone,
    revision: record.revision,
    anchorUnavailable,
  };
}

/** One work-section message summary; unavailable anchors stay explainable. */
function workMessageSummary(row: Record<string, unknown>, unavailable: boolean): HomeMessageSummary {
  if (unavailable) {
    return {
      messageId: String(row.anchor_message_id),
      accountId: String(row.account_id),
      accountLabel: String(row.account_label ?? ""),
      accountColor: String(row.account_color ?? ""),
      threadId: null,
      subject: null,
      snippet: null,
      sender: null,
      sentAt: null,
      unread: false,
      flagged: false,
      hasAttachments: false,
    };
  }
  return {
    messageId: String(row.anchor_message_id),
    accountId: String(row.account_id),
    accountLabel: String(row.account_label ?? ""),
    accountColor: String(row.account_color ?? ""),
    threadId:
      row.current_thread_id === null || row.current_thread_id === undefined
        ? null
        : String(row.current_thread_id),
    subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
    snippet: row.snippet === null || row.snippet === undefined ? null : String(row.snippet),
    sender: (row.sender as MessageAddress | null) ?? null,
    sentAt: isoOf(row.sent_at),
    unread: false,
    flagged: false,
    hasAttachments: row.has_attachments === true,
  };
}

function reason(code: HomeReasonCode, origin: HomeReasonOrigin): HomeReasonView {
  return { code, origin };
}

function encodeCursor(cursor: HomeSectionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): HomeSectionCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HomeError("invalid_request", "The section cursor is not valid.");
  }
  if (parsed === null || typeof parsed !== "object" || !("section" in parsed)) {
    throw new HomeError("invalid_request", "The section cursor is not valid.");
  }
  const cursor = parsed as HomeSectionCursor;
  if (!["due_now", "needs_attention", "reply_later", "since_visit", "saved"].includes(cursor.section)) {
    throw new HomeError("invalid_request", "The section cursor is not valid.");
  }
  if (!Number.isInteger(cursor.tier) || cursor.tier < 0 || cursor.tier > 1 ||
      typeof cursor.sortValue !== "string" || !/^-?\d+(\.\d+)?$/.test(cursor.sortValue) ||
      cursor.sortValue.length > 40 || typeof cursor.id !== "string" || !UUID_PATTERN.test(cursor.id) ||
      !(cursor.boundary === null || typeof cursor.boundary === "string")) {
    throw new HomeError("invalid_request", "The section cursor is not valid. Reload Home.");
  }
  if (cursor.boundary !== null) parseInstant(cursor.boundary, "visit boundary");
  return cursor;
}

/**
 * Read one timestamp from a raw row. Raw queries return timestamps as
 * PostgreSQL text (for example `2026-09-20 11:00:00+00`), while typed queries
 * return `Date` instances; accept both. `infinity` parses to `NaN` and reads
 * as `null`.
 */
function dateOf(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function isoOf(value: unknown): string | null {
  return dateOf(value)?.toISOString() ?? null;
}

function parseInstant(value: string | null | undefined, kind: string): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw new HomeError("invalid_request", `The ${kind} must be an ISO 8601 timestamp.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HomeError("invalid_request", `The ${kind} must be an ISO 8601 timestamp.`);
  }
  return parsed;
}

/** Validate one reminder instant: future, and not absurdly far away. */
function validateDueAt(value: string | null | undefined, now: Date): Date {
  if (typeof value !== "string" || value.length === 0) {
    throw new HomeError("due_time_invalid", "A reminder needs the resolved date and time.");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HomeError("due_time_invalid", "The reminder time must be an ISO 8601 timestamp.");
  }
  if (parsed.getTime() <= now.getTime()) {
    throw new HomeError("due_time_invalid", "The reminder time must lie in the future.");
  }
  if (parsed.getTime() - now.getTime() > MAX_REMINDER_AHEAD_MS) {
    throw new HomeError("due_time_invalid", "The reminder time lies too far in the future.");
  }
  return parsed;
}

/** Validate one IANA zone name by asking the runtime to use it. */
function validateTimeZone(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new HomeError("time_zone_invalid", "A reminder needs the timezone that interpreted the choice.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new HomeError("time_zone_invalid", "The timezone is not a known IANA zone name.");
  }
  return value;
}

type NormalizedTarget = { kind: "sender"; sender: string } | { kind: "thread"; threadId: string };

function normalizeTarget(target: HomePriorityTargetWire): NormalizedTarget {
  if (target === null || typeof target !== "object") {
    throw new HomeError("invalid_request", "The priority target names one sender or one thread.");
  }
  if (target.kind === "sender") {
    const sender = target.sender.trim().toLowerCase();
    if (sender.length < 3 || sender.length > MAX_SENDER_CHARS || !sender.includes("@")) {
      throw new HomeError("invalid_request", "The sender target must be an email address.");
    }
    return { kind: "sender", sender };
  }
  if (target.kind === "thread") {
    requireUuid("thread id", target.threadId);
    return { kind: "thread", threadId: target.threadId };
  }
  throw new HomeError("invalid_request", "The priority target names one sender or one thread.");
}

async function requireAccount(db: MailHubDatabase, accountId: string): Promise<void> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (rows[0] === undefined) {
    throw new HomeError("not_found", "The account does not exist.", 404);
  }
}

function requireDeviceId(deviceId: string | undefined): string {
  if (typeof deviceId !== "string" || deviceId.length < 8 || deviceId.length > MAX_DEVICE_ID_CHARS) {
    throw new HomeError("invalid_request", "The device identifier must be 8 to 100 characters.");
  }
  return deviceId;
}

function requireUuid(kind: string, id: string): void {
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    throw new HomeError("invalid_request", `${kind} must be a UUID.`);
  }
}

function requireRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new HomeError("invalid_request", "The revision must be a positive integer.");
  }
}

function requireCurrentRevision(record: { revision: number }, revision: number): void {
  if (record.revision !== revision) {
    throw staleError(record.revision);
  }
}

function staleError(currentRevision: number): HomeError {
  return new HomeError(
    "work_stale",
    "This saved work changed on another device. Reload it and try again.",
    409,
    currentRevision,
  );
}

function isUniqueViolation(cause: unknown): boolean {
  // Drizzle wraps the driver error, so the PostgreSQL code sits on an inner
  // cause; walk the chain instead of trusting the outermost object.
  let current: unknown = cause;
  while (typeof current === "object" && current !== null) {
    if ((current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SECTION_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SECTION_LIMIT) {
    throw new HomeError("invalid_request", `The section limit must be 1 to ${MAX_SECTION_LIMIT}.`);
  }
  return limit;
}
