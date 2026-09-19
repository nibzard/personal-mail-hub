import { eq, sql, type SQL } from "drizzle-orm";
import {
  events,
  savedSearches,
  type EmailAddress,
  type MailHubDatabase,
  type SavedSearchScope,
  type SentCopyStatus,
} from "@mail-hub/database";
import type { MutationGate } from "@mail-hub/recovery";
import { SearchError } from "./errors.ts";
import { normalizeDomainValue, parseSearchQuery } from "./query.ts";

/**
 * Cross-account full-text search and saved-search query state (SPEC F5).
 *
 * One query box searches every account by default. Free text runs against
 * the generated `search` vector — sender, recipients, and subject at weight
 * `A`, body at weight `B` — so a missing body never excludes a header match
 * and ranking prefers header hits. Operators and the account, domain, and
 * folder filters narrow the same query. Flag filters read active occurrences
 * in the selected scope; retained local records without any occurrence stay
 * searchable everywhere and a dedicated filter selects them.
 *
 * Saved searches store their query text and scope, not results: the state is
 * the query, and running it again recomputes the answer. Their mutations
 * pass the recovery gate like every other durable client write.
 */

/** The longest query text the service accepts, from the box or a saved search. */
export const MAX_QUERY_CHARS = 2000;

/** One page of results. */
export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 100;
export const MAX_SEARCH_OFFSET = 10_000;

/** Filter-chip caps keep one request from becoming an unbounded scan. */
export const MAX_ACCOUNT_FILTERS = 20;
export const MAX_DOMAIN_FILTERS = 10;

/** A saved search name stays short enough to read in a chip row. */
export const MAX_SAVED_SEARCH_NAME_CHARS = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One search request: the query text plus the scope the client selected.
 * Every field is optional; an entirely empty input lists newest first.
 */
export interface SearchInput {
  /** Query text with operators, exactly as typed. */
  query: string;
  /** Account filter chips. Absent or `null` searches every account. */
  accountIds?: string[] | null;
  /** One folder scope; `null` keeps every folder (SPEC F5). */
  folderId?: string | null;
  /** Domain filter chips. */
  domains?: string[] | null;
  /** The local archive filter: only records without active occurrences. */
  localOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** One result row: what a result list needs, plus rank and highlight. */
export interface SearchHit {
  messageId: string;
  accountId: string;
  accountLabel: string;
  accountColor: string;
  threadId: string | null;
  subject: string | null;
  snippet: string | null;
  sender: EmailAddress | null;
  /** The effective send time: `sent_at`, or the earliest internal date. */
  sentAt: Date | null;
  fetchedBody: boolean;
  hasAttachments: boolean;
  /** At least one active occurrence in scope holds the flag (SPEC F4). */
  unread: boolean;
  flagged: boolean;
  /** Active occurrences in the current scope; zero marks a retained record. */
  activeOccurrences: number;
  /** True when no server copy remains anywhere (SPEC F5). */
  noServerCopy: boolean;
  /** Sent-copy state of the outgoing record this message is, when it is one. */
  sentCopyStatus: SentCopyStatus | null;
  /** Text-search rank; `null` when the query had no free text. */
  rank: number | null;
  /** Marked-up match context; `null` when only addresses matched. */
  highlight: string | null;
  highlightSource: "subject" | "body" | null;
}

/** One complete search answer. */
export interface SearchResult {
  results: SearchHit[];
  /** Total rows the query matches, past the returned page. */
  total: number;
  /** Body-indexing progress across the account scope (SPEC F5). */
  indexing: { messages: number; bodies: number };
}

/** One stored saved search. */
export interface SavedSearchRecord {
  id: string;
  name: string;
  query: string;
  scope: SavedSearchScope;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for one new saved search. */
export interface CreateSavedSearchInput {
  name: string;
  query: string;
  scope?: SavedSearchScope | null;
}

/** Context for one durable mutation: the generation the client captured. */
export interface MutationContext {
  requestGeneration?: string | null;
}

/** One result row as PostgreSQL returns it. A type alias, not an interface,
 * so it satisfies the `Record<string, unknown>` bound of `db.execute`. */
type SearchRow = {
  id: string;
  account_id: string;
  account_label: string;
  account_color: string;
  thread_id: string | null;
  subject: string | null;
  snippet: string | null;
  sender: EmailAddress | null;
  sent_at: Date | string | null;
  effective_at: Date | string | null;
  fetched_body: boolean;
  has_attachments: boolean;
  occurrence_count: number;
  unread: boolean;
  flagged: boolean;
  sent_copy_status: SentCopyStatus | null;
  search_rank: number | null;
  highlight: string | null;
  highlight_source: "subject" | "body" | null;
  total: number;
};

/** Weight order is `{D, C, B, A}`: headers (A) outrank bodies (B). */
const RANK_WEIGHTS = "{0.1,0.2,0.4,1.0}";

/** Headline options shared by subject and body fragments. */
const HEADLINE_SUBJECT_OPTIONS = "StartSel=[, StopSel=], MaxFragments=0";
const HEADLINE_BODY_OPTIONS =
  "StartSel=[, StopSel=], MaxFragments=2, MinWords=15, MaxWords=40, FragmentDelimiter= … ";

export class SearchService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly gate: MutationGate,
  ) {}

  /**
   * Run one search across every account in scope. Invalid queries and
   * filters reject with `invalid_query` and `invalid_request`; no result
   * ever throws.
   */
  async search(input: SearchInput): Promise<SearchResult> {
    const parsed = parseSearchQuery(readQueryText(input.query));
    const accountIds = readAccountFilters(input.accountIds);
    const domains = readDomainFilters(input.domains);
    const folderId = readFolderFilter(input.folderId);
    const limit = readLimit(input.limit);
    const offset = readOffset(input.offset);

    // With a date operator, the effective date joins the WHERE clause, and a
    // correlated subquery there blocks PostgreSQL's parallel workers. A joined
    // aggregate computes the same fallback once, in parallel. Without dates
    // the scalar form stays in the SELECT and ORDER BY only, where it never
    // blocks workers and never runs while `sent_at` is present.
    const hasDates = parsed.before !== null || parsed.after !== null;
    const effectiveAt = hasDates
      ? sql`coalesce(m.sent_at, occ.first_seen)`
      : sql`coalesce(
          m.sent_at,
          (select min(o.internal_date) from message_occurrences o where o.message_id = m.id)
        )`;
    // Active occurrences inside the requested scope answer both the flag
    // operators and the displayed flags (SPEC F4, F5).
    const scopeClause =
      folderId === null ? sql`` : sql` and o.folder_id = ${folderId}::uuid`;

    const conditions: SQL[] = [];
    const hasText = parsed.text.length > 0;
    if (hasText) {
      conditions.push(sql`m.search @@ q.tsq`);
    }
    for (const value of parsed.from) {
      conditions.push(sql`m.sender_text like ${containsPattern(value)} escape '\\'`);
    }
    for (const value of parsed.to) {
      conditions.push(sql`m.recipients_text like ${containsPattern(value)} escape '\\'`);
    }
    for (const domain of [...parsed.domains, ...domains]) {
      conditions.push(domainCondition(domain));
    }
    if (parsed.types.length > 0) {
      conditions.push(sql`m.class_hint in (${sql.join(
        parsed.types.map((type) => sql`${type}`),
        sql`, `,
      )})`);
    }
    if (parsed.action) {
      conditions.push(sql`m.asks_action`);
    }
    if (parsed.hasAttachment) {
      conditions.push(sql`m.has_attachments`);
    }
    if (parsed.unread) {
      conditions.push(flagCondition("unread", scopeClause));
    }
    if (parsed.flagged) {
      conditions.push(flagCondition("flagged", scopeClause));
    }
    if (parsed.before !== null) {
      conditions.push(sql`${effectiveAt} < ${parsed.before}`);
    }
    if (parsed.after !== null) {
      conditions.push(sql`${effectiveAt} > ${parsed.after}`);
    }
    if (accountIds !== null) {
      conditions.push(
        sql`m.account_id in (${sql.join(
          accountIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      );
    }
    if (folderId !== null) {
      conditions.push(sql`exists (
        select 1 from message_occurrences o
        where o.message_id = m.id
          and o.expunged_at is null
          and o.invalidated_at is null
          and o.folder_id = ${folderId}::uuid
      )`);
    }
    if (input.localOnly === true) {
      conditions.push(sql`not exists (
        select 1 from message_occurrences o
        where o.message_id = m.id
          and o.expunged_at is null
          and o.invalidated_at is null
      )`);
    }

    const rank = hasText
      ? sql`ts_rank(${RANK_WEIGHTS}::float4[], m.search, q.tsq)`
      : sql`null::float4`;
    const highlightSource = hasText
      ? sql`case
          when to_tsvector('simple', m.subject_text) @@ q.tsq then 'subject'
          when to_tsvector('simple', m.body_index_text) @@ q.tsq then 'body'
          else null
        end`
      : sql`null::text`;
    const highlight = hasText
      ? sql`case
          when to_tsvector('simple', m.subject_text) @@ q.tsq
            then nullif(ts_headline('simple', coalesce(m.subject, m.subject_text), q.tsq, ${HEADLINE_SUBJECT_OPTIONS}::text), '')
          when to_tsvector('simple', m.body_index_text) @@ q.tsq
            then nullif(ts_headline('simple', m.body_index_text, q.tsq, ${HEADLINE_BODY_OPTIONS}::text), '')
          else null
        end`
      : sql`null::text`;

    const rows = await this.db.execute<SearchRow>(sql`
      select
        m.id,
        m.account_id,
        a.label as account_label,
        a.color as account_color,
        m.thread_id,
        m.subject,
        m.snippet,
        m.sender,
        m.sent_at,
        ${effectiveAt} as effective_at,
        m.fetched_body,
        m.has_attachments,
        (select count(*)::int from message_occurrences o
          where o.message_id = m.id
            and o.expunged_at is null
            and o.invalidated_at is null${scopeClause}) as occurrence_count,
        ${flagCondition("unread", scopeClause)} as unread,
        ${flagCondition("flagged", scopeClause)} as flagged,
        ob.sent_copy_status,
        ${rank} as search_rank,
        ${highlightSource} as highlight_source,
        ${highlight} as highlight,
        (count(*) over ())::int as total
      from messages m
      join accounts a on a.id = m.account_id
      ${hasDates ? sql`left join (
        select o.message_id, min(o.internal_date) as first_seen
        from message_occurrences o
        group by o.message_id
      ) occ on occ.message_id = m.id` : sql``}
      left join outbound_messages ob on ob.logical_message_id = m.id
      ${hasText ? sql`cross join websearch_to_tsquery('simple', ${parsed.text}) as q(tsq)` : sql``}
      ${conditions.length > 0 ? sql`where ${sql.join(conditions, sql` and `)}` : sql``}
      order by search_rank desc nulls last, effective_at desc nulls last, m.id
      limit ${limit} offset ${offset}
    `);

    const indexing = await this.bodyIndexingProgress(accountIds);

    return {
      results: rows.rows.map(toHit),
      total: rows.rows[0]?.total ?? 0,
      indexing,
    };
  }

  /**
   * Body-indexing progress across the account scope: how many logical
   * messages exist and how many have their body text indexed (SPEC F5).
   */
  async bodyIndexingProgress(accountIds?: string[] | null): Promise<{ messages: number; bodies: number }> {
    const scope =
      accountIds !== null && accountIds !== undefined && accountIds.length > 0
        ? sql` where m.account_id in (${sql.join(
            accountIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;
    const rows = await this.db.execute<{ messages: number; bodies: number }>(sql`
      select count(*)::int as messages,
        count(*) filter (where m.fetched_body)::int as bodies
      from messages m${scope}
    `);
    return rows.rows[0] ?? { messages: 0, bodies: 0 };
  }

  /** Every saved search, oldest first, ready to run as saved. */
  async listSavedSearches(): Promise<SavedSearchRecord[]> {
    const rows = await this.db.select().from(savedSearches).orderBy(savedSearches.createdAt, savedSearches.name);
    return rows.map(toSavedSearchRecord);
  }

  /**
   * Store one saved search. The query must parse and the scope must be
   * valid before anything is written; the recovery generation gate runs
   * before the insert, like every durable client mutation.
   */
  async createSavedSearch(context: MutationContext, input: CreateSavedSearchInput): Promise<SavedSearchRecord> {
    const name = readSavedSearchName(input.name);
    parseSearchQuery(readQueryText(input.query));
    const scope = readSavedSearchScope(input.scope);

    await this.gate.gateMutation(context.requestGeneration);

    const inserted = await this.db
      .insert(savedSearches)
      .values({ name, query: input.query.trim(), scope })
      .returning()
      .catch((cause: unknown) => {
        if (isUniqueViolation(cause)) {
          throw new SearchError("name_conflict", `A saved search named "${name}" already exists.`);
        }
        throw cause;
      });

    const record = toSavedSearchRecord(inserted[0]!);
    await this.db.insert(events).values({
      actor: "user",
      type: "search.saved_created",
      entityType: "saved_search",
      entityId: record.id,
      payload: { name: record.name, scope: record.scope },
    });
    return record;
  }

  /** Remove one saved search. Unknown identifiers report `not_found`. */
  async deleteSavedSearch(context: MutationContext, id: string): Promise<void> {
    if (!UUID_PATTERN.test(id)) {
      throw new SearchError("invalid_request", `Saved-search identifier must be a UUID: ${id}`);
    }
    await this.gate.gateMutation(context.requestGeneration);

    const deleted = await this.db.delete(savedSearches).where(eq(savedSearches.id, id)).returning();
    const record = deleted[0];
    if (record === undefined) {
      throw new SearchError("not_found", "No saved search exists with that identifier.");
    }
    await this.db.insert(events).values({
      actor: "user",
      type: "search.saved_deleted",
      entityType: "saved_search",
      entityId: record.id,
      payload: { name: record.name },
    });
  }
}

/**
 * `domain:` matches an address domain in the sender or any recipient
 * (SPEC F5). Addresses sit at the end of `sender_text` — names come first —
 * and inside the space-joined `recipients_text`, so two suffix patterns
 * cover every position and the trigram indexes serve them. The domain is
 * validated to plain labels, so the patterns need no wildcard escaping.
 */
function domainCondition(domain: string): SQL {
  const atEnd = `%@${domain}`;
  const midList = `%@${domain} `;
  return sql`(
    m.sender_text like ${atEnd}
    or m.recipients_text like ${atEnd}
    or m.recipients_text like ${midList}
  )`;
}

/** One flag predicate over active occurrences in the requested scope. */
function flagCondition(column: "unread" | "flagged", scopeClause: SQL): SQL {
  return sql`exists (
    select 1 from message_occurrences o
    where o.message_id = m.id
      and o.expunged_at is null
      and o.invalidated_at is null
      and o.${sql.raw(column)}${scopeClause}
  )`;
}

/** A `%value%` pattern with the LIKE wildcards escaped. */
function containsPattern(value: string): string {
  return `%${value.replace(/([\\%_])/g, "\\$1")}%`;
}

function toHit(row: SearchRow): SearchHit {
  return {
    messageId: row.id,
    accountId: row.account_id,
    accountLabel: row.account_label,
    accountColor: row.account_color,
    threadId: row.thread_id,
    subject: row.subject,
    snippet: row.snippet,
    sender: row.sender,
    sentAt: readInstant(row.effective_at ?? row.sent_at),
    fetchedBody: row.fetched_body,
    hasAttachments: row.has_attachments,
    unread: row.unread,
    flagged: row.flagged,
    activeOccurrences: row.occurrence_count,
    noServerCopy: row.occurrence_count === 0,
    sentCopyStatus: row.sent_copy_status,
    rank: row.search_rank,
    highlight: row.highlight,
    highlightSource: row.highlight_source,
  };
}

function toSavedSearchRecord(row: typeof savedSearches.$inferSelect): SavedSearchRecord {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    scope: row.scope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Query text as the box sent it, bounded in length. */
function readQueryText(query: string): string {
  if (typeof query !== "string") {
    throw new SearchError("invalid_request", "The query must be text.");
  }
  if (query.length > MAX_QUERY_CHARS) {
    throw new SearchError("invalid_request", `The query is longer than ${MAX_QUERY_CHARS} characters.`);
  }
  return query.trim();
}

/** Account chips: validated UUIDs, deduplicated, or `null` for every account. */
function readAccountFilters(accountIds: string[] | null | undefined): string[] | null {
  if (accountIds === null || accountIds === undefined) {
    return null;
  }
  if (accountIds.length === 0) {
    return null;
  }
  if (accountIds.length > MAX_ACCOUNT_FILTERS) {
    throw new SearchError("invalid_request", `At most ${MAX_ACCOUNT_FILTERS} account filters are allowed.`);
  }
  const unique: string[] = [];
  for (const id of accountIds) {
    if (!UUID_PATTERN.test(id)) {
      throw new SearchError("invalid_request", `Account filter must be a UUID: ${id}`);
    }
    if (!unique.includes(id)) {
      unique.push(id);
    }
  }
  return unique;
}

/** Domain chips: validated like `domain:` operator values. */
function readDomainFilters(domains: string[] | null | undefined): string[] {
  if (domains === null || domains === undefined) {
    return [];
  }
  if (domains.length > MAX_DOMAIN_FILTERS) {
    throw new SearchError("invalid_request", `At most ${MAX_DOMAIN_FILTERS} domain filters are allowed.`);
  }
  return domains.map((domain) => {
    try {
      return normalizeDomainValue(domain);
    } catch {
      throw new SearchError("invalid_request", `Invalid domain filter "${domain}".`);
    }
  });
}

function readFolderFilter(folderId: string | null | undefined): string | null {
  if (folderId === null || folderId === undefined || folderId === "") {
    return null;
  }
  if (!UUID_PATTERN.test(folderId)) {
    throw new SearchError("invalid_request", `Folder filter must be a UUID: ${folderId}`);
  }
  return folderId;
}

function readLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new SearchError("invalid_request", `Limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`);
  }
  return limit;
}

function readOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_SEARCH_OFFSET) {
    throw new SearchError("invalid_request", `Offset must be an integer between 0 and ${MAX_SEARCH_OFFSET}.`);
  }
  return offset;
}

function readSavedSearchName(name: string): string {
  if (typeof name !== "string") {
    throw new SearchError("invalid_request", "The saved-search name must be text.");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SAVED_SEARCH_NAME_CHARS) {
    throw new SearchError(
      "invalid_request",
      `The saved-search name must hold between 1 and ${MAX_SAVED_SEARCH_NAME_CHARS} characters.`,
    );
  }
  return trimmed;
}

/** A saved-search scope validated exactly like a live search's filters. */
function readSavedSearchScope(scope: SavedSearchScope | null | undefined): SavedSearchScope {
  if (scope === null || scope === undefined) {
    return {};
  }
  const clean: SavedSearchScope = {};
  if (scope.accountIds !== null && scope.accountIds !== undefined) {
    clean.accountIds = readAccountFilters(scope.accountIds) ?? undefined;
  }
  if (scope.folderId !== null && scope.folderId !== undefined) {
    clean.folderId = readFolderFilter(scope.folderId);
  }
  if (scope.domains !== null && scope.domains !== undefined) {
    clean.domains = readDomainFilters(scope.domains);
  }
  if (scope.localOnly === true) {
    clean.localOnly = true;
  }
  return clean;
}

/**
 * A timestamp as raw SQL returns it. Drizzle disables node-pg's parsers, so
 * `db.execute` hands timestamps back as text like `2026-08-15 09:00:00+00`.
 */
function readInstant(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** PostgreSQL rejects two saved searches with one name. Drizzle wraps the
 * driver error, so the chain is walked to the code. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (typeof current === "object" && current !== null) {
    if ("code" in current && (current as { code?: unknown }).code === "23505") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
