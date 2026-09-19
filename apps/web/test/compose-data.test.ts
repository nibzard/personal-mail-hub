// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  formatRecipientList,
  invalidAddresses,
  newSendIdempotencyKey,
  parseRecipientList,
  recipientCount,
} from "../src/mail/compose-data.ts";

/*
 * The pure helpers of the compose data layer (SPEC F6): recipient lines
 * parse and format round-trip, rough validation names the entries a person
 * must correct, and every deliberate send earns its own idempotency key.
 */

describe("parseRecipientList", () => {
  it("splits on commas and semicolons and drops empties", () => {
    expect(parseRecipientList("a@example.com, b@example.com;;  ,c@example.com")).toEqual([
      { address: "a@example.com", name: null },
      { address: "b@example.com", name: null },
      { address: "c@example.com", name: null },
    ]);
  });

  it("reads a display name in angle brackets", () => {
    expect(parseRecipientList("Sam Rivera <sam@example.com>")).toEqual([
      { address: "sam@example.com", name: "Sam Rivera" },
    ]);
    expect(parseRecipientList("<bare@example.com>")).toEqual([
      { address: "bare@example.com", name: null },
    ]);
  });

  it("keeps an unparseable entry verbatim for validation to name", () => {
    expect(parseRecipientList("not an address")).toEqual([
      { address: "not an address", name: null },
    ]);
  });

  it("round-trips through formatRecipientList", () => {
    const line = "Sam Rivera <sam@example.com>, bare@example.com";
    expect(formatRecipientList(parseRecipientList(line))).toBe(line);
  });
});

describe("invalidAddresses", () => {
  it("names the entries without an address shape", () => {
    const parsed = parseRecipientList("a@example.com, oops, b@example.com");
    expect(invalidAddresses(parsed)).toEqual(["oops"]);
  });

  it("accepts every plain address shape", () => {
    expect(invalidAddresses(parseRecipientList("a.b+c@example.co.uk"))).toEqual([]);
  });
});

describe("recipientCount", () => {
  it("sums to, cc, and bcc", () => {
    expect(
      recipientCount({
        to: parseRecipientList("a@example.com"),
        cc: parseRecipientList("b@example.com, c@example.com"),
        bcc: parseRecipientList("d@example.com"),
      }),
    ).toBe(4);
  });

  it("treats absent lists as empty", () => {
    expect(recipientCount({ to: parseRecipientList("a@example.com") })).toBe(1);
  });
});

describe("newSendIdempotencyKey", () => {
  it("never repeats within one session", () => {
    const keys = new Set(Array.from({ length: 64 }, () => newSendIdempotencyKey()));
    expect(keys.size).toBe(64);
  });
});
