import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MessageClass, SuggestionSource } from "@mail-hub/contracts";
import {
  folders,
  homeDismissals,
  messageOccurrences,
  messages,
  type MailHubDatabase,
} from "@mail-hub/database";
import { HomeError } from "./errors.ts";
import type { HomeService } from "./service.ts";

/**
 * The Home selection evaluation (SPEC F13, plan step 7): a measurement of
 * what the overview surfaces, separate from the routing gate. A passed
 * routing gate says nothing about Home, and this evaluation records no
 * verdict and touches no owner data: it opens one throwaway visit under
 * its own device id, so the reads behave as a fresh device. Home stays
 * advisory, and the owner reads these numbers before trusting the screen.
 *
 * The owner hand-labels mail they read themselves — one JSON object per
 * line, `messageId`, `class`, and any of `asksAction`, `asksReply`, and
 * `timeSensitive` — and runs `npm run eval:home -- --labels <file.jsonl>`.
 * The command walks the real Home answer the way the client does: pages of
 * eight, following cursors, so a row that ranks beyond the first page must
 * still be found. It then measures four things:
 *
 * - Important coverage: labeled important mail with a stored answer that
 *   the attention sections hold. An absence the owner chose (a dismissal)
 *   or the scope excludes (mail outside the inbox) is reported, not failed.
 * - Important mail with no stored answer: the honest blind spot. Home
 *   makes no model call, so it cannot find these; the coverage line on the
 *   screen exists for exactly this gap.
 * - Irrelevant suggestions: labeled routine mail the attention sections
 *   suggest. Every one is a defect.
 * - Ranking beyond page limits: important rows found on a later page than
 *   the first, which the paged walk must still reach.
 */

/** The routine classes automatic suggestions must never rest on. */
const ROUTINE_CLASSES: ReadonlySet<string> = new Set([
  "newsletter",
  "marketing",
  "notification",
  "bounce",
]);

/** The classes the label file accepts. */
const CLASSES: readonly string[] = [
  "correspondence",
  "receipt",
  "newsletter",
  "notification",
  "marketing",
  "security_alert",
  "bounce",
  "other",
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One hand label: the truth for a message the owner read themselves. */
export interface HomeLabel {
  messageId: string;
  /** The class the message truly is, in the owner's judgment. */
  classHint: MessageClass;
  asksAction?: boolean;
  asksReply?: boolean;
  timeSensitive?: boolean;
}

/** One important message the attention sections did not hold. */
export interface HomeAttentionMiss {
  messageId: string;
  sender: string | null;
  labeled: { classHint: MessageClass; asksAction: boolean; asksReply: boolean; timeSensitive: boolean };
  stored: {
    classHint: string | null;
    asksAction: boolean | null;
    asksReply: boolean | null;
    timeSensitive: boolean | null;
  };
  /**
   * `dismissed` and `outside_inbox` are absences the owner or the scope
   * chose; `no_attention_signal` is unexplained and fails the evaluation.
   */
  status: "dismissed" | "outside_inbox" | "no_attention_signal";
}

/** One routine message the attention sections suggested anyway. */
export interface HomeRoutineSuggestion {
  messageId: string;
  sender: string | null;
  labeledClassHint: MessageClass;
  storedClassHint: string | null;
  reasonCodes: string[];
}

/** Important labeled mail no stored answer covers. */
export interface HomeUnansweredImportant {
  messageId: string;
  sender: string | null;
}

/** The full measurement over one labeled set. */
export interface HomeEvaluation {
  labeled: number;
  /** Labeled mail any stored answer covers. */
  answered: number;
  importantLabeled: number;
  importantAnswered: number;
  /** Important answered mail the attention sections held, any page. */
  importantPresent: number;
  /** Of those, the rows only a later page held. */
  importantBeyondFirstPage: number;
  attentionMisses: HomeAttentionMiss[];
  /** Important labeled mail with no stored answer: the blind spot. */
  importantUnanswered: HomeUnansweredImportant[];
  routineSuggestions: HomeRoutineSuggestion[];
  /** Conversation rows the paged walk collected across the attention sections. */
  attentionRows: number;
  /** The page size the walk used; the client's default. */
  pageLimit: number;
  /** True when nothing unexplained is missing and nothing routine was suggested. */
  passed: boolean;
}

/**
 * Parse a Home label file: one JSON object per line, blank lines and `#`
 * comments allowed. A typo fails the run instead of silently shrinking the
 * set, the same contract the classification labels hold.
 */
export function parseHomeLabels(text: string): HomeLabel[] {
  const labels: HomeLabel[] = [];
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
    const known = new Set(["messageId", "class", "asksAction", "asksReply", "timeSensitive"]);
    const unknownKeys = Object.keys(record).filter((key) => !known.has(key));
    if (unknownKeys.length > 0) {
      errors.push(`line ${lineNumber}: unknown key ${unknownKeys[0]}.`);
      continue;
    }
    if (typeof record.messageId !== "string" || !UUID_PATTERN.test(record.messageId)) {
      errors.push(`line ${lineNumber}: messageId must be a UUID.`);
      continue;
    }
    if (typeof record.class !== "string" || !CLASSES.includes(record.class)) {
      errors.push(`line ${lineNumber}: class must be one of the message classes.`);
      continue;
    }
    let flagsBroken = false;
    for (const key of ["asksAction", "asksReply", "timeSensitive"] as const) {
      if (record[key] !== undefined && typeof record[key] !== "boolean") {
        errors.push(`line ${lineNumber}: ${key} must be true or false.`);
        flagsBroken = true;
      }
    }
    if (flagsBroken) {
      continue;
    }
    const label: HomeLabel = {
      messageId: record.messageId,
      classHint: record.class as MessageClass,
    };
    if (typeof record.asksAction === "boolean") {
      label.asksAction = record.asksAction;
    }
    if (typeof record.asksReply === "boolean") {
      label.asksReply = record.asksReply;
    }
    if (typeof record.timeSensitive === "boolean") {
      label.timeSensitive = record.timeSensitive;
    }
    labels.push(label);
  }
  if (errors.length > 0) {
    throw new HomeError(
      "invalid_request",
      `The label file is unusable: ${errors.slice(0, 5).join(" ")}${errors.length > 5 ? ` (${errors.length - 5} more)` : ""}`,
    );
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.messageId)) {
      throw new HomeError(
        "invalid_request",
        `The label file labels message ${label.messageId} more than once.`,
      );
    }
    seen.add(label.messageId);
  }
  if (labels.length === 0) {
    throw new HomeError("invalid_request", "The labeled set is empty.");
  }
  return labels;
}

/**
 * Measure one labeled set against the Home answer the service builds right
 * now. Every label must name a stored message, the same no-shrinking
 * contract the classification evaluation holds.
 */
export async function evaluateHome(
  db: MailHubDatabase,
  service: HomeService,
  labels: HomeLabel[],
): Promise<HomeEvaluation> {
  if (labels.length === 0) {
    throw new HomeError("invalid_request", "The labeled set is empty.");
  }

  const ids = labels.map((label) => label.messageId);
  const rows = await db
    .select({
      id: messages.id,
      sender: messages.sender,
      classHint: messages.classHint,
      asksAction: messages.asksAction,
      asksReply: messages.asksReply,
      timeSensitive: messages.timeSensitive,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(inArray(messages.id, ids));
  const stored = new Map(rows.map((row) => [row.id, row]));
  const missing = labels.filter((label) => !stored.has(label.messageId));
  if (missing.length > 0) {
    throw new HomeError(
      "invalid_request",
      `${missing.length} label(s) name messages that are not stored, for example ${missing[0]!.messageId}.`,
    );
  }

  // Walk the attention sections the way the client reads them: the first
  // answer, then cursor pages, so rows beyond the first page must surface.
  const pageLimit = 8;
  const deviceId = `home-eval-${randomUUID()}`;
  const first = await service.readHome({ deviceId, limit: pageLimit });
  const attentionSections = ["due_now", "needs_attention", "reply_later"] as const;
  type WalkedRow = { messageIds: string[]; reasons: Array<{ code: string; origin: string }>; page: number };
  const walked = new Map<string, WalkedRow>();
  for (const section of attentionSections) {
    let page = first.sections.find((entry) => entry.id === section) ?? null;
    let pageIndex = 1;
    while (page !== null && page.items.length > 0) {
      for (const item of page.items) {
        for (const messageId of item.messageIds) {
          const existing = walked.get(messageId);
          if (existing === undefined || existing.page > pageIndex) {
            walked.set(messageId, { messageIds: item.messageIds, reasons: item.reasons, page: pageIndex });
          }
        }
      }
      if (page.nextCursor === null) {
        break;
      }
      pageIndex += 1;
      page = await service.readSection({ section, cursor: page.nextCursor, limit: pageLimit, deviceId });
    }
  }

  // The absences an owner or the scope explains: dismissals, and mail whose
  // occurrences never sit in an inbox folder.
  const dismissedRows = await db
    .select({ messageId: homeDismissals.messageId })
    .from(homeDismissals)
    .where(inArray(homeDismissals.messageId, ids));
  const dismissed = new Set(dismissedRows.map((row) => row.messageId));
  const occurrenceRows = await db
    .select({ messageId: messageOccurrences.messageId, role: folders.role })
    .from(messageOccurrences)
    .innerJoin(folders, eq(folders.id, messageOccurrences.folderId))
    .where(inArray(messageOccurrences.messageId, ids));
  const inInbox = new Set(
    occurrenceRows.filter((row) => row.role === "inbox").map((row) => row.messageId),
  );

  let answered = 0;
  let importantLabeled = 0;
  let importantAnswered = 0;
  let importantPresent = 0;
  let importantBeyondFirstPage = 0;
  const attentionMisses: HomeAttentionMiss[] = [];
  const importantUnanswered: HomeUnansweredImportant[] = [];
  const routineSuggestions: HomeRoutineSuggestion[] = [];
  for (const label of labels) {
    const row = stored.get(label.messageId)!;
    const source = sourceOf(row.metadata);
    const hasAnswer =
      row.classHint !== null ||
      row.asksAction !== null ||
      row.asksReply !== null ||
      row.timeSensitive !== null ||
      source !== null;
    if (hasAnswer) {
      answered += 1;
    }
    const important =
      label.classHint === "security_alert" ||
      label.asksAction === true ||
      label.asksReply === true ||
      label.timeSensitive === true;
    if (!important) {
      continue;
    }
    importantLabeled += 1;
    if (!hasAnswer) {
      importantUnanswered.push({ messageId: row.id, sender: senderAddressOf(row.sender) });
      continue;
    }
    importantAnswered += 1;
    const walkedRow = walked.get(label.messageId);
    if (walkedRow !== undefined) {
      importantPresent += 1;
      if (walkedRow.page > 1) {
        importantBeyondFirstPage += 1;
      }
      continue;
    }
    attentionMisses.push({
      messageId: row.id,
      sender: senderAddressOf(row.sender),
      labeled: {
        classHint: label.classHint,
        asksAction: label.asksAction === true,
        asksReply: label.asksReply === true,
        timeSensitive: label.timeSensitive === true,
      },
      stored: {
        classHint: row.classHint,
        asksAction: row.asksAction,
        asksReply: row.asksReply,
        timeSensitive: row.timeSensitive,
      },
      status: dismissed.has(row.id)
        ? "dismissed"
        : inInbox.has(row.id)
          ? "no_attention_signal"
          : "outside_inbox",
    });
  }

  // Routine mail the attention sections suggested. A choice reason (a star,
  // a priority, saved work) explains a row; a suggestion never does.
  for (const label of labels) {
    const routine =
      ROUTINE_CLASSES.has(label.classHint) &&
      label.asksAction !== true &&
      label.asksReply !== true &&
      label.timeSensitive !== true;
    if (!routine) {
      continue;
    }
    const walkedRow = walked.get(label.messageId);
    if (walkedRow === undefined) {
      continue;
    }
    const hasChoice = walkedRow.reasons.some((reason) => reason.origin === "choice");
    if (hasChoice) {
      continue;
    }
    routineSuggestions.push({
      messageId: label.messageId,
      sender: senderAddressOf(stored.get(label.messageId)!.sender),
      labeledClassHint: label.classHint,
      storedClassHint: stored.get(label.messageId)!.classHint,
      reasonCodes: walkedRow.reasons.map((reason) => reason.code),
    });
  }

  const unexplained = attentionMisses.filter((miss) => miss.status === "no_attention_signal");
  const passed = unexplained.length === 0 && routineSuggestions.length === 0;
  return {
    labeled: labels.length,
    answered,
    importantLabeled,
    importantAnswered,
    importantPresent,
    importantBeyondFirstPage,
    attentionMisses,
    importantUnanswered,
    routineSuggestions,
    attentionRows: walked.size,
    pageLimit,
    passed,
  };
}

/** The precedence level that answered, from the stored metadata. */
function sourceOf(metadata: Record<string, unknown> | null): SuggestionSource | null {
  const source = metadata?.classSource;
  if (typeof source !== "string") {
    return null;
  }
  return (["manual", "override", "rule", "jev"] as const).includes(source as SuggestionSource)
    ? (source as SuggestionSource)
    : null;
}

/** The sender address of a stored sender value, lowercased, or `null`. */
function senderAddressOf(sender: unknown): string | null {
  if (sender === null || typeof sender !== "object") {
    return null;
  }
  const address = (sender as { address?: unknown }).address;
  if (typeof address !== "string" || address.length === 0) {
    return null;
  }
  return address.toLowerCase();
}
