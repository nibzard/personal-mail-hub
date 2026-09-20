import { normalizeIndexText } from "@mail-hub/ingestion/text";
import { SearchError } from "./errors.ts";

/**
 * The search query language (SPEC F5).
 *
 * One query is free text plus operators. Free text runs against the
 * generated `search` vector; operators filter before ranking. Values are
 * normalized with the same function ingestion applies to index text, so the
 * index and the query always agree.
 *
 * Operators: `from:`, `to:`, `domain:`, `is:unread`, `is:flagged`,
 * `is:action`, `has:attachment`, `type:`, `before:`, `after:`. Unknown
 * operators, empty values, and dates that are not real calendar dates
 * reject. Double quotes keep a span together as free text, so quoted text
 * may contain colons, for example URLs. A quote without its closing quote
 * rejects, because no token could say what the writer meant.
 */

/** The Jev message classes a `type:` operator may select (SPEC F8). */
export const JEV_CLASSES = [
  "correspondence",
  "receipt",
  "newsletter",
  "notification",
  "marketing",
  "security_alert",
  "bounce",
  "other",
] as const;

/** One Jev message class, as `class_hint` stores it. */
export type JevClass = (typeof JEV_CLASSES)[number];

const JEV_CLASS_SET = new Set<string>(JEV_CLASSES);

/** One parsed search query: the free text and every operator filter. */
export interface ParsedSearchQuery {
  /** Remaining free text, normalized like index text. */
  text: string;
  /** Sender match values for `from:`, normalized. */
  from: string[];
  /** Recipient match values for `to:`, normalized. */
  to: string[];
  /** Address domains for `domain:`, validated. */
  domains: string[];
  /** Jev classes for `type:`. */
  types: JevClass[];
  /** `is:unread` was present. */
  unread: boolean;
  /** `is:flagged` was present. */
  flagged: boolean;
  /** `is:action` was present. */
  action: boolean;
  /** `has:attachment` was present. */
  hasAttachment: boolean;
  /** Exclusive lower-or-upper UTC date boundary from `before:` / `after:`. */
  before: Date | null;
  after: Date | null;
}

/** The empty query: no text and no operator. */
export function emptyQuery(): ParsedSearchQuery {
  return {
    text: "",
    from: [],
    to: [],
    domains: [],
    types: [],
    unread: false,
    flagged: false,
    action: false,
    hasAttachment: false,
    before: null,
    after: null,
  };
}

/** True when nothing in the query can narrow a result set. */
export function isQueryEmpty(parsed: ParsedSearchQuery): boolean {
  return (
    parsed.text === "" &&
    parsed.from.length === 0 &&
    parsed.to.length === 0 &&
    parsed.domains.length === 0 &&
    parsed.types.length === 0 &&
    !parsed.unread &&
    !parsed.flagged &&
    !parsed.action &&
    !parsed.hasAttachment &&
    parsed.before === null &&
    parsed.after === null
  );
}

/**
 * One query token: either an operator with its value, or free text. A
 * double-quoted span stays one token; a quoted operator value keeps its
 * spaces, and a quoted free-text span may contain colons.
 */
const TOKEN_PATTERN = /([a-zA-Z]+):(?:"([^"]*)"|(\S*))|(?:"([^"]*)"|([^\s"]+))/g;

/**
 * Parse one query string. Throws `SearchError` with `invalid_query` on an
 * unknown operator, an empty operator value, an unknown `is:` or `has:`
 * value, an unknown Jev class, an invalid date, or a dangling double quote.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const quotes = raw.match(/"/g)?.length ?? 0;
  if (quotes % 2 === 1) {
    throw new SearchError("invalid_query", "A double quote is missing its closing quote.");
  }
  const parsed = emptyQuery();
  const freeText: string[] = [];

  for (const match of raw.matchAll(TOKEN_PATTERN)) {
    const [, operator, quotedValue, plainValue, quotedText, plainText] = match;
    if (operator !== undefined) {
      const value = quotedValue ?? plainValue ?? "";
      applyOperator(parsed, operator.toLowerCase(), value);
      continue;
    }
    const text = quotedText ?? plainText ?? "";
    if (text.length > 0) {
      // Quoted spans keep their quotes so the phrase survives into the text
      // query: `websearch_to_tsquery` reads them as phrase instructions.
      freeText.push(quotedText === undefined ? normalizeIndexText(text) : `"${normalizeIndexText(text)}"`);
    }
  }

  parsed.text = normalizeIndexText(freeText.join(" "));
  return parsed;
}

/** Apply one operator token, rejecting anything this version does not define. */
function applyOperator(parsed: ParsedSearchQuery, operator: string, value: string): void {
  switch (operator) {
    case "from":
      pushValue(parsed.from, normalizeIndexText(requireValue("from", value)));
      return;
    case "to":
      pushValue(parsed.to, normalizeIndexText(requireValue("to", value)));
      return;
    case "domain":
      pushValue(parsed.domains, normalizeDomainValue(requireValue("domain", value)));
      return;
    case "type":
      pushValue(parsed.types, parseJevClass(requireValue("type", value)));
      return;
    case "before":
      parsed.before = parseDateBoundary(requireValue("before", value));
      return;
    case "after":
      parsed.after = parseDateBoundary(requireValue("after", value));
      return;
    case "is":
      return applyIsOperator(parsed, requireValue("is", value));
    case "has":
      if (requireValue("has", value).toLowerCase() !== "attachment") {
        throw new SearchError("invalid_query", `Unknown operator "has:${value}". This version defines has:attachment only.`);
      }
      parsed.hasAttachment = true;
      return;
    default:
      throw new SearchError(
        "invalid_query",
        `Unknown operator "${operator}:". Quote the text to search for it literally.`,
      );
  }
}

/** The closed `is:` operator set: unread, flagged, and action. */
function applyIsOperator(parsed: ParsedSearchQuery, value: string): void {
  switch (value.toLowerCase()) {
    case "unread":
      parsed.unread = true;
      return;
    case "flagged":
      parsed.flagged = true;
      return;
    case "action":
      parsed.action = true;
      return;
    default:
      throw new SearchError(
        "invalid_query",
        `Unknown operator "is:${value}". This version defines is:unread, is:flagged, and is:action.`,
      );
  }
}

/** One Jev class, normalized; unknown classes reject. */
export function parseJevClass(value: string): JevClass {
  const normalized = normalizeIndexText(value);
  if (!JEV_CLASS_SET.has(normalized)) {
    throw new SearchError(
      "invalid_query",
      `Unknown type "${value}". Choose one of: ${JEV_CLASSES.join(", ")}.`,
    );
  }
  return normalized as JevClass;
}

/**
 * One UTC date boundary from a `YYYY-MM-DD` value. Dates that are not real
 * calendar dates reject; the boundary is midnight UTC and comparisons
 * against it are exclusive (SPEC F5).
 */
export function parseDateBoundary(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SearchError("invalid_query", `Invalid date "${value}". Use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new SearchError("invalid_query", `Invalid date "${value}". The calendar has no such day.`);
  }
  return date;
}

/**
 * One address domain: lowercased and validated. The shape allows the labels
 * the domain name system allows, without the wildcard characters of the
 * pattern match it feeds.
 */
export function normalizeDomainValue(value: string): string {
  const normalized = normalizeIndexText(value);
  if (normalized.length === 0 || normalized.length > 253) {
    throw new SearchError("invalid_query", `Invalid domain "${value}".`);
  }
  const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  if (!normalized.split(".").every((part) => label.test(part))) {
    throw new SearchError("invalid_query", `Invalid domain "${value}".`);
  }
  return normalized;
}

function requireValue(operator: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SearchError("invalid_query", `Operator "${operator}:" needs a value.`);
  }
  return trimmed;
}

/** Add one value to a list, keeping the first position of a repeated value. */
function pushValue<T>(list: T[], value: T): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}
