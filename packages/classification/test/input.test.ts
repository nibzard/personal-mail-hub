import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_INPUT_CHARS, MAX_SENDER_CHARS, MAX_SUBJECT_CHARS, minimizeMessageInput, stripQuotedChains, type MessageInputSource } from "../src/index.ts";

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

  it("bounds the whole text when the header fields alone overflow the window", () => {
    // A folded subject and a long display name arrive from the wire with no
    // length bound; the composed text must still respect the window the
    // token estimate assumes.
    const input = minimizeMessageInput({
      senderText: `${"n".repeat(MAX_INPUT_CHARS * 3)} <s@x.example>`,
      subject: `${"u".repeat(MAX_INPUT_CHARS * 3)}`,
      bodyText: `${"b".repeat(MAX_INPUT_CHARS * 3)}`,
    });
    expect(input.text.length).toBe(MAX_INPUT_CHARS);
    expect(input.truncated).toBe(true);
    expect(input.text.startsWith(`From: ${"n".repeat(MAX_SENDER_CHARS)}\n`)).toBe(true);
    expect(input.text).toContain(`Subject: ${"u".repeat(MAX_SUBJECT_CHARS)}`);
    expect(input.text.endsWith("bbb")).toBe(true);
  });

  it("cuts an oversized header field and reports it with a short body", () => {
    const input = minimizeMessageInput({
      senderText: "Sam Rivera <sam@personal.example>",
      subject: `${"s".repeat(MAX_SUBJECT_CHARS + 10)}`,
      bodyText: "Short body.",
    });
    expect(input.truncated).toBe(true);
    expect(input.text).toBe(
      `From: Sam Rivera <sam@personal.example>\nSubject: ${"s".repeat(MAX_SUBJECT_CHARS)}\n\nShort body.`,
    );
    expect(input.inputHash).toBe(createHash("sha256").update(input.text, "utf8").digest("hex"));
  });

  it("composes without throwing on pathological wire text", () => {
    // Whatever the wire delivered — absent fields, split surrogates, fields
    // several windows long — the composer may neither throw nor index past
    // its slice, and the composed text stays inside the window.
    const inputs: MessageInputSource[] = [
      { senderText: "", subject: null, bodyText: null },
      { senderText: "\uD83D", subject: "😀\uD83D", bodyText: "\uD800" },
      {
        senderText: "a".repeat(MAX_INPUT_CHARS * 3),
        subject: "b".repeat(MAX_INPUT_CHARS * 3),
        bodyText: "c".repeat(MAX_INPUT_CHARS * 3),
      },
    ];
    for (const source of inputs) {
      const input = minimizeMessageInput(source);
      expect(input.text.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
      expect(input.inputHash).toHaveLength(64);
    }
  });
});
