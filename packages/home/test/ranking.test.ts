import { describe, expect, it } from "vitest";
import type { SuggestionSource } from "@mail-hub/contracts";
import {
  ACTION_BREAKOUT_CONFIDENCE,
  attentionKeyAfter,
  attentionReasons,
  attentionSortKey,
  attentionTier,
  compareAttention,
} from "../src/ranking.ts";

/**
 * The deterministic attention ranking and reason vocabulary (SPEC F13),
 * tested purely: every case here names a row in the SPEC's selection and
 * ranking table.
 */

/** One candidate with every field defaulted to "no signal". */
function candidate(overrides: Partial<Parameters<typeof attentionTier>[0]> = {}) {
  return {
    messageId: "00000000-0000-4000-8000-000000000001",
    accountId: "a",
    threadId: null,
    sentAt: new Date("2026-09-01T00:00:00Z"),
    senderAddress: "sender@example.com",
    classHint: null,
    classSource: null,
    asksAction: null,
    asksReply: null,
    timeSensitive: null,
    actionConfidence: null,
    prioritySender: false,
    priorityThread: false,
    ...overrides,
  };
}

/** The tier of one candidate, spelled for the assertion message. */
function tierOf(overrides: Parameters<typeof candidate>[0]) {
  return attentionTier(candidate(overrides));
}

describe("attention tier", () => {
  it("keeps mail with no signal out of attention entirely", () => {
    expect(tierOf({})).toBeNull();
    expect(tierOf({ asksAction: false, asksReply: false, timeSensitive: false })).toBeNull();
  });

  it("puts an explicit priority choice in the leading tier", () => {
    expect(tierOf({ prioritySender: true })).toBe(0);
    expect(tierOf({ priorityThread: true })).toBe(0);
    // Even when the message would otherwise ask for nothing.
    expect(tierOf({ prioritySender: true, asksAction: false, asksReply: false })).toBe(0);
  });

  it("protects security alerts in the leading tier", () => {
    expect(tierOf({ classHint: "security_alert", classSource: "jev" })).toBe(0);
    expect(tierOf({ classHint: "newsletter" })).toBeNull();
  });

  it("protects only high-confidence action answers", () => {
    expect(tierOf({ asksAction: true, actionConfidence: ACTION_BREAKOUT_CONFIDENCE })).toBe(0);
    expect(tierOf({ asksAction: true, actionConfidence: 0.9 })).toBe(0);
    // Unknown confidence never protects: unknown stays unknown (SPEC F13).
    expect(tierOf({ asksAction: true, actionConfidence: null })).toBe(1);
    expect(tierOf({ asksAction: true, actionConfidence: 0.74 })).toBe(1);
    expect(tierOf({ asksAction: true, actionConfidence: 0 })).toBe(1);
    // Confidence without the answer it belongs to suggests nothing more.
    expect(tierOf({ asksAction: null, actionConfidence: 0.9 })).toBeNull();
    expect(tierOf({ asksAction: false, actionConfidence: 0.9 })).toBeNull();
  });

  it("holds the remaining suggestions in the second tier", () => {
    expect(tierOf({ asksAction: true })).toBe(1);
    expect(tierOf({ asksReply: true, classSource: "rule" })).toBe(1);
    expect(tierOf({ timeSensitive: true })).toBe(1);
  });

  it("never lets priority demote a protected item", () => {
    // Both stand in tier 0, so a priority choice cannot push a protected
    // item behind ordinary suggestions.
    expect(tierOf({ prioritySender: true, asksAction: true, actionConfidence: 0.9 })).toBe(0);
  });
});

describe("attention reasons", () => {
  it("names priority first, as the owner's choice", () => {
    const reasons = attentionReasons(
      candidate({ prioritySender: true, priorityThread: true, classHint: "security_alert" }),
    );
    expect(reasons.map((item) => item.code)).toEqual([
      "you_prioritized_sender",
      "you_prioritized_thread",
      "security_alert",
    ]);
    expect(reasons[0]).toMatchObject({ origin: "choice" });
  });

  it("keeps the origin of the answer that produced a suggestion", () => {
    const sources: SuggestionSource[] = ["manual", "override", "rule", "jev"];
    for (const source of sources) {
      const [reason] = attentionReasons(candidate({ asksReply: true, classSource: source }));
      expect(reason).toEqual({
        code: "may_need_reply",
        origin: source === "manual" || source === "override" ? "choice" : "suggestion",
      });
    }
  });

  it("collects every signal a candidate carries", () => {
    const reasons = attentionReasons(
      candidate({
        classHint: "security_alert",
        classSource: "jev",
        asksAction: true,
        asksReply: true,
        timeSensitive: true,
        actionConfidence: 0.9,
      }),
    );
    expect(reasons.map((item) => item.code)).toEqual([
      "security_alert",
      "may_need_action",
      "may_need_reply",
      "time_sensitive",
    ]);
    expect(reasons.every((item) => item.origin === "suggestion")).toBe(true);
  });
});

describe("deterministic order", () => {
  it("orders by tier, then recency descending, then identifier", () => {
    const older = candidate({ messageId: "b", sentAt: new Date("2026-09-01T00:00:00Z"), asksReply: true });
    const newer = candidate({ messageId: "a", sentAt: new Date("2026-09-02T00:00:00Z"), asksReply: true });
    const lead = candidate({ messageId: "z", sentAt: new Date("2020-01-01T00:00:00Z"), prioritySender: true });

    const ordered = [older, newer, lead].sort(compareAttention);
    expect(ordered.map((item) => item.messageId)).toEqual(["z", "a", "b"]);
  });

  it("breaks equal dates by identifier so the order is total", () => {
    const at = new Date("2026-09-01T00:00:00Z");
    const first = candidate({
      messageId: "00000000-0000-4000-8000-000000000001",
      sentAt: at,
      asksReply: true,
    });
    const second = candidate({
      messageId: "00000000-0000-4000-8000-000000000002",
      sentAt: at,
      asksReply: true,
    });
    expect(compareAttention(first, second)).toBeLessThan(0);
    expect(compareAttention(second, first)).toBeGreaterThan(0);
  });

  it("sorts messages without a date behind every dated one", () => {
    const dated = candidate({ messageId: "a", sentAt: new Date("2001-01-01T00:00:00Z"), asksReply: true });
    const undated = candidate({ messageId: "b", sentAt: null, asksReply: true });
    expect(compareAttention(undated, dated)).toBeGreaterThan(0);
  });
});

describe("keyset pagination keys", () => {
  it("builds the key from the tier, instant, and identifier", () => {
    expect(
      attentionSortKey(
        candidate({
          messageId: "m1",
          sentAt: new Date("2026-09-01T00:00:00Z"),
          prioritySender: true,
        }),
      ),
    ).toEqual({ tier: 0, sentAt: "2026-09-01T00:00:00.000Z", messageId: "m1" });
  });

  it("follows the section order: later tiers, then earlier instants, then identifiers", () => {
    const key = (overrides: Parameters<typeof candidate>[0]) =>
      attentionSortKey(candidate({ asksReply: true, ...overrides }));
    const last = key({ messageId: "m", sentAt: new Date("2026-09-05T00:00:00Z") });
    // Within one tier, the next page carries an earlier or equal instant.
    expect(attentionKeyAfter(key({ messageId: "a", sentAt: new Date("2026-09-06T00:00:00Z") }), last)).toBe(false);
    expect(attentionKeyAfter(key({ messageId: "a", sentAt: new Date("2026-09-04T00:00:00Z") }), last)).toBe(true);
    // Equal instants page by identifier.
    expect(
      attentionKeyAfter(key({ messageId: "z", sentAt: new Date("2026-09-05T00:00:00Z") }), last),
    ).toBe(true);
    expect(
      attentionKeyAfter(key({ messageId: "a", sentAt: new Date("2026-09-05T00:00:00Z") }), last),
    ).toBe(false);
    // A later tier always follows, whatever the instant.
    expect(
      attentionKeyAfter(
        key({ messageId: "a", sentAt: new Date("2030-01-01T00:00:00Z") }),
        attentionSortKey(
          candidate({ messageId: "z", sentAt: new Date("2020-01-01T00:00:00Z"), prioritySender: true }),
        ),
      ),
    ).toBe(true);
  });

  it("places undated keys behind dated ones, like the order does", () => {
    const undated = attentionSortKey(candidate({ messageId: "a", sentAt: null, asksReply: true }));
    const dated = attentionSortKey(
      candidate({ messageId: "z", sentAt: new Date("2001-01-01T00:00:00Z"), asksReply: true }),
    );
    expect(attentionKeyAfter(undated, dated)).toBe(true);
    expect(attentionKeyAfter(dated, undated)).toBe(false);
  });
});
