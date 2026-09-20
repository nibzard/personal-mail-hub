import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMime } from "@mail-hub/ingestion";
import { composeOutboundMime, renderMarkdownHtml } from "../src/index.ts";
import type { OutboundMimeInput } from "../src/index.ts";

/**
 * Exact MIME bytes and the HTML alternative (SPEC F6 and F7 step 2). Every
 * composition is parsed back with the reader's own parser: what the reader
 * would show must be what the sender meant.
 */

const IDENTITY = { address: "user@example.com", name: "Main User" };

const BASE: OutboundMimeInput = {
  identity: IDENTITY,
  to: [{ address: "to@example.com", name: null }],
  cc: [{ address: "cc@example.com", name: "Copy Cat" }],
  subject: "One exact message",
  markdown: "# Greeting\n\nWorld **bold**.",
  html: renderMarkdownHtml("# Greeting\n\nWorld **bold**."),
  rfcMessageId: "<fixed-id@example.com>",
  date: new Date("2026-09-07T10:00:00.000Z"),
  inReplyTo: null,
  referenceIds: [],
  attachments: [],
};

describe("the HTML alternative", () => {
  it("renders Markdown without passing raw HTML through", () => {
    const html = renderMarkdownHtml("<script>alert(1)</script>\n\n# Head");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<h1>Head</h1>");
  });

  it("wraps the body in the minimal inline-CSS template", () => {
    const html = renderMarkdownHtml("Paragraph.");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('style="font-family:');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("<script>");
  });
});

describe("MIME composition", () => {
  it("builds one alternative body that parses back to the same message", async () => {
    const bytes = await composeOutboundMime(BASE);
    const text = Buffer.from(bytes).toString("utf8");

    expect(text).toContain("multipart/alternative");
    expect(text).not.toContain("multipart/mixed");
    // Blind-copy recipients are excluded by construction; none were passed.
    expect(text.toLowerCase()).not.toContain("bcc");

    const parsed = await parseMime(bytes);
    expect(parsed.messageId).toBe(BASE.rfcMessageId);
    expect(parsed.subject).toBe(BASE.subject);
    expect(parsed.textPlain).toContain("World **bold**.");
    expect(parsed.html).toContain("<h1>Greeting</h1>");
    expect(parsed.sender).toEqual({ address: IDENTITY.address, name: IDENTITY.name });
    expect(parsed.attachments).toHaveLength(0);
    expect(Math.abs((parsed.sentAt ?? new Date(0)).getTime() - BASE.date.getTime())).toBeLessThan(1500);
  });

  it("carries reply headers verbatim", async () => {
    const bytes = await composeOutboundMime({
      ...BASE,
      inReplyTo: "<parent@example.com>",
      referenceIds: ["<first@example.com>", "<second@example.com>"],
    });
    const parsed = await parseMime(bytes);

    expect(parsed.inReplyTo).toBe("<parent@example.com>");
    expect(parsed.referenceIds).toEqual(["<first@example.com>", "<second@example.com>"]);
  });

  it("wraps the alternative in one mixed part per attachment", async () => {
    const content = new TextEncoder().encode("attachment bytes");
    const bytes = await composeOutboundMime({
      ...BASE,
      attachments: [{ filename: "notes.txt", contentType: "text/plain", content }],
    });
    const text = Buffer.from(bytes).toString("utf8");

    expect(text).toContain("multipart/mixed");
    expect(text).toContain("multipart/alternative");

    const parsed = await parseMime(bytes);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: content.byteLength,
      decodedSha256: createHash("sha256").update(content).digest("hex"),
    });
  });

  it("renders an empty body with an empty plain part ahead of the HTML", async () => {
    const bytes = await composeOutboundMime({ ...BASE, markdown: "", html: renderMarkdownHtml("") });
    const text = Buffer.from(bytes).toString("utf8");
    const parsed = await parseMime(bytes);

    // The plain part stays verbatim — zero bytes, nothing padded in — and
    // stays first, the order multipart/alternative prescribes, so every
    // reader keeps a plain choice even for an empty body.
    expect(text).toContain("text/plain");
    expect(text.indexOf("text/plain")).toBeLessThan(text.indexOf("text/html"));
    expect(parsed.textPlain ?? "").toBe("");
    expect(parsed.html).toContain("<!doctype html>");
    expect(parsed.attachments).toHaveLength(0);
  });
});
