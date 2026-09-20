import type { HomeReasonView, MessageClass, SuggestionSource } from "@mail-hub/contracts";

/**
 * Deterministic attention ranking and reason generation for Home (SPEC F13).
 *
 * Nothing here reads a database: the service assembles candidates from
 * stored answers and explicit choices, and this module decides, purely,
 * what deserves attention, in what order, and why. The order is a tuple —
 * tier, then recency, then the message identifier — never a score that
 * mixes unrelated signals.
 */

/**
 * The action breakout threshold, reused for exactly its existing purpose
 * (SPEC F8): a high-confidence `asks_action` answer exits routine groups.
 */
export const ACTION_BREAKOUT_CONFIDENCE = 0.75;

/**
 * One message the attention section may consider. Every field comes from a
 * stored answer or a stored choice; nothing is inferred here.
 */
export interface AttentionCandidate {
  messageId: string;
  accountId: string;
  threadId: string | null;
  /**
   * The effective send time: the header date, or the arrival instant
   * when no usable header date exists. `null` when neither is known.
   */
  sentAt: Date | null;
  /** The lowercased sender address, or `null` when unusable. */
  senderAddress: string | null;
  /** The stored class answer; `null` while nothing answered. */
  classHint: MessageClass | null;
  /** Which precedence level answered, or `null` before anything did. */
  classSource: SuggestionSource | null;
  asksAction: boolean | null;
  asksReply: boolean | null;
  timeSensitive: boolean | null;
  /**
   * The action confidence from the stored decision that matches the current
   * answer. `null` means no matching decision exists: another precedence
   * level answered, or confidence never arrived. Unknown stays unknown.
   */
  actionConfidence: number | null;
  /** True when an explicit priority choice covers this message. */
  prioritySender: boolean;
  priorityThread: boolean;
}

/** The attention tiers, in order: leading, then remaining suggestions. */
export type AttentionTier = 0 | 1;

/**
 * The tier one candidate earns, or `null` when it asks for no attention.
 *
 * Tier 0 holds the leading group: protected security and high-confidence
 * action items beside every explicit priority choice. A priority choice can
 * never demote a protected item into tier 1, because both stand in tier 0.
 *
 * Tier 1 holds the remaining suggestions: an action answer below or without
 * confidence, a reply suggestion, or a time-sensitive answer. Time
 * sensitivity raises attention; it never creates a deadline.
 */
export function attentionTier(candidate: AttentionCandidate): AttentionTier | null {
  if (
    candidate.prioritySender ||
    candidate.priorityThread ||
    candidate.classHint === "security_alert" ||
    isProtectedAction(candidate)
  ) {
    return 0;
  }
  if (
    candidate.asksAction === true ||
    candidate.asksReply === true ||
    candidate.timeSensitive === true
  ) {
    return 1;
  }
  return null;
}

/** True when a high-confidence action answer protects this candidate. */
function isProtectedAction(candidate: AttentionCandidate): boolean {
  return (
    candidate.asksAction === true &&
    candidate.actionConfidence !== null &&
    candidate.actionConfidence >= ACTION_BREAKOUT_CONFIDENCE
  );
}

/**
 * The attention reasons one candidate carries, most important first. A
 * suggestion reason keeps the origin of the answer that produced it: your
 * manual placement or sender override is your choice; rules and Jev only
 * suggest.
 */
export function attentionReasons(candidate: AttentionCandidate): HomeReasonView[] {
  const reasons: HomeReasonView[] = [];
  if (candidate.prioritySender) {
    reasons.push({ code: "you_prioritized_sender", origin: "choice" });
  }
  if (candidate.priorityThread) {
    reasons.push({ code: "you_prioritized_thread", origin: "choice" });
  }
  if (candidate.classHint === "security_alert") {
    reasons.push({ code: "security_alert", origin: suggestionOrigin(candidate.classSource) });
  }
  if (candidate.asksAction === true) {
    reasons.push({ code: "may_need_action", origin: suggestionOrigin(candidate.classSource) });
  }
  if (candidate.asksReply === true) {
    reasons.push({ code: "may_need_reply", origin: suggestionOrigin(candidate.classSource) });
  }
  if (candidate.timeSensitive === true) {
    reasons.push({ code: "time_sensitive", origin: suggestionOrigin(candidate.classSource) });
  }
  return reasons;
}

/** A stored answer suggests unless you recorded it yourself. */
function suggestionOrigin(source: SuggestionSource | null): "choice" | "suggestion" {
  return source === "manual" || source === "override" ? "choice" : "suggestion";
}

/**
 * The deterministic attention order: tier first, then recency, then the
 * message identifier. The identifier makes the order total, so equal dates
 * never shuffle.
 */
export function compareAttention(a: AttentionCandidate, b: AttentionCandidate): number {
  const tierA = attentionTier(a);
  const tierB = attentionTier(b);
  if (tierA === null || tierB === null) {
    throw new Error("compareAttention needs attention-eligible candidates.");
  }
  if (tierA !== tierB) {
    return tierA - tierB;
  }
  const timeA = a.sentAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const timeB = b.sentAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (timeA !== timeB) {
    return timeB - timeA;
  }
  return compareIdentifier(a.messageId, b.messageId);
}

/** Identifier order, ascending, as the final tiebreak everywhere in Home. */
export function compareIdentifier(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The sort key one candidate paginates by: its tier, instant, and
 * identifier, in the order `compareAttention` uses. The section cursor
 * carries the last emitted key, and the next page keeps every entry whose
 * key sorts strictly after it — stable even when earlier entries were
 * dismissed between pages.
 */
export function attentionSortKey(candidate: AttentionCandidate): AttentionSortKey {
  const tier = attentionTier(candidate);
  if (tier === null) {
    throw new Error("attentionSortKey needs an attention-eligible candidate.");
  }
  return {
    tier,
    sentAt: candidate.sentAt?.toISOString() ?? "",
    messageId: candidate.messageId,
  };
}

/** The keyset one attention page emits and the next page continues from. */
export interface AttentionSortKey {
  tier: AttentionTier;
  /** ISO instant, or the empty string when no usable date exists. */
  sentAt: string;
  messageId: string;
}

/**
 * True when one sort key stands strictly after another in section order.
 * Within a tier the order is recency descending, so a later entry carries an
 * earlier instant; the empty string (no date) sorts behind every real one.
 */
export function attentionKeyAfter(key: AttentionSortKey, last: AttentionSortKey): boolean {
  if (key.tier !== last.tier) {
    return key.tier > last.tier;
  }
  if (key.sentAt !== last.sentAt) {
    return key.sentAt < last.sentAt;
  }
  return key.messageId > last.messageId;
}
