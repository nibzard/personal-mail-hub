import { createHash } from "node:crypto";

/**
 * Minimized message input (SPEC F8 pipeline).
 *
 * Jev sees sender, subject, and the first slice of extracted text only: no
 * attachments, no headers beyond the two it needs, and no quoted chains. The
 * composed text is exactly what leaves the machine, and its hash is stored
 * with the decision so an answer can always be traced to its input.
 */

/** The most text one call carries: the spec's 2–4 KB window (SPEC F8). */
export const MAX_INPUT_CHARS = 4096;

/**
 * The most sender text one input carries. Display names arrive from the
 * wire with no length bound, so the header is cut field by field before
 * composing; the window then bounds the whole text, not just the body.
 */
export const MAX_SENDER_CHARS = 256;

/** The most subject text one input carries, cut for the same reason. */
export const MAX_SUBJECT_CHARS = 512;

/** The minimized text one classification carries, with its hash. */
export interface MinimizedMessageInput {
  /** The exact text sent to Jev. */
  text: string;
  /** SHA-256 of `text`, hex; the decisions row stores it (SPEC section 8). */
  inputHash: string;
  /** True when any field — sender, subject, or body — was cut to fit. */
  truncated: boolean;
}

/** The header fields a classification reads. */
export interface MessageInputSource {
  /** The sender as text, for example `Name <address>` or the bare address. */
  senderText: string;
  subject: string | null;
  /** Extracted body text: the plain part, or text read from sanitized HTML. */
  bodyText: string | null;
}

/**
 * One quote boundary: the start of a forwarded or replied chain. Everything
 * from the first match onward is quoted material and never leaves storage.
 */
const QUOTE_BOUNDARY_PATTERNS: RegExp[] = [
  /^On .+\bwrote:$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^From:\s/i,
];

/** True when one line opens a quoted chain. */
function isQuoteBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith(">")) {
    return true;
  }
  return QUOTE_BOUNDARY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Strip quoted chains from body text: cut at the first boundary line and
 * drop any quoted line that appears before one. Signature separators stay;
 * a wrong cut only shortens what Jev sees, never widens it.
 */
export function stripQuotedChains(bodyText: string): string {
  const kept: string[] = [];
  for (const line of bodyText.split(/\r?\n/)) {
    if (isQuoteBoundary(line)) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Compose the minimized input for one message. Whitespace collapses, the
 * body sheds quoted chains, sender and subject are cut to their field
 * bounds, and the whole text stops at the window edge — so the composed
 * text is never longer than the window the token estimate assumes.
 */
export function minimizeMessageInput(source: MessageInputSource): MinimizedMessageInput {
  const senderCollapsed = collapse(source.senderText);
  const subjectCollapsed = collapse(source.subject ?? "");
  const sender = senderCollapsed.slice(0, MAX_SENDER_CHARS);
  const subject = subjectCollapsed.slice(0, MAX_SUBJECT_CHARS);
  const body = collapse(stripQuotedChains(source.bodyText ?? ""));

  const header = `From: ${sender}\nSubject: ${subject}\n\n`;
  const bodyRoom = Math.max(0, MAX_INPUT_CHARS - header.length);
  const bodySlice = body.slice(0, bodyRoom);
  const text = `${header}${bodySlice}`;
  return {
    text,
    inputHash: createHash("sha256").update(text, "utf8").digest("hex"),
    truncated:
      senderCollapsed.length > sender.length ||
      subjectCollapsed.length > subject.length ||
      body.length > bodySlice.length,
  };
}

/** Collapse runs of whitespace into single spaces and trim the ends. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
