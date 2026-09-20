import { and, eq, inArray, sql } from "drizzle-orm";
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
  attentionTier,
  compareIdentifier,
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

/**
 * The cursor payloads, one per section, frozen at page emission. The time a
 * cursor carries is the section's own order key: the due instant for Due
 * now, the saved instant for Reply later, the arrival instant for Since your
 * last visit, and the effective send time for Needs attention and Saved.
 *
 * Pages cut at the row a section orders by, so a conversation whose rows
 * straddle a page boundary appears once per page; the client merges rows by
 * `entryKey`.
 */
export type HomeSectionCursor =
  | { section: "needs_attention"; tier: number; sentAt: string; messageId: string }
  | { section: "due_now"; dueAt: string; id: string }
  | { section: "reply_later"; createdAt: string; id: string }
  | { section: "since_visit"; ingestedAt: string; id: string; boundary: string | null }
  | { section: "saved"; sentAt: string; id: string };

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
}

/** One candidate with the display fields its row summary needs. */
interface RankedCandidate {
  candidate: AttentionCandidate;
  display: {
    subject: string | null;
    snippet: string | null;
    sender: MessageAddress | null;
    hasAttachments: boolean;
    accountLabel: string;
    accountColor: string;
    /** The effective send time the section ordered by. */
    sortTime: string;
  };
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

    const sections: HomeSectionResult[] = [
      await this.readDueNow(limit, null),
      await this.readNeedsAttention(limit, null),
      await this.readReplyLater(limit, null),
      await this.readSinceVisit(limit, null, boundary),
      await this.readSaved(limit, null),
    ];
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
    switch (input.section) {
      case "due_now":
        return this.readDueNow(limit, cursor as DueNowCursor | null);
      case "needs_attention":
        return this.readNeedsAttention(limit, cursor as AttentionCursor | null);
      case "reply_later":
        return this.readReplyLater(limit, cursor as ReplyLaterCursor | null);
      case "since_visit": {
        const sinceCursor = cursor as SinceCursor | null;
        // The cursor freezes the boundary the session started with, so a
        // page never shifts under a boundary that advanced mid-session.
        const boundary =
          sinceCursor !== null
            ? parseInstant(sinceCursor.boundary, "visit boundary")
            : await this.readVisitBoundary(requireDeviceId(input.deviceId));
        return this.readSinceVisit(limit, sinceCursor, boundary);
      }
      case "saved":
        return this.readSaved(limit, cursor as SavedCursor | null);
      default:
        // The schema at the boundary narrows the id; a caller that bypasses
        // the schema still gets a refusal, never a resolved empty answer.
        throw new HomeError("invalid_request", "Unknown section.");
    }
  }

  // ---------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------

  /** Due now: open reminders whose time passed, earliest first. */
  private async readDueNow(limit: number, cursor: DueNowCursor | null): Promise<HomeSectionResult> {
    const now = this.now();
    const cursorFilter =
      cursor === null
        ? sql``
        : sql`and (w.due_at > ${parseInstant(cursor.dueAt, "cursor due time")}
                   or (w.due_at = ${parseInstant(cursor.dueAt, "cursor due time")} and w.id > ${cursor.id}))`;
    const rows = await this.db.execute(sql`
      select w.id, w.kind, w.status, w.due_at, w.time_zone, w.revision,
             w.account_id, w.anchor_message_id, w.thread_id,
             m.subject, m.sender, m.sent_at, m.snippet, m.thread_id as current_thread_id,
             m.has_attachments, m.id is not null as message_exists,
             a.label as account_label, a.color as account_color
      from home_work w
      join accounts a on a.id = w.account_id
      left join messages m on m.id = w.anchor_message_id
      where w.status = 'open' and w.kind = 'reminder' and w.due_at <= ${now}
        ${cursorFilter}
      order by w.due_at asc, w.id asc
      limit ${limit + 1}
    `);
    const items = await this.decorate(this.groupWorkEntries(rows.rows.slice(0, limit), "reminder_due"), false);
    const totalRows = await this.db.execute(sql`
      select count(distinct coalesce(m.thread_id, w.thread_id, w.anchor_message_id))::int as total
      from home_work w
      left join messages m on m.id = w.anchor_message_id
      where w.status = 'open' and w.kind = 'reminder' and w.due_at <= ${now}
    `);
    return {
      id: "due_now",
      total: Number(totalRows.rows[0]?.total ?? 0),
      items,
      nextCursor: pageCursor(rows.rows, limit, (last) => ({
        section: "due_now",
        dueAt: isoOf(last.due_at) ?? "",
        id: String(last.id),
      })),
    };
  }

  /** Reply later: open commitments, oldest first. */
  private async readReplyLater(limit: number, cursor: ReplyLaterCursor | null): Promise<HomeSectionResult> {
    const cursorFilter =
      cursor === null
        ? sql``
        : sql`and (w.created_at > ${parseInstant(cursor.createdAt, "cursor created time")}
                   or (w.created_at = ${parseInstant(cursor.createdAt, "cursor created time")} and w.id > ${cursor.id}))`;
    const rows = await this.db.execute(sql`
      select w.id, w.kind, w.status, w.due_at, w.time_zone, w.revision,
             w.account_id, w.anchor_message_id, w.thread_id, w.created_at,
             m.subject, m.sender, m.sent_at, m.snippet, m.thread_id as current_thread_id,
             m.has_attachments, m.id is not null as message_exists,
             a.label as account_label, a.color as account_color
      from home_work w
      join accounts a on a.id = w.account_id
      left join messages m on m.id = w.anchor_message_id
      where w.status = 'open' and w.kind = 'reply_later'
        ${cursorFilter}
      order by w.created_at asc, w.id asc
      limit ${limit + 1}
    `);
    const items = await this.decorate(this.groupWorkEntries(rows.rows.slice(0, limit), "reply_planned"), false);
    const totalRows = await this.db.execute(sql`
      select count(distinct coalesce(m.thread_id, w.thread_id, w.anchor_message_id))::int as total
      from home_work w
      left join messages m on m.id = w.anchor_message_id
      where w.status = 'open' and w.kind = 'reply_later'
    `);
    return {
      id: "reply_later",
      total: Number(totalRows.rows[0]?.total ?? 0),
      items,
      nextCursor: pageCursor(rows.rows, limit, (last) => ({
        section: "reply_later",
        createdAt: isoOf(last.created_at) ?? "",
        id: String(last.id),
      })),
    };
  }

  /**
   * Needs attention: explicit priority choices and stored suggestions, one
   * leading tier for protected items and priority, then the remaining
   * suggestions, effective send time breaking ties. The ranking resolves in
   * SQL before the page is cut, so a priority item never lands beyond a
   * recent-mail limit, and the keyset cursor pages through the ranked order.
   */
  private async readNeedsAttention(
    limit: number,
    cursor: AttentionCursor | null,
  ): Promise<HomeSectionResult> {
    const priorities = await this.db.select().from(homePriorities);
    const priorityMatch = priorityMatchSql(priorities);
    const eligibility = sql`(
      ${priorityMatch}
      or m.class_hint = 'security_alert'
      or m.asks_action is true
      or m.asks_reply is true
      or m.time_sensitive is true
    )`;
    const innerWhere = sql`where ${inboxOccurrence} and ${notDismissed} and ${eligibility}`;
    const cursorFilter =
      cursor === null
        ? sql``
        : sql`where (ranked.tier > ${cursor.tier}
                   or (ranked.tier = ${cursor.tier} and (
                     ranked.sort_time < ${parseInstant(cursor.sentAt, "cursor send time")}
                     or (ranked.sort_time = ${parseInstant(cursor.sentAt, "cursor send time")} and ranked.id > ${cursor.messageId})
                   )))`;
    const rows = await this.db.execute(sql`
      select ranked.* from (
        select m.id, m.account_id, m.thread_id, m.sent_at, m.ingested_at, m.sender,
               m.subject, m.snippet, m.has_attachments,
               m.class_hint, m.asks_action, m.asks_reply, m.time_sensitive,
               m.metadata ->> 'classSource' as class_source,
               (case when (
                 ${priorityMatch}
                 or m.class_hint = 'security_alert'
                 or (m.asks_action is true and coalesce(conf.action_confidence, -1) >= ${ACTION_BREAKOUT_CONFIDENCE})
               ) then 0 else 1 end) as tier,
               coalesce(m.sent_at, m.ingested_at) as sort_time,
               a.label as account_label, a.color as account_color
        from messages m
        join accounts a on a.id = m.account_id
        left join lateral (
          select (d.confidence ->> 'asks_action')::float8 as action_confidence
          from decisions d
          where d.message_id = m.id and m.metadata ->> 'classSource' = 'jev'
          order by d.created_at desc
          limit 1
        ) conf on true
        ${innerWhere}
      ) ranked
      ${cursorFilter}
      order by ranked.tier asc, ranked.sort_time desc, ranked.id asc
      limit ${limit + 1}
    `);
    const ranked = rows.rows
      .slice(0, limit)
      .map((row) => toRankedCandidate(row, priorities));
    const items = await this.decorate(this.groupAttentionEntries(ranked), true);
    // The total counts conversations, not messages: one entry may cover
    // several messages of one thread (SPEC F13 grouping).
    const totalRows = await this.db.execute(sql`
      select count(distinct coalesce(m.thread_id, m.id))::int as total
      from messages m
      left join lateral (
        select (d.confidence ->> 'asks_action')::float8 as action_confidence
        from decisions d
        where d.message_id = m.id and m.metadata ->> 'classSource' = 'jev'
        order by d.created_at desc
        limit 1
      ) conf on true
      ${innerWhere}
    `);
    return {
      id: "needs_attention",
      total: Number(totalRows.rows[0]?.total ?? 0),
      items,
      nextCursor: pageCursor(rows.rows, limit, (last) => {
        const { candidate } = toRankedCandidate(last, priorities);
        return {
          section: "needs_attention",
          tier: attentionTier(candidate) ?? 1,
          sentAt: isoOf(last.sort_time) ?? isoOf(last.sent_at) ?? "",
          messageId: candidate.messageId,
        };
      }),
    };
  }

  /** Since your last visit: new inbox arrivals after the frozen boundary. */
  private async readSinceVisit(
    limit: number,
    cursor: SinceCursor | null,
    boundary: Date | null,
  ): Promise<HomeSectionResult> {
    if (boundary === null) {
      return { id: "since_visit", total: 0, items: [], nextCursor: null };
    }
    const cursorFilter =
      cursor === null
        ? sql``
        : sql`and (m.ingested_at < ${parseInstant(cursor.ingestedAt, "cursor arrival")}
                   or (m.ingested_at = ${parseInstant(cursor.ingestedAt, "cursor arrival")} and m.id > ${cursor.id}))`;
    const rows = await this.db.execute(sql`
      select m.id
      from messages m
      join accounts a on a.id = m.account_id
      where ${inboxOccurrence}
        and ${notDismissed}
        and m.ingested_at > ${boundary}
        ${cursorFilter}
      order by m.ingested_at desc, m.id asc
      limit ${limit + 1}
    `);
    const messageIds = rows.rows.slice(0, limit).map((row) => String(row.id));
    const items = await this.decorate(
      await this.buildMessageEntries(messageIds, "new_arrival", "notice"),
      true,
    );
    const totalRows = await this.db.execute(sql`
      select count(distinct coalesce(m.thread_id, m.id))::int as total
      from messages m
      where ${inboxOccurrence}
        and ${notDismissed}
        and m.ingested_at > ${boundary}
    `);
    return {
      id: "since_visit",
      total: Number(totalRows.rows[0]?.total ?? 0),
      items,
      nextCursor: pageCursor(rows.rows, limit, (last) => ({
        section: "since_visit",
        ingestedAt: isoOf(last.ingested_at) ?? "",
        id: String(last.id),
        boundary: boundary.toISOString(),
      })),
    };
  }

  /** Saved: starred mail for quick reference, effective send time order. */
  private async readSaved(limit: number, cursor: SavedCursor | null): Promise<HomeSectionResult> {
    const cursorFilter =
      cursor === null
        ? sql``
        : sql`where (ranked.sort_time < ${parseInstant(cursor.sentAt, "cursor send time")}
                   or (ranked.sort_time = ${parseInstant(cursor.sentAt, "cursor send time")} and ranked.id > ${cursor.id}))`;
    const rows = await this.db.execute(sql`
      select ranked.id from (
        select m.id, coalesce(m.sent_at, m.ingested_at) as sort_time
        from messages m
        join accounts a on a.id = m.account_id
        where ${starredOccurrence}
      ) ranked
      ${cursorFilter}
      order by ranked.sort_time desc, ranked.id asc
      limit ${limit + 1}
    `);
    const messageIds = rows.rows.slice(0, limit).map((row) => String(row.id));
    const items = await this.decorate(
      await this.buildMessageEntries(messageIds, "you_starred", "choice"),
      true,
    );
    const totalRows = await this.db.execute(sql`
      select count(distinct coalesce(m.thread_id, m.id))::int as total
      from messages m
      where ${starredOccurrence}
    `);
    return {
      id: "saved",
      total: Number(totalRows.rows[0]?.total ?? 0),
      items,
      nextCursor: pageCursor(rows.rows, limit, (last) => ({
        section: "saved",
        sentAt: isoOf(last.sort_time) ?? "",
        id: String(last.id),
      })),
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

  /** Every saved work record, open work first, for review and reopening. */
  async listWork(
    input: { status?: "open" | "done"; kind?: HomeWorkKindWire } = {},
  ): Promise<HomeWorkRecordView[]> {
    const conditions = [];
    if (input.status !== undefined) {
      conditions.push(eq(homeWork.status, input.status));
    }
    if (input.kind !== undefined) {
      conditions.push(eq(homeWork.kind, input.kind));
    }
    const rows = await this.db
      .select()
      .from(homeWork)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        sql`status = 'open' desc, kind = 'reminder' desc, due_at asc nulls last, created_at asc, id asc`,
      )
      .limit(WORK_LIST_LIMIT);
    return Promise.all(rows.map((row) => this.toWorkRecord(row)));
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

  /** Group one page of work rows into conversation entries. */
  private groupWorkEntries(
    page: Record<string, unknown>[],
    reasonCode: HomeReasonCode,
  ): HomeItemView[] {
    const byConversation = new Map<string, HomeItemView>();
    for (const row of page) {
      const anchorUnavailable = row.message_exists !== true;
      const work: HomeWorkSummary = {
        id: String(row.id),
        kind: row.kind === "reminder" ? "reminder" : "reply_later",
        status: row.status === "done" ? "done" : "open",
        dueAt: isoOf(row.due_at),
        timeZone: typeof row.time_zone === "string" ? row.time_zone : null,
        revision: Number(row.revision ?? 1),
        anchorUnavailable,
      };
      const entryKey = conversationKey(row.current_thread_id, row.thread_id, row.anchor_message_id);
      const existing = byConversation.get(entryKey);
      if (existing === undefined) {
        byConversation.set(entryKey, {
          entryKey,
          message: workMessageSummary(row, anchorUnavailable),
          messageIds: [String(row.anchor_message_id)],
          reasons: [reason(reasonCode, "choice")],
          work: [work],
          occurrences: [],
          noServerCopy: false,
        });
        continue;
      }
      if (!existing.messageIds.includes(String(row.anchor_message_id))) {
        existing.messageIds.push(String(row.anchor_message_id));
      }
      existing.work.push(work);
    }
    return [...byConversation.values()];
  }

  /** Group ranked candidates into one entry per conversation. */
  private groupAttentionEntries(ranked: RankedCandidate[]): HomeItemView[] {
    const byConversation = new Map<
      string,
      { lead: RankedCandidate; reasons: HomeReasonView[]; ids: string[] }
    >();
    for (const item of ranked) {
      const entryKey = item.candidate.threadId ?? item.candidate.messageId;
      const entry = byConversation.get(entryKey);
      const itemReasons = attentionReasons(item.candidate);
      if (entry === undefined) {
        byConversation.set(entryKey, { lead: item, reasons: itemReasons, ids: [item.candidate.messageId] });
        continue;
      }
      for (const itemReason of itemReasons) {
        if (!entry.reasons.some((existing) => existing.code === itemReason.code)) {
          entry.reasons.push(itemReason);
        }
      }
      if (!entry.ids.includes(item.candidate.messageId)) {
        entry.ids.push(item.candidate.messageId);
      }
    }
    return [...byConversation.values()].map((entry) => ({
      entryKey: entry.lead.candidate.threadId ?? entry.lead.candidate.messageId,
      message: {
        messageId: entry.lead.candidate.messageId,
        accountId: entry.lead.candidate.accountId,
        accountLabel: entry.lead.display.accountLabel,
        accountColor: entry.lead.display.accountColor,
        threadId: entry.lead.candidate.threadId,
        subject: entry.lead.display.subject,
        snippet: entry.lead.display.snippet,
        sender: entry.lead.display.sender,
        sentAt: entry.lead.candidate.sentAt?.toISOString() ?? null,
        unread: false,
        flagged: false,
        hasAttachments: entry.lead.display.hasAttachments,
      },
      messageIds: entry.ids,
      reasons: entry.reasons,
      work: [],
      occurrences: [],
      noServerCopy: false,
    }));
  }

  /** Build display entries for plain message sections (Since, Saved). */
  private async buildMessageEntries(
    messageIds: string[],
    reasonCode: HomeReasonCode,
    origin: HomeReasonOrigin,
  ): Promise<HomeItemView[]> {
    if (messageIds.length === 0) {
      return [];
    }
    const rows = await this.db.execute(sql`
      select m.id, m.account_id, m.thread_id, m.sent_at, m.sender, m.subject,
             m.snippet, m.has_attachments,
             a.label as account_label, a.color as account_color
      from messages m
      join accounts a on a.id = m.account_id
      where m.id in (${uuidList(messageIds)})
    `);
    const byMessage = new Map(rows.rows.map((row) => [String(row.id), row]));
    const byConversation = new Map<string, HomeItemView>();
    for (const id of messageIds) {
      const row = byMessage.get(id);
      if (row === undefined) {
        continue;
      }
      const entryKey = conversationKey(row.thread_id, null, row.id);
      const existing = byConversation.get(entryKey);
      if (existing === undefined) {
        byConversation.set(entryKey, {
          entryKey,
          message: {
            messageId: id,
            accountId: String(row.account_id),
            accountLabel: String(row.account_label ?? ""),
            accountColor: String(row.account_color ?? ""),
            threadId: row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id),
            subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
            snippet: row.snippet === null || row.snippet === undefined ? null : String(row.snippet),
            sender: (row.sender as MessageAddress | null) ?? null,
            sentAt: isoOf(row.sent_at),
            unread: false,
            flagged: false,
            hasAttachments: row.has_attachments === true,
          },
          messageIds: [id],
          reasons: [{ code: reasonCode, origin }],
          work: [],
          occurrences: [],
          noServerCopy: false,
        });
        continue;
      }
      if (!existing.messageIds.includes(id)) {
        existing.messageIds.push(id);
      }
    }
    return [...byConversation.values()];
  }

  /**
   * Finish one page of entries: freeze the representative's occurrences for
   * mail actions, and attach the open work anchored in each conversation.
   */
  private async decorate(entries: HomeItemView[], includeWork: boolean): Promise<HomeItemView[]> {
    if (entries.length === 0) {
      return entries;
    }
    const representativeIds = entries.map((entry) => entry.message.messageId);
    const occurrences = await this.loadOccurrences(representativeIds);
    for (const entry of entries) {
      const flags = occurrences.get(entry.message.messageId);
      entry.occurrences = flags?.refs ?? [];
      entry.noServerCopy = (flags?.refs.length ?? 0) === 0;
      entry.message.unread = flags?.unread ?? false;
      entry.message.flagged = flags?.flagged ?? false;
    }
    if (includeWork) {
      const coveredIds = entries.flatMap((entry) => entry.messageIds);
      const workRows = coveredIds.length
        ? await this.db
            .select()
            .from(homeWork)
            .where(and(eq(homeWork.status, "open"), inArray(homeWork.anchorMessageId, coveredIds)))
        : [];
      const byAnchor = new Map(workRows.map((row) => [row.anchorMessageId, row]));
      for (const entry of entries) {
        entry.work = entry.messageIds
          .map((id) => byAnchor.get(id))
          .filter((row): row is typeof homeWork.$inferSelect => row !== undefined)
          .sort(
            (a, b) =>
              (a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) -
                (b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) || compareIdentifier(a.id, b.id),
          )
          .map((row) => toWorkSummary(row, false));
      }
    }
    return entries;
  }

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
    if (anchorRow !== undefined) {
      const flags = (await this.loadOccurrences([anchorRow.id])).get(anchorRow.id);
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

/** The match expression for every loaded priority choice. */
function priorityMatchSql(choices: (typeof homePriorities.$inferSelect)[]): ReturnType<typeof sql> {
  if (choices.length === 0) {
    return sql`false`;
  }
  const parts = choices.map((choice) =>
    choice.targetKind === "sender"
      ? sql`(m.account_id = ${choice.accountId} and lower(m.sender ->> 'address') = ${choice.sender ?? ""})`
      : sql`(m.account_id = ${choice.accountId} and m.thread_id = ${choice.threadId})`,
  );
  return sql.join(parts, sql` or `);
}

// -------------------------------------------------------------------------
// Candidate and row mapping
// -------------------------------------------------------------------------

/** One ranked attention row, plus its priority flags and display fields. */
function toRankedCandidate(
  row: Record<string, unknown>,
  priorities: (typeof homePriorities.$inferSelect)[],
): RankedCandidate {
  const accountId = String(row.account_id);
  const messageId = String(row.id);
  const senderAddress = readSenderAddress(row.sender);
  const threadId = row.thread_id === null || row.thread_id === undefined ? null : String(row.thread_id);
  const prioritySender = priorities.some(
    (choice) =>
      choice.targetKind === "sender" && choice.accountId === accountId && choice.sender === senderAddress,
  );
  const priorityThread = priorities.some(
    (choice) =>
      choice.targetKind === "thread" && choice.accountId === accountId && choice.threadId === threadId,
  );
  return {
    candidate: {
      messageId,
      accountId,
      threadId,
      sentAt: dateOf(row.sent_at) ?? dateOf(row.ingested_at),
      senderAddress,
      classHint: (row.class_hint as AttentionCandidate["classHint"]) ?? null,
      classSource: (row.class_source as AttentionCandidate["classSource"]) ?? null,
      asksAction: nullableBoolean(row.asks_action),
      asksReply: nullableBoolean(row.asks_reply),
      timeSensitive: nullableBoolean(row.time_sensitive),
      actionConfidence:
        row.action_confidence === null || row.action_confidence === undefined
          ? null
          : Number(row.action_confidence),
      prioritySender,
      priorityThread,
    },
    display: {
      subject: row.subject === null || row.subject === undefined ? null : String(row.subject),
      snippet: row.snippet === null || row.snippet === undefined ? null : String(row.snippet),
      sender: (row.sender as MessageAddress | null) ?? null,
      hasAttachments: row.has_attachments === true,
      accountLabel: String(row.account_label ?? ""),
      accountColor: String(row.account_color ?? ""),
      sortTime: isoOf(row.sort_time) ?? "",
    },
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

/** The conversation key: current thread, saved thread, then the anchor. */
function conversationKey(current: unknown, saved: unknown, fallback: unknown): string {
  for (const value of [current, saved]) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return String(fallback);
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

/**
 * The cursor for the next page: the key of the last returned row, emitted
 * only when the query fetched one row beyond the page.
 */
function pageCursor(
  rows: Record<string, unknown>[],
  limit: number,
  build: (last: Record<string, unknown>) => HomeSectionCursor,
): string | null {
  if (rows.length <= limit) {
    return null;
  }
  return encodeCursor(build(rows[limit - 1]!));
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
  return cursor;
}

type DueNowCursor = Extract<HomeSectionCursor, { section: "due_now" }>;
type ReplyLaterCursor = Extract<HomeSectionCursor, { section: "reply_later" }>;
type AttentionCursor = Extract<HomeSectionCursor, { section: "needs_attention" }>;
type SinceCursor = Extract<HomeSectionCursor, { section: "since_visit" }>;
type SavedCursor = Extract<HomeSectionCursor, { section: "saved" }>;

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
