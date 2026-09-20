import { describe, expect, it } from "vitest";
import type { OutboundView } from "@mail-hub/contracts";
import {
  DUPLICATE_SEND_WARNING,
  outboundStillMoving,
  resendGateOf,
  sendAttemptSettled,
  sendPhaseLabel,
  sendPhaseOf,
  sentCopyStatusLabel,
} from "../src/mail/send-state.ts";

/*
 * The send states the interface keeps apart (SPEC F7): the SMTP attempt and
 * the Sent-copy append derive their words and their retry gates from one
 * snapshot without ever folding one into the other.
 */

function outbound(overrides: Partial<OutboundView> = {}): OutboundView {
  return {
    id: "ob-1",
    draftId: "d-1",
    accountId: "acc-1",
    status: "queued",
    sentCopyStatus: "pending",
    identity: { address: "me@example.com", name: null },
    recipients: { to: [{ address: "them@example.com", name: null }] },
    subject: null,
    rfcMessageId: "<id@fixture>",
    recipientResults: [],
    smtpResponse: null,
    lastError: null,
    createdAt: "2026-09-17T09:30:00Z",
    sentAt: null,
    ...overrides,
  };
}

describe("sendPhaseOf", () => {
  it("maps the wire statuses to their phases", () => {
    expect(sendPhaseOf(outbound({ status: "queued" }))).toBe("queued");
    expect(sendPhaseOf(outbound({ status: "sending" }))).toBe("sending");
    expect(sendPhaseOf(outbound({ status: "failed" }))).toBe("failed");
    expect(sendPhaseOf(outbound({ status: "outcome_unknown" }))).toBe("unknown");
  });

  it("splits a sent status by its recipient results", () => {
    const accepted = outbound({
      status: "sent",
      recipientResults: [{ address: "a@example.com", accepted: true, response: "250 Ok" }],
    });
    expect(sendPhaseOf(accepted)).toBe("sent");

    const mixed = outbound({
      status: "sent",
      recipientResults: [
        { address: "a@example.com", accepted: true, response: "250 Ok" },
        { address: "b@example.com", accepted: false, response: "550 No" },
      ],
    });
    expect(sendPhaseOf(mixed)).toBe("partial");
    expect(sendPhaseLabel("partial")).toBe("Partially accepted");
  });
});

describe("outboundStillMoving", () => {
  it("tracks the attempt and the copy separately", () => {
    expect(outboundStillMoving(outbound({ status: "queued" }))).toBe(true);
    expect(outboundStillMoving(outbound({ status: "sending" }))).toBe(true);

    const sentButAppending = outbound({ status: "sent", sentCopyStatus: "appending" });
    expect(sendAttemptSettled(sentButAppending)).toBe(true);
    expect(outboundStillMoving(sentButAppending)).toBe(true);

    const fullySettled = outbound({ status: "sent", sentCopyStatus: "stored" });
    expect(outboundStillMoving(fullySettled)).toBe(false);

    const copyPending = outbound({ status: "sent", sentCopyStatus: "pending" });
    expect(outboundStillMoving(copyPending)).toBe(true);
  });
});

describe("resendGateOf", () => {
  it("offers the unlocked draft only after a definitive failure", () => {
    expect(resendGateOf(outbound({ status: "failed" }))).toEqual({ kind: "edit-again" });
  });

  it("never offers a resend of a partial acceptance", () => {
    const partial = outbound({
      status: "sent",
      recipientResults: [
        { address: "a@example.com", accepted: true, response: "250 Ok" },
        { address: "b@example.com", accepted: false, response: "550 No" },
      ],
    });
    const gate = resendGateOf(partial);
    expect(gate.kind).toBe("unavailable");
    expect(gate.kind === "unavailable" && gate.reason).toMatch(/accepted already/u);
  });

  it("offers the deliberate copy of an unknown outcome, never a resubmit", () => {
    expect(resendGateOf(outbound({ status: "outcome_unknown" }))).toEqual({ kind: "resend-copy" });
  });

  it("keeps a definitive success final", () => {
    expect(resendGateOf(outbound({ status: "sent" })).kind).toBe("unavailable");
  });
});

describe("labels", () => {
  it("names every phase and Sent-copy state distinctly", () => {
    expect(sendPhaseLabel("unknown")).toBe("Outcome unknown");
    expect(sentCopyStatusLabel("stored")).toBe("Stored in Sent");
    expect(sentCopyStatusLabel("appending")).toBe("Appending to Sent");
    expect(DUPLICATE_SEND_WARNING).toMatch(/may deliver a duplicate/u);
  });
});
