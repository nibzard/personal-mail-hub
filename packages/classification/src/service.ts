import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { MESSAGE_CLASSES, type HealthzClassification, type MessageClass, type SuggestionSource } from "@mail-hub/contracts";
import {
  actionItems,
  actions,
  bodies,
  decisions,
  events,
  messageOccurrences,
  messages,
  senderOverrides,
  type MailHubDatabase,
} from "@mail-hub/database";
import { HtmlSanitizer } from "@mail-hub/ingestion/sanitize";
import type { SettingsService } from "@mail-hub/settings";
import {
  JevAdapterError,
  QUESTION_SET_VERSION,
  type JevAdapter,
  type JevFailureKind,
} from "./adapter.ts";
import { minimizeMessageInput } from "./input.ts";
import { matchDeterministicRules } from "./rules.ts";

/**
 * Shadow-mode classification (SPEC F8).
 *
 * One pg-boss-driven pass per cycle walks the messages that still lack an
 * answer and applies the precedence chain, top wins:
 *
 * 1. A manual placement the owner made. Nothing is suggested on top of it.
 * 2. A sender override.
 * 3. Deterministic rules — regex and known-sender lists, no API call spent.
 * 4. Jev, for the residual, over minimized input only.
 *
 * Every answer is a visible suggestion. Nothing routes: mail moves only
 * through the action service. Guardrails are durable, so a restart changes
 * none of them: the circuit breaker and the cost cap read back from the
 * audit trail, and the decisions table keeps the raw answers the evaluation
 * gate (SPEC section 12) later measures.
 */

/**
 * The failure event the health report counts. The observability package
 * reads the same literal; both sides pin it because no shared module may
 * depend on the other's readers.
 */
export const CLASS_ERROR_EVENT = "class.error";

/** The session event that marks when classification was enabled or disabled. */
export const CLASS_SESSION_EVENT = "class.session";

/** Failures inside one burst window that trip the breaker. */
export const CIRCUIT_ERROR_THRESHOLD = 5;

/** The burst window that trips the breaker, in milliseconds. */
export const CIRCUIT_WINDOW_MS = 10 * 60_000;

/** How long a tripped breaker stays open after the burst that tripped it. */
export const CIRCUIT_COOLDOWN_MS = 30 * 60_000;

/** Billed input tokens one call is assumed to cost (SPEC section 13). */
export const ESTIMATED_INPUT_TOKENS_PER_CALL = 2_000;

/** The vendor-reported rate, in US dollars per million input tokens. */
export const PRICE_PER_MILLION_INPUT_TOKENS_USD = 0.042;

/** The estimated cost of one call, in US dollars. */
export const ESTIMATED_COST_PER_CALL_USD =
  (ESTIMATED_INPUT_TOKENS_PER_CALL * PRICE_PER_MILLION_INPUT_TOKENS_USD) / 1_000_000;

/** How many messages one cycle classifies, bounding a pass while mail flows. */
export const DEFAULT_CLASSIFY_BATCH_LIMIT = 25;

/** The settings surface the service reads. */
export type SettingsReader = Pick<SettingsService, "readSettings">;

/** What one classification cycle did. */
export interface ClassifyCycleSummary {
  /** Messages that received an answer, from any precedence level. */
  classified: number;
  /** Answers per precedence level. */
  bySource: Record<SuggestionSource, number>;
  /** Why the cycle classified nothing, when it did nothing. */
  skipped: CycleSkipReason | null;
  /** Adapter failures the cycle hit before it stopped. */
  errors: number;
}

/** Why a cycle paused or skipped its work. */
export type CycleSkipReason = "not_configured" | "disabled" | "circuit_open" | "cost_cap" | "no_candidates";

/** What classifying one message produced. */
export type ClassifyMessageOutcome =
  | { state: "classified"; source: SuggestionSource; classHint: MessageClass | null }
  | {
      state: "skipped";
      reason: "not_found" | "not_ready" | "already_classified" | "cost_cap" | "circuit_open";
    }
  | { state: "failed"; kind: JevFailureKind };

/** The circuit verdict the health report repeats. */
export type CircuitState = Pick<HealthzClassification, "circuit" | "description">;

/** The full assessment one pass over the guardrails produced. */
interface CircuitAssessment extends CircuitState {
  reason: "no_adapter" | "disabled" | "errors" | "cost_cap" | null;
}

export interface ClassificationServiceOptions {
  settings: SettingsReader;
  /** `null` leaves classification unconfigured; core mail never waits on it. */
  adapter: JevAdapter | null;
  /** Injectable clock, so tests can move the breaker windows. */
  now?: () => Date;
}

/** One candidate a cycle pulled from the pending set. */
interface CandidateRow {
  id: string;
  account_id: string;
  sender: unknown;
  subject: string | null;
  metadata: Record<string, unknown> | null;
}

/** The result of one sender-override lookup. */
type OverrideLookup = { recorded: boolean; classHint: MessageClass | null };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClassificationService {
  private readonly sanitizer = new HtmlSanitizer();

  constructor(
    private readonly db: MailHubDatabase,
    private readonly options: ClassificationServiceOptions,
  ) {}

  /**
   * The circuit verdict right now. Reads only durable state — the audit
   * trail, the decisions table, and settings — so it can never disagree
   * with what actually happened (SPEC section 11).
   */
  async readCircuit(): Promise<CircuitState> {
    const settings = await this.options.settings.readSettings();
    const assessment = await this.assessCircuit(settings);
    return { circuit: assessment.circuit, description: assessment.description };
  }

  /**
   * One bounded classification pass. Guardrails run first: a disabled or
   * unconfigured service, an open breaker, or a reached cost cap classifies
   * nothing. The pass stops at the first adapter failure so a broken
   * endpoint cannot burn a batch; the breaker opens from the recorded
   * failures on the next pass.
   */
  async runCycle(limit: number = DEFAULT_CLASSIFY_BATCH_LIMIT): Promise<ClassifyCycleSummary> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      limit = DEFAULT_CLASSIFY_BATCH_LIMIT;
    }
    const summary: ClassifyCycleSummary = {
      classified: 0,
      bySource: { manual: 0, override: 0, rule: 0, jev: 0 },
      skipped: null,
      errors: 0,
    };

    const settings = await this.options.settings.readSettings();
    if (!settings.classificationEnabled) {
      await this.recordSessionState(false);
      summary.skipped = "disabled";
      return summary;
    }
    if (this.options.adapter === null) {
      summary.skipped = "not_configured";
      return summary;
    }
    await this.recordSessionState(true);

    const assessment = await this.assessCircuit(settings);
    if (assessment.reason === "errors") {
      summary.skipped = "circuit_open";
      return summary;
    }

    let monthCalls = await this.countMonthCalls();
    if (assessment.reason === "cost_cap") {
      summary.skipped = "cost_cap";
      return summary;
    }

    const boundary = settings.backfillClassification ? null : await this.readEnabledBoundary();
    const candidates = await this.listCandidates(boundary, limit);
    if (candidates.length === 0) {
      summary.skipped = "no_candidates";
      return summary;
    }

    for (const candidate of candidates) {
      const outcome = await this.classifyRow(candidate, settings, monthCalls);
      if (outcome.state === "classified") {
        summary.classified += 1;
        summary.bySource[outcome.source] += 1;
        if (outcome.source === "jev") {
          monthCalls += 1;
        }
        continue;
      }
      if (outcome.state === "failed") {
        summary.errors += 1;
        return summary;
      }
      if (outcome.reason === "cost_cap") {
        summary.skipped = "cost_cap";
        return summary;
      }
    }
    return summary;
  }

  /**
   * Classify one message by identifier. The same precedence chain and
   * guardrails run as in the sweep — an open breaker pauses this path exactly
   * as it pauses the cycle — so the sweep and any future per-message queue
   * share this path.
   */
  async classifyMessage(messageId: string): Promise<ClassifyMessageOutcome> {
    requireUuid("message id", messageId);
    const settings = await this.options.settings.readSettings();
    if (!settings.classificationEnabled) {
      return { state: "skipped", reason: "not_ready" };
    }
    if (this.options.adapter === null) {
      return { state: "skipped", reason: "not_ready" };
    }
    const assessment = await this.assessCircuit(settings);
    if (assessment.reason === "errors") {
      return { state: "skipped", reason: "circuit_open" };
    }
    const rows = await this.db.execute(sql`
      select m.id, m.account_id, m.sender, m.subject, m.metadata,
             m.fetched_body, m.class_hint, a.classify_enabled
      from messages m
      join accounts a on a.id = m.account_id
      where m.id = ${messageId}
      limit 1
    `);
    const row = rows.rows[0];
    if (row === undefined) {
      return { state: "skipped", reason: "not_found" };
    }
    if (hasAnswer(row)) {
      return { state: "skipped", reason: "already_classified" };
    }
    if (row.classify_enabled !== true || !isFetched(row)) {
      return { state: "skipped", reason: "not_ready" };
    }
    const outcome = await this.classifyRow(toCandidate(row), settings, await this.countMonthCalls());
    if (outcome.state === "skipped" && outcome.reason === "cost_cap") {
      return outcome;
    }
    return outcome;
  }

  /** Precedence for one loaded candidate row. */
  private async classifyRow(
    candidate: CandidateRow,
    settings: Awaited<ReturnType<SettingsReader["readSettings"]>>,
    monthCalls: number,
  ): Promise<ClassifyMessageOutcome> {
    // Level 1: the owner placed this message by hand. Their placement is the
    // answer; no suggestion is layered on top of it and no call is spent.
    if (await this.hasManualPlacement(candidate.id)) {
      await this.applyAnswer(candidate, { source: "manual", classHint: null, patch: {} });
      return { state: "classified", source: "manual", classHint: null };
    }

    // Level 2: a sender override the owner recorded.
    const override = await this.loadSenderOverride(candidate.account_id, senderAddressOf(candidate.sender));
    if (override.recorded) {
      await this.applyAnswer(candidate, {
        source: "override",
        classHint: override.classHint,
        patch: {},
      });
      return { state: "classified", source: "override", classHint: override.classHint };
    }

    // Level 3: deterministic rules. No API call spent.
    const rule = matchDeterministicRules({
      senderAddress: senderAddressOf(candidate.sender),
      subject: candidate.subject,
    });
    if (rule !== null) {
      await this.applyAnswer(candidate, {
        source: "rule",
        classHint: rule.classHint,
        patch: { rule: rule.rule },
      });
      return { state: "classified", source: "rule", classHint: rule.classHint };
    }

    // Level 4: Jev, for the residual, behind both spend guardrails.
    const cap = settings.classificationMonthlyCostCapUsd;
    if (cap !== null && monthCalls * ESTIMATED_COST_PER_CALL_USD >= cap) {
      return { state: "skipped", reason: "cost_cap" };
    }
    const adapter = this.options.adapter;
    if (adapter === null) {
      return { state: "skipped", reason: "not_ready" };
    }
    const input = await this.buildInput(candidate.id, candidate.sender, candidate.subject);
    let decision;
    try {
      decision = await adapter.ask({ text: input.text });
    } catch (cause) {
      const kind = cause instanceof JevAdapterError ? cause.kind : "request_failed";
      await this.db.insert(events).values({
        actor: "system",
        type: CLASS_ERROR_EVENT,
        entityType: "message",
        entityId: candidate.id,
        payload: { accountId: candidate.account_id, kind },
      });
      return { state: "failed", kind };
    }

    await this.db.transaction(async (tx) => {
      await tx.insert(decisions).values({
        messageId: candidate.id,
        inputHash: input.inputHash,
        model: decision.model,
        questionSet: QUESTION_SET_VERSION,
        // Keyed by question id, so a stored row pairs with the question set
        // its version names and the evaluation gate can join them later.
        answers: {
          class_hint: decision.answers.classHint,
          sender_relationship: decision.answers.senderRelationship,
          asks_action: decision.answers.asksAction,
          asks_reply: decision.answers.asksReply,
          time_sensitive: decision.answers.timeSensitive,
        },
        confidence: {
          class_hint: decision.confidence.classHint,
          sender_relationship: decision.confidence.senderRelationship,
          asks_action: decision.confidence.asksAction,
          asks_reply: decision.confidence.asksReply,
          time_sensitive: decision.confidence.timeSensitive,
        },
        latencyMs: decision.latencyMs,
      });
      await tx
        .update(messages)
        .set({
          classHint: decision.answers.classHint,
          asksAction: decision.answers.asksAction,
          asksReply: decision.answers.asksReply,
          timeSensitive: decision.answers.timeSensitive,
          metadata: mergeMetadata(candidate.metadata, {
            classSource: "jev",
            senderRelationship: decision.answers.senderRelationship,
          }),
        })
        .where(eq(messages.id, candidate.id));
    });
    return { state: "classified", source: "jev", classHint: decision.answers.classHint };
  }

  /**
   * Record one non-Jev answer: the denormalized hint plus the metadata that
   * marks the message answered, so the sweep stops offering it.
   */
  private async applyAnswer(
    candidate: CandidateRow,
    answer: { source: SuggestionSource; classHint: MessageClass | null; patch: Record<string, unknown> },
  ): Promise<void> {
    await this.db
      .update(messages)
      .set({
        ...(answer.classHint === null ? {} : { classHint: answer.classHint }),
        metadata: mergeMetadata(candidate.metadata, { classSource: answer.source, ...answer.patch }),
      })
      .where(eq(messages.id, candidate.id));
  }

  /** The minimized input for one message, from its stored derivatives only. */
  private async buildInput(
    messageId: string,
    sender: unknown,
    subject: string | null,
  ): Promise<{ text: string; inputHash: string; truncated: boolean }> {
    const rows = await this.db
      .select({ textPlain: bodies.textPlain, htmlSanitized: bodies.htmlSanitized })
      .from(bodies)
      .where(eq(bodies.messageId, messageId))
      .limit(1);
    const body = rows[0];
    const bodyText =
      body?.textPlain !== null && body?.textPlain !== undefined
        ? body.textPlain
        : body?.htmlSanitized !== null && body?.htmlSanitized !== undefined
          ? this.sanitizer.htmlToText(body.htmlSanitized)
          : null;
    const address = senderAddressOf(sender);
    const senderText =
      address === null
        ? ""
        : senderNameOf(sender) === null
          ? address
          : `${senderNameOf(sender)} <${address}>`;
    return minimizeMessageInput({ senderText, subject, bodyText });
  }

  /** True when the owner moved or archived an occurrence of this message. */
  private async hasManualPlacement(messageId: string): Promise<boolean> {
    const rows = await this.db
      .select({ exists: sql<number>`1` })
      .from(actionItems)
      .innerJoin(actions, eq(actions.id, actionItems.actionId))
      .innerJoin(
        messageOccurrences,
        sql`${messageOccurrences.id} = (${actionItems.target} ->> 'occurrenceId')::uuid`,
      )
      .where(
        and(
          eq(messageOccurrences.messageId, messageId),
          inArray(actions.kind, ["move", "archive"]),
          eq(actionItems.status, "confirmed"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The owner's class override for one sender, when one is recorded. */
  private async loadSenderOverride(
    accountId: string,
    senderAddress: string | null,
  ): Promise<OverrideLookup> {
    if (senderAddress === null) {
      return { recorded: false, classHint: null };
    }
    const rows = await this.db
      .select({ classHint: senderOverrides.classHint })
      .from(senderOverrides)
      .where(
        and(
          eq(senderOverrides.accountId, accountId),
          sql`lower(${senderOverrides.sender}) = ${senderAddress.toLowerCase()}`,
        ),
      )
      // The row carries no timestamp, so the newest write is named another
      // way: the lowercase-canonical row is the only one the correction
      // upsert maintains, so every variant row beside it is older and must
      // not shadow it. Two stale variants cannot both be canonical; the
      // sender tiebreak keeps that pick stable instead of unspecified.
      .orderBy(
        desc(sql`${senderOverrides.sender} = lower(${senderOverrides.sender})`),
        senderOverrides.sender,
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return { recorded: false, classHint: null };
    }
    // A recorded override with no class is an explicit "leave this sender
    // alone"; it still wins over Jev and still spends no call.
    return {
      recorded: true,
      classHint: typeof row.classHint === "string" && (MESSAGE_CLASSES as readonly string[]).includes(row.classHint)
        ? (row.classHint as MessageClass)
        : null,
    };
  }

  /** Messages that still lack an answer, newest first, bounded by `limit`. */
  private async listCandidates(boundary: Date | null, limit: number): Promise<CandidateRow[]> {
    const result = await this.db.execute(sql`
      select m.id, m.account_id, m.sender, m.subject, m.metadata
      from messages m
      join accounts a on a.id = m.account_id
      where m.fetched_body
        and a.classify_enabled
        and m.class_hint is null
        and m.metadata ->> 'classSource' is null
        and not exists (select 1 from decisions d where d.message_id = m.id)
        ${
          boundary === null
            ? sql``
            : sql`and exists (
                 select 1 from events e
                 where e.type = 'message.ingested' and e.entity_id = m.id and e.at > ${boundary}
               )`
        }
      order by m.sent_at desc nulls last, m.id
      limit ${limit}
    `);
    return result.rows.map((row) => toCandidate(row));
  }

  /**
   * Keep the enabled session marker honest. The newest `class.session` event
   * is the boundary the backfill gate reads, so an enabled marker is written
   * only when none stands, and a disabled one only when it closes a session.
   */
  private async recordSessionState(enabled: boolean): Promise<void> {
    const rows = await this.db.execute(sql`
      select payload ->> 'state' as state
      from events
      where type = ${CLASS_SESSION_EVENT}
      order by at desc
      limit 1
    `);
    const recorded = typeof rows.rows[0]?.state === "string" ? (rows.rows[0].state as string) : null;
    if (enabled ? recorded === "enabled" : recorded !== "enabled") {
      return;
    }
    await this.db.insert(events).values({
      actor: "system",
      type: CLASS_SESSION_EVENT,
      payload: { state: enabled ? "enabled" : "disabled" },
    });
  }

  /** When classification was last enabled; the backfill gate's boundary. */
  private async readEnabledBoundary(): Promise<Date | null> {
    const rows = await this.db.execute(sql`
      select at
      from events
      where type = ${CLASS_SESSION_EVENT} and payload ->> 'state' = 'enabled'
      order by at desc
      limit 1
    `);
    const at = rows.rows[0]?.at;
    return timestampOf(at);
  }

  /** Recorded Jev calls since the month began, UTC. */
  private async countMonthCalls(): Promise<number> {
    const now = this.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(decisions)
      .where(gte(decisions.createdAt, monthStart));
    return rows[0]?.count ?? 0;
  }

  /** Both spend guardrails and the breaker, from durable records only. */
  private async assessCircuit(
    settings: Awaited<ReturnType<SettingsReader["readSettings"]>>,
  ): Promise<CircuitAssessment> {
    if (this.options.adapter === null) {
      return {
        circuit: "not_configured",
        reason: "no_adapter",
        description:
          "Jev classification is not configured. Set TYPE_SAFE_API_KEY to enable it; calls and errors count recorded decisions and failures.",
      };
    }
    if (!settings.classificationEnabled) {
      return {
        circuit: "not_configured",
        reason: "disabled",
        description: "Classification is disabled in settings, so no message is sent for evaluation.",
      };
    }

    const now = this.now();
    // Failures stay readable for the whole cooldown, not just the burst
    // window: a burst that tripped the breaker must keep it open until the
    // cooldown ends, instead of letting the count decay close it early.
    const since = new Date(now.getTime() - CIRCUIT_COOLDOWN_MS);
    const errorRows = await this.db.execute(sql`
      select at
      from events
      where type = ${CLASS_ERROR_EVENT} and at > ${since}
      order by at asc
    `);
    const failureTimes = errorRows.rows.flatMap((row) => {
      const at = timestampOf(row.at);
      return at === null ? [] : [at.getTime()];
    });
    const burst = widestBurstSize(failureTimes, CIRCUIT_WINDOW_MS);
    if (burst >= CIRCUIT_ERROR_THRESHOLD) {
      return {
        circuit: "open",
        reason: "errors",
        description: `Classification is paused: ${burst} evaluation failures within a ${
          CIRCUIT_WINDOW_MS / 60_000
        }-minute window. It resumes ${CIRCUIT_COOLDOWN_MS / 60_000} minutes after the newest counted failure.`,
      };
    }

    const cap = settings.classificationMonthlyCostCapUsd;
    if (cap !== null) {
      const monthCalls = await this.countMonthCalls();
      const spend = roundCents(monthCalls * ESTIMATED_COST_PER_CALL_USD);
      if (spend >= cap) {
        return {
          circuit: "open",
          reason: "cost_cap",
          description: `Classification is paused: the estimated monthly spend of ${spend} US dollars reached the ${cap} US dollar cap.`,
        };
      }
    }
    return {
      circuit: "closed",
      reason: null,
      description:
        "Jev classification is running in shadow mode. Suggestions are visible and never route mail.",
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** Normalize one raw candidate row from either query shape. */
function toCandidate(row: Record<string, unknown>): CandidateRow {
  const metadata = row.metadata;
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    sender: row.sender ?? null,
    subject: typeof row.subject === "string" ? row.subject : null,
    metadata: metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>) : null,
  };
}

/** The fetched flag of one raw row, as the candidate query reports it. */
function isFetched(row: Record<string, unknown>): boolean {
  return row.fetched_body === true;
}

/** True when one raw row already carries an answer of any level. */
function hasAnswer(row: Record<string, unknown>): boolean {
  const metadata = row.metadata;
  const classSource =
    metadata !== null && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).classSource
      : undefined;
  return row.class_hint !== null || classSource !== undefined;
}

/** The address of one stored sender, or `null` when unusable. */
export function senderAddressOf(sender: unknown): string | null {
  if (sender === null || typeof sender !== "object") {
    return null;
  }
  const address = (sender as { address?: unknown }).address;
  return typeof address === "string" && address.length > 0 ? address : null;
}

/** The display name of one stored sender, or `null` when absent. */
function senderNameOf(sender: unknown): string | null {
  if (sender === null || typeof sender !== "object") {
    return null;
  }
  const name = (sender as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Merge one metadata patch without touching keys it does not name. */
function mergeMetadata(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(current ?? {}), ...patch };
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The most failures one `windowMs` span of the ascending times holds. The
 * breaker trips on a burst anywhere inside the cooldown, so a burst that has
 * already aged past the window still holds the breaker open until the
 * cooldown expires.
 */
function widestBurstSize(times: number[], windowMs: number): number {
  let widest = 0;
  let first = 0;
  for (let last = 0; last < times.length; last += 1) {
    while (times[last]! - times[first]! > windowMs) {
      first += 1;
    }
    widest = Math.max(widest, last - first + 1);
  }
  return widest;
}

/**
 * One raw timestamp column. A raw `execute` reports timestamps as strings
 * while a mapped select reports `Date` objects; both shapes parse here so
 * neither caller depends on the driver's choice. The string form needs two
 * repairs before JavaScript accepts it: the fraction trims from
 * microseconds to milliseconds, and an offset without minutes gains them.
 */
function timestampOf(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const normalized = value
      .replace(" ", "T")
      .replace(/(\.\d{3})\d+/, "$1")
      .replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new RangeError(`${kind} must be a UUID: ${id}`);
  }
}
