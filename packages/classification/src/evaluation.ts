import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  MESSAGE_CLASSES,
  type MessageClass,
  type SuggestionSource,
} from "@mail-hub/contracts";
import { decisions, events, messages, type MailHubDatabase } from "@mail-hub/database";
import type { MutationGate } from "@mail-hub/recovery";
import { CLASS_CORRECTED_EVENT } from "./corrections.ts";
import { ClassificationError } from "./errors.ts";
import { senderAddressOf } from "./service.ts";

/**
 * The evaluation gate (SPEC section 12) and the routing verdict it owns.
 *
 * The owner hand-labels a sample of their own mail — 100 to 200 messages,
 * including forwarded chains, bilingual mail, and mixed receipt-plus-question
 * mail — and runs `npm run eval:classify` against the stored answers. The
 * command measures three things:
 *
 * - Critical false negatives: personal or action mail that routing would
 *   bundle into Reading or Notifications. The classes that bundle are the
 *   ones SPEC F8 names, and the breakout rule still applies: a
 *   `security_alert`, or an `asks_action` Jev reported with high
 *   confidence, exits any bundle.
 * - Coverage: the share of the labeled set that carries an answer.
 * - Correction rate per sender: `class.corrected` events grouped by the
 *   sender they named, over that sender's labeled mail.
 *
 * Routing may be enabled only when the labeled set holds at least the
 * 100-message minimum and zero critical false negatives. Until then
 * classification stays in shadow mode, and any later evaluation that fails
 * returns it there: the newest `class.gate` event is the verdict, read from
 * durable records only, so a restart never changes it.
 */

/** The audit event one evaluation run records; the routing verdict it carries. */
export const CLASS_GATE_EVENT = "class.gate";

/**
 * The smallest labeled set that may enable routing (SPEC section 12,
 * step 1: hand-label 100–200 messages).
 */
export const MINIMUM_LABELED_MESSAGES = 100;

/**
 * The `asks_action` confidence at or above which a bundled message breaks
 * out (SPEC F8 guardrails). The model is pinned so the threshold keeps its
 * meaning; change them only together.
 */
export const ASKS_ACTION_BREAKOUT_CONFIDENCE = 0.75;

/** The classes routing would bundle into Reading (SPEC F8). */
const READING_BUNDLE_CLASSES: ReadonlySet<string> = new Set(["newsletter", "marketing"]);

/** The classes routing would bundle into the Notifications strip (SPEC F8). */
const NOTIFICATION_BUNDLE_CLASSES: ReadonlySet<string> = new Set(["notification"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUGGESTION_SOURCES: readonly SuggestionSource[] = ["manual", "override", "rule", "jev"];

/** One hand label: the truth for a message the owner read themselves. */
export interface ClassificationLabel {
  messageId: string;
  /** The class the message truly is, in the owner's judgment. */
  classHint: MessageClass;
  /** Whether the message truly asks the owner to act, when judged. */
  asksAction?: boolean;
}

/** One critical false negative the evaluation found. */
export interface CriticalFalseNegative {
  messageId: string;
  sender: string | null;
  labeledClassHint: MessageClass;
  labeledAsksAction: boolean;
  suggestedClassHint: MessageClass;
  source: SuggestionSource | null;
}

/** The correction rate of one sender's labeled mail. */
export interface SenderCorrectionRate {
  sender: string;
  labeled: number;
  answered: number;
  corrections: number;
  rate: number;
}

/** The full measurement over one labeled set. */
export interface ClassificationEvaluation {
  labeled: number;
  answered: number;
  /** The share of the labeled set that carries an answer, in [0, 1]. */
  coverage: number;
  /** Answered labeled mail per precedence level. */
  bySource: Record<SuggestionSource, number>;
  criticalFalseNegatives: CriticalFalseNegative[];
  /** Per sender, over the labeled set, sorted by corrections descending. */
  senders: SenderCorrectionRate[];
  /** The routing verdict this evaluation produces. */
  gate: RoutingGateVerdict;
}

/** The verdict one evaluation produces, and the state it leaves behind. */
export interface RoutingGateVerdict {
  /** True only when routing may run: minimum met and zero critical misses. */
  passed: boolean;
  /** True after the verdict is recorded and routing is enabled by it. */
  routingEnabled: boolean;
  /** One sentence a person can act on. */
  description: string;
}

/** The routing state durable records establish right now. */
export interface RoutingGateState extends RoutingGateVerdict {
  /** When the newest evaluation ran, or `null` before any has. */
  evaluatedAt: Date | null;
  /** The counts behind the newest verdict, or `null` before any has. */
  counts: { labeled: number; answered: number; criticalFalseNegatives: number } | null;
}

/** The answer one labeled message carries, joined from the database. */
interface LabeledRow {
  id: string;
  sender: unknown;
  class_hint: string | null;
  asks_action: boolean | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Parse a label file: one JSON object per line, blank lines and `#`
 * comments allowed. Every line must name a message, a true class, and
 * optionally the true action answer; nothing else, so a typo fails the run
 * instead of silently shrinking the set.
 */
export function parseClassificationLabels(text: string): ClassificationLabel[] {
  const labels: ClassificationLabel[] = [];
  const errors: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`line ${lineNumber}: not valid JSON.`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`line ${lineNumber}: each line must be one JSON object.`);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const known = new Set(["messageId", "class", "asksAction"]);
    const unknownKeys = Object.keys(record).filter((key) => !known.has(key));
    if (unknownKeys.length > 0) {
      errors.push(`line ${lineNumber}: unknown key ${unknownKeys[0]}.`);
      continue;
    }
    if (typeof record.messageId !== "string" || !UUID_PATTERN.test(record.messageId)) {
      errors.push(`line ${lineNumber}: messageId must be a UUID.`);
      continue;
    }
    if (typeof record.class !== "string" || !(MESSAGE_CLASSES as readonly string[]).includes(record.class)) {
      errors.push(`line ${lineNumber}: class must be one of the message classes.`);
      continue;
    }
    if (record.asksAction !== undefined && typeof record.asksAction !== "boolean") {
      errors.push(`line ${lineNumber}: asksAction must be true or false.`);
      continue;
    }
    labels.push({
      messageId: record.messageId,
      classHint: record.class as MessageClass,
      ...(record.asksAction === undefined ? {} : { asksAction: record.asksAction }),
    });
  }
  if (errors.length > 0) {
    throw new ClassificationError(
      "invalid_request",
      `The label file is unusable: ${errors.slice(0, 5).join(" ")}${errors.length > 5 ? ` (${errors.length - 5} more)` : ""}`,
    );
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.messageId)) {
      throw new ClassificationError(
        "invalid_request",
        `The label file labels message ${label.messageId} more than once.`,
      );
    }
    seen.add(label.messageId);
  }
  return labels;
}

/**
 * Measure one labeled set against the stored answers. Every label must name
 * a stored message; a label for mail that no longer exists fails the run,
 * because a shrinking set would quietly loosen the gate.
 */
export async function evaluateClassification(
  db: MailHubDatabase,
  labels: ClassificationLabel[],
): Promise<ClassificationEvaluation> {
  if (labels.length === 0) {
    throw new ClassificationError("invalid_request", "The labeled set is empty.");
  }
  const rows = await db
    .select({
      id: messages.id,
      sender: messages.sender,
      class_hint: messages.classHint,
      asks_action: messages.asksAction,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(inArray(messages.id, labels.map((label) => label.messageId)));
  const labeledRows = new Map<string, LabeledRow>();
  for (const row of rows) {
    labeledRows.set(
      row.id,
      {
        id: row.id,
        sender: row.sender,
        class_hint: row.class_hint,
        asks_action: row.asks_action,
        metadata: row.metadata,
      },
    );
  }
  const missing = labels.filter((label) => !labeledRows.has(label.messageId));
  if (missing.length > 0) {
    throw new ClassificationError(
      "invalid_request",
      `${missing.length} label(s) name messages that are not stored, for example ${missing[0]!.messageId}.`,
    );
  }

  const confidences = await readAsksActionConfidences(db, labels.map((label) => label.messageId));

  const bySource: Record<SuggestionSource, number> = { manual: 0, override: 0, rule: 0, jev: 0 };
  let answered = 0;
  const criticalFalseNegatives: CriticalFalseNegative[] = [];
  const perSender = new Map<string, { labeled: number; answered: number }>();
  for (const label of labels) {
    const row = labeledRows.get(label.messageId)!;
    const sender = senderAddressOf(row.sender);
    const senderKey = sender === null ? "" : sender.toLowerCase();
    const counts = perSender.get(senderKey) ?? { labeled: 0, answered: 0 };
    counts.labeled += 1;
    perSender.set(senderKey, counts);

    const source = sourceOf(row);
    const hasAnswer = row.class_hint !== null || source !== null;
    if (!hasAnswer) {
      continue;
    }
    answered += 1;
    counts.answered += 1;
    if (source !== null) {
      bySource[source] += 1;
    }

    // Routing would bundle only the classes SPEC F8 names, and the breakout
    // rule still applies inside the model: a security alert, or an action
    // Jev flagged with high confidence, exits any bundle.
    const suggested =
      row.class_hint !== null && (MESSAGE_CLASSES as readonly string[]).includes(row.class_hint)
        ? (row.class_hint as MessageClass)
        : null;
    const bundled =
      suggested !== null &&
      (READING_BUNDLE_CLASSES.has(suggested) || NOTIFICATION_BUNDLE_CLASSES.has(suggested));
    const brokeOut =
      suggested === "security_alert" ||
      (row.asks_action === true &&
        (confidences.get(row.id) ?? 0) >= ASKS_ACTION_BREAKOUT_CONFIDENCE);
    const critical = label.classHint === "correspondence" || label.asksAction === true;
    if (critical && bundled && !brokeOut && suggested !== null) {
      criticalFalseNegatives.push({
        messageId: row.id,
        sender,
        labeledClassHint: label.classHint,
        labeledAsksAction: label.asksAction === true,
        suggestedClassHint: suggested,
        source,
      });
    }
  }

  const corrections = await readCorrectionsPerSender(db);
  const senders: SenderCorrectionRate[] = [...perSender.entries()]
    .map(([senderKey, counts]) => {
      const correctionsForSender = corrections.get(senderKey) ?? 0;
      return {
        sender: senderKey,
        labeled: counts.labeled,
        answered: counts.answered,
        corrections: correctionsForSender,
        rate: counts.labeled === 0 ? 0 : correctionsForSender / counts.labeled,
      };
    })
    .sort((a, b) => b.corrections - a.corrections || a.sender.localeCompare(b.sender));

  return {
    labeled: labels.length,
    answered,
    coverage: answered / labels.length,
    bySource,
    criticalFalseNegatives,
    senders,
    gate: gateVerdict(labels.length, criticalFalseNegatives.length),
  };
}

/**
 * Record one evaluation's verdict durably. The recovery gate runs first
 * (SPEC section 7, step 1); the newest `class.gate` event then decides
 * whether routing is enabled, so a failing run returns it to shadow mode.
 */
export async function recordClassificationGate(
  db: MailHubDatabase,
  gate: MutationGate,
  requestGeneration: string | null | undefined,
  evaluation: ClassificationEvaluation,
): Promise<RoutingGateVerdict> {
  await gate.gateMutation(requestGeneration);
  await db.insert(events).values({
    actor: "system",
    type: CLASS_GATE_EVENT,
    payload: {
      labeled: evaluation.labeled,
      answered: evaluation.answered,
      coverage: round(evaluation.coverage),
      criticalFalseNegatives: evaluation.criticalFalseNegatives.length,
      passed: evaluation.gate.passed,
      routing: evaluation.gate.passed ? "enabled" : "shadow",
    },
  });
  return evaluation.gate;
}

/**
 * The routing state durable records establish: the newest `class.gate`
 * event's verdict, or shadow mode before any evaluation has run.
 */
export async function readRoutingState(db: MailHubDatabase): Promise<RoutingGateState> {
  const rows = await db
    .select({ at: events.at, payload: events.payload })
    .from(events)
    .where(eq(events.type, CLASS_GATE_EVENT))
    .orderBy(desc(events.at), desc(events.id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return {
      ...gateVerdict(0, 0),
      routingEnabled: false,
      description:
        "No evaluation has run yet, so classification stays in shadow mode. Run npm run eval:classify against a labeled set.",
      evaluatedAt: null,
      counts: null,
    };
  }
  const payload = row.payload;
  const passed = payload.passed === true;
  const labeled = wholeNumber(payload.labeled) ?? 0;
  const answered = wholeNumber(payload.answered) ?? 0;
  const misses = wholeNumber(payload.criticalFalseNegatives) ?? 0;
  return {
    passed,
    routingEnabled: passed,
    description: passed
      ? `Routing is enabled by the newest evaluation: zero critical false negatives over ${labeled} labeled messages.`
      : `Routing stays off by the newest evaluation: ${misses} critical false negative(s) over ${labeled} labeled messages.`,
    evaluatedAt: row.at,
    counts: { labeled, answered, criticalFalseNegatives: misses },
  };
}

/** The verdict one measurement produces, before it is recorded. */
function gateVerdict(labeled: number, criticalFalseNegatives: number): RoutingGateVerdict {
  if (criticalFalseNegatives > 0) {
    const below =
      labeled < MINIMUM_LABELED_MESSAGES
        ? ` The labeled set also holds fewer than the ${MINIMUM_LABELED_MESSAGES} the gate requires.`
        : "";
    return {
      passed: false,
      routingEnabled: false,
      description:
        `Routing stays off: ${criticalFalseNegatives} critical false negative(s) in the labeled set.${below}`,
    };
  }
  if (labeled < MINIMUM_LABELED_MESSAGES) {
    return {
      passed: false,
      routingEnabled: false,
      description:
        `Routing stays off: the labeled set holds ${labeled} message(s), below the ${MINIMUM_LABELED_MESSAGES} the gate requires.`,
    };
  }
  return {
    passed: true,
    routingEnabled: true,
    description:
      `Routing may be enabled: zero critical false negatives over ${labeled} labeled messages.`,
  };
}

/** Which precedence level answered one row, when one did. */
function sourceOf(row: LabeledRow): SuggestionSource | null {
  const source = row.metadata?.classSource;
  return typeof source === "string" && (SUGGESTION_SOURCES as readonly string[]).includes(source)
    ? (source as SuggestionSource)
    : null;
}

/** The newest `asks_action` confidence per message id, when Jev reported one. */
async function readAsksActionConfidences(
  db: MailHubDatabase,
  messageIds: string[],
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      messageId: decisions.messageId,
      asksAction: sql<number | null>`${decisions.confidence} -> 'asks_action'`,
      createdAt: decisions.createdAt,
    })
    .from(decisions)
    .where(inArray(decisions.messageId, messageIds))
    .orderBy(desc(decisions.createdAt));
  const confidences = new Map<string, number>();
  for (const row of rows) {
    if (!confidences.has(row.messageId) && typeof row.asksAction === "number" && Number.isFinite(row.asksAction)) {
      confidences.set(row.messageId, row.asksAction);
    }
  }
  return confidences;
}

/** Correction events per sender address, lowercased. */
async function readCorrectionsPerSender(db: MailHubDatabase): Promise<Map<string, number>> {
  const result = await db.execute(sql`
    select lower(payload ->> 'sender') as sender, count(*)::int as count
    from events
    where type = ${CLASS_CORRECTED_EVENT} and payload ->> 'sender' is not null
    group by 1
  `);
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const sender = (row as { sender?: unknown }).sender;
    const count = wholeNumber((row as { count?: unknown }).count);
    if (typeof sender === "string" && sender.length > 0 && count !== null) {
      counts.set(sender, count);
    }
  }
  return counts;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
