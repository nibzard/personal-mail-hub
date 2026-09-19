import type { OutboundView, SentCopyStatusWire } from "@mail-hub/contracts";

/*
 * The send state the interface shows (SPEC F7). The SMTP attempt and the
 * separate Sent-copy append are two jobs with two states; this module keeps
 * them apart, so a stored message whose append failed still reads "sent"
 * and an accepted send whose copy waits still reads "pending".
 *
 * Every function is pure: the same outbound snapshot always derives the
 * same words, so polling cannot flicker between labels.
 */

/** The SMTP attempt's phase, as the interface names it (SPEC F7 step 4–6). */
export type SendPhase =
  | "queued"
  | "sending"
  | "sent"
  | "partial"
  | "failed"
  | "unknown";

/**
 * The phase of one outbound snapshot. `sent` splits by recipient results:
 * some accepted and some rejected is `partial`, shown explicitly rather
 * than folded into a success.
 */
export function sendPhaseOf(outbound: OutboundView): SendPhase {
  switch (outbound.status) {
    case "queued":
      return "queued";
    case "sending":
      return "sending";
    case "failed":
      return "failed";
    case "outcome_unknown":
      return "unknown";
    case "sent": {
      const rejected = outbound.recipientResults.filter(
        (result) => result.accepted !== true,
      ).length;
      return rejected > 0 ? "partial" : "sent";
    }
  }
}

/** One-line labels for badges and list rows. */
export function sendPhaseLabel(phase: SendPhase): string {
  switch (phase) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "partial":
      return "Partially accepted";
    case "failed":
      return "Failed";
    case "unknown":
      return "Outcome unknown";
  }
}

/** What each phase means, for the line under the badge. */
export function sendPhaseDescription(phase: SendPhase): string {
  switch (phase) {
    case "queued":
      return "The snapshot is frozen; the send worker has not claimed it yet.";
    case "sending":
      return "The worker is submitting the stored bytes over SMTP.";
    case "sent":
      return "The server accepted the message for every recipient. Acceptance is not delivery to their inboxes.";
    case "partial":
      return "The server accepted some recipients and rejected the rest. The accepted ones were sent once.";
    case "failed":
      return "The server refused the message before accepting any content. The draft is editable again.";
    case "unknown":
      return "The result of the attempt cannot be classified. It may have arrived; nothing resubmits it automatically.";
  }
}

/** Badge variants for each phase; text always carries the meaning too. */
export function sendPhaseBadgeVariant(
  phase: SendPhase,
): "default" | "success" | "warning" | "destructive" | "info" | "outline" {
  switch (phase) {
    case "queued":
      return "info";
    case "sending":
      return "info";
    case "sent":
      return "success";
    case "partial":
      return "warning";
    case "failed":
      return "destructive";
    case "unknown":
      return "warning";
  }
}

/** One-line labels for the separate Sent-copy append (SPEC F7 step 5). */
export function sentCopyStatusLabel(status: SentCopyStatusWire): string {
  switch (status) {
    case "pending":
      return "Sent copy pending";
    case "appending":
      return "Appending to Sent";
    case "stored":
      return "Stored in Sent";
    case "failed":
      return "Sent copy failed";
    case "unknown":
      return "Sent copy unknown";
  }
}

/** What each Sent-copy state means, for the line under the badge. */
export function sentCopyStatusDescription(status: SentCopyStatusWire): string {
  switch (status) {
    case "pending":
      return "The append job has not run yet. SMTP state stays as it is whatever happens here.";
    case "appending":
      return "The stored bytes are being appended to the account's Sent folder.";
    case "stored":
      return "The Sent folder holds the copy, verified by identifier and hash.";
    case "failed":
      return "The append failed. The send itself stays sent; the job retries without touching SMTP.";
    case "unknown":
      return "The append result is uncertain until reconciliation proves absence. It is not retried blindly.";
  }
}

/** Badge variants for the Sent-copy states. */
export function sentCopyBadgeVariant(
  status: SentCopyStatusWire,
): "default" | "success" | "warning" | "destructive" | "info" | "outline" {
  switch (status) {
    case "pending":
      return "outline";
    case "appending":
      return "info";
    case "stored":
      return "success";
    case "failed":
      return "destructive";
    case "unknown":
      return "warning";
  }
}

/**
 * True when the SMTP attempt reached a state polling cannot move it from.
 * The Sent-copy append may still be in flight; it is tracked separately.
 */
export function sendAttemptSettled(outbound: OutboundView): boolean {
  return outbound.status !== "queued" && outbound.status !== "sending";
}

/**
 * True while either job can still change on its own, so the interface knows
 * whether polling is worth a request.
 */
export function outboundStillMoving(outbound: OutboundView): boolean {
  return (
    !sendAttemptSettled(outbound) ||
    outbound.sentCopyStatus === "pending" ||
    outbound.sentCopyStatus === "appending"
  );
}

/** Whether a deliberate resend of this attempt may be offered at all. */
export type ResendGate =
  | { kind: "offered" }
  | { kind: "unavailable"; reason: string };

/**
 * Whether one outbound snapshot may be resent deliberately (SPEC F7).
 *
 * A partial acceptance never resends: the accepted recipients already got
 * the message, and a new snapshot would send to them again. A failed send
 * needs no warning — the server refused it before accepting any content —
 * but it needs the draft unlocked first. Everything else stays as it is.
 */
export function resendGateOf(outbound: OutboundView): ResendGate {
  switch (sendPhaseOf(outbound)) {
    case "partial":
      return {
        kind: "unavailable",
        reason:
          "Some recipients were accepted already. A retry would send to them again, so none is offered.",
      };
    case "failed":
      return { kind: "offered" };
    case "unknown":
      return {
        kind: "unavailable",
        reason:
          "The outcome is unknown and preserved for review. Reconciliation decides it; nothing here resubmits it.",
      };
    default:
      return {
        kind: "unavailable",
        reason: "This send already has a definitive outcome.",
      };
  }
}

/**
 * The duplicate warning one deliberate resend shows before it runs (SPEC F7
 * step 6). No automatic resend follows an uncertain attempt; a person reads
 * this line and acknowledges it first.
 */
export const DUPLICATE_SEND_WARNING =
  "The first attempt may have reached the server. Sending again may deliver a duplicate.";
