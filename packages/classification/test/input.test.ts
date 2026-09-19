import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_INPUT_CHARS, minimizeMessageInput, stripQuotedChains } from "../src/index.ts";

/**
 * Input minimization acceptance (SPEC F8): sender, subject, and the first
 * slice of body text only; quoted chains stripped; the stored hash matches
 * the exact text sent.
 */

describe("quoted-chain stripping", () => {
  it("drops a replied chain from its first quoted line", () => {
    const body = "Thanks, that works.\n> original point\n> another point";
    expect(stripQuotedChains(body)).toBe("Thanks, that works.");
  });

  it("drops from an `On ... wrote:` boundary", () => {
    const body = "New answer.\nOn Tuesday, Sam wrote:\nold text";
    expect(stripQuotedChains(body)).toBe("New answer.");
  });

  it("drops from a forwarded-message header", () => {
    const body = "See below.\n-----Forwarded message-----\nFrom: someone";
    expect(stripQuotedChains(body)).toBe("See below.");
  });

  it("keeps text that carries no quote markers", () => {
    expect(stripQuotedChains("One line.\nAnother line.")).toBe("One line.\nAnother line.");
  });
});

describe("minimized input", () => {
  it("composes sender, subject, and stripped body, and hashes that text", () => {
    const input = minimizeMessageInput({
      senderText: "Sam Rivera <sam@personal.example>",
      subject: "Dinner",
      bodyText: "We booked the table.\n> earlier plan",
    });
    const expected = "From: Sam Rivera <sam@personal.example>\nSubject: Dinner\n\nWe booked the table.";
    expect(input.text).toBe(expected);
    expect(input.truncated).toBe(false);
    expect(input.inputHash).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
  });

  it("collapses whitespace and survives absent fields", () => {
    const input = minimizeMessageInput({ senderText: "", subject: null, bodyText: "  multiple   spaces\n\nlines " });
    expect(input.text).toBe("From: \nSubject: \n\nmultiple spaces lines");
  });

  it("truncates the body at the window edge and reports it", () => {
    const filler = "a".repeat(MAX_INPUT_CHARS * 2);
    const input = minimizeMessageInput({
      senderText: "s@x.example",
      subject: "long",
      bodyText: filler,
    });
    expect(input.text.length).toBe(MAX_INPUT_CHARS);
    expect(input.truncated).toBe(true);
    expect(input.text.startsWith("From: s@x.example\nSubject: long\n\n")).toBe(true);
  });
});
