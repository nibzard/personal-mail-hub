import type { MessageClass } from "@mail-hub/contracts";

/**
 * Deterministic rules: precedence level 3 (SPEC F8).
 *
 * Regex and known-sender lists answer before Jev sees anything, so no API
 * call is spent on mail a rule already classifies with certainty. Every rule
 * must be conservative: it names a class only when the pattern itself is the
 * proof, and anything unmatched falls through to Jev.
 */

/** One matched rule: the class it proves and its stable name. */
export interface DeterministicRuleMatch {
  classHint: MessageClass;
  rule: string;
}

/** Sender domains whose mail is a security notification by contract. */
const SECURITY_SENDER_DOMAINS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "appleid.apple.com",
  "github.com",
  "login.microsoftonline.com",
  "no-reply.accounts.firefox.com",
  "signin.aws.amazon.com",
]);

/** Sender local parts that mark machine-generated delivery reports. */
const BOUNCE_SENDER_LOCALS: ReadonlySet<string> = new Set(["mailer-daemon", "postmaster"]);

/** Subjects that announce an access code (SPEC F8: 2FA codes). */
const SECURITY_SUBJECT_PATTERNS: { rule: string; pattern: RegExp }[] = [
  {
    rule: "security_code_subject",
    pattern:
      /\b(?:verification|verify|security|login|log-in|sign-in|sign in|one-time|two-factor|2fa)\b[^.\n]{0,40}\b(?:code|otp|passcode|token)\b/i,
  },
  {
    rule: "security_code_subject_reverse",
    pattern:
      /\b(?:code|otp|passcode|token)\b[^.\n]{0,40}\b(?:verification|verify|security|login|log-in|sign-in|sign in|one-time|two-factor|2fa)\b/i,
  },
];

/** Subjects that announce a statement, invoice, or receipt (SPEC F8). */
const RECEIPT_SUBJECT_PATTERN =
  /\b(?:statement|invoice|receipt|order confirmation|payment confirmation|payment receipt)\b/i;

/** Subjects a mail server stamps on a delivery failure. */
const BOUNCE_SUBJECT_PATTERN =
  /^(?:undeliverable|undelivered mail|mail delivery failed|delivery (?:has )?failed|delivery status notification|returned mail|mail system error)/i;

/** The address fields one rule may read. */
export interface RuleInput {
  /**
   * Sender address, or `null` when the header was unusable. Stored addresses
   * keep the case the server sent, so the rules compare the lowercased form.
   */
  senderAddress: string | null;
  subject: string | null;
}

/**
 * Match the deterministic rules for one message. The first match wins and
 * the order is part of the contract: security answers outrank everything
 * because `security_alert` is the breakout class (SPEC F8 guardrails).
 */
export function matchDeterministicRules(input: RuleInput): DeterministicRuleMatch | null {
  const subject = input.subject ?? "";
  const [localPart = "", domain = ""] = (input.senderAddress ?? "").toLowerCase().split("@");

  if (BOUNCE_SENDER_LOCALS.has(localPart) || BOUNCE_SUBJECT_PATTERN.test(subject)) {
    return { classHint: "bounce", rule: "bounce_sender_or_subject" };
  }
  if (
    SECURITY_SENDER_DOMAINS.has(domain) ||
    SECURITY_SUBJECT_PATTERNS.some(({ pattern }) => pattern.test(subject))
  ) {
    return { classHint: "security_alert", rule: "security_sender_or_subject" };
  }
  if (RECEIPT_SUBJECT_PATTERN.test(subject)) {
    return { classHint: "receipt", rule: "receipt_subject" };
  }
  return null;
}
