import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import {
  base64Lines,
  buildMessage,
  duplicateContentIdMessage,
  duplicateNotificationPair,
  identicalAttachmentPairMessage,
  MALICIOUS_HTML,
  maliciousHtmlMessage,
  nestedRfc822Message,
  orphanReplyMessage,
  oversizedAttachmentMessage,
  replyChain,
  replyToDiffersMessage,
  reusedMessageIdPair,
} from "../src/index.ts";

/**
 * The message fixtures under the parser the reader uses (SPEC section 12).
 *
 * Each fixture must hold the property its scenario depends on: exact
 * attachment shapes, duplicate identifiers that stay duplicates on the wire,
 * reply threading headers that chain or dangle, and malicious HTML that
 * survives transport unchanged so sanitizing has something to remove.
 */

const CRLF = "\r\n";

describe("message fixtures", () => {
  it("builds a plain message with whole headers and body", async () => {
    const bytes = buildMessage({ subject: "Plain", text: "Body line.\r\n" });
    const parsed = await simpleParser(bytes);
    expect(parsed.subject).toBe("Plain");
    expect(parsed.text).toBe("Body line.\n");
    expect(parsed.attachments).toHaveLength(0);
    // CRLF line endings throughout: the wire shape, not the platform's.
    expect(bytes.includes(CRLF)).toBe(true);
    expect(bytes.includes("\n\n")).toBe(false);
  });

  it("builds the same bytes twice: fixtures are deterministic", () => {
    const first = maliciousHtmlMessage();
    const second = maliciousHtmlMessage();
    expect(Buffer.compare(first, second)).toBe(0);
  });

  it("carries the hostile HTML whole in the html part", async () => {
    const parsed = await simpleParser(maliciousHtmlMessage());
    expect(parsed.html).toContain("<script>alert('script body')</script>");
    expect(parsed.html).toContain("https://tracker.example/pixel.gif");
    expect(parsed.html).toContain("javascript:alert('link')");
    expect(parsed.html).toContain("<iframe src=\"https://tracker.example/frame\"");
    expect(parsed.html).toContain("<form action=\"https://tracker.example/harvest\"");
    // Every hostile construct of the constant is on the wire.
    for (const line of MALICIOUS_HTML.split(CRLF)) {
      if (line.trim() !== "") {
        expect(parsed.html).toContain(line.trim());
      }
    }
  });

  it("wraps base64 in 76-character lines", () => {
    const marker = Buffer.alloc(300, 0x61);
    for (const line of base64Lines(marker).split(CRLF)) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(Buffer.from(base64Lines(marker), "base64").equals(marker)).toBe(true);
  });

  it("gives the identical pair one name but different bytes", async () => {
    const parsed = await simpleParser(identicalAttachmentPairMessage());
    expect(parsed.attachments).toHaveLength(2);
    const [first, second] = parsed.attachments;
    expect(first?.filename).toBe("report.pdf");
    expect(second?.filename).toBe("report.pdf");
    expect(first?.contentType).toBe("application/pdf");
    // Same decoded size, same name, different bytes: the dedupe trap.
    expect(first?.content.length).toBe(second?.content.length);
    expect(first?.content.equals(second?.content ?? Buffer.alloc(0))).toBe(false);
    expect(first?.content.subarray(0, 12).toString("utf8")).toBe("first-report");
  });

  it("keeps both parts of a duplicate Content-ID pair", async () => {
    const parsed = await simpleParser(duplicateContentIdMessage());
    expect(parsed.attachments).toHaveLength(2);
    for (const attachment of parsed.attachments) {
      expect(attachment.cid).toBe("chart@harness");
    }
    const [first, second] = parsed.attachments;
    expect(first?.content.equals(second?.content ?? Buffer.alloc(0))).toBe(false);
    // The html references the identifier the inline parts answer to. The
    // parser inlines it as a data URI, so the reference lives in the bytes.
    expect(duplicateContentIdMessage().toString("utf8")).toContain('src="cid:chart@harness"');
  });

  it("wraps a complete inner message with its own attachment", async () => {
    const parsed = await simpleParser(nestedRfc822Message());
    expect(parsed.subject).toBe("FW: signed form");
    const inner = parsed.attachments.find((attachment) => attachment.contentType === "message/rfc822");
    expect(inner).toBeDefined();
    // The wrapped part is one whole, parseable message of its own.
    const innerParsed = await simpleParser(inner!.content);
    expect(innerParsed.subject).toBe("Inner: signed form");
    const innerForm = innerParsed.attachments.find((attachment) => attachment.filename === "signed-form.pdf");
    expect(innerForm).toBeDefined();
    expect(innerForm!.content.length).toBe(128);
  });

  it("sizes the oversized attachment as asked", async () => {
    const parsed = await simpleParser(oversizedAttachmentMessage(4096));
    expect(parsed.attachments[0]!.content.length).toBe(4096);
    // The default target matches the SPEC oversized-attachment bound.
    expect(oversizedAttachmentMessage().length).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("returns byte-identical duplicates, as notifications deliver", () => {
    const [first, second] = duplicateNotificationPair();
    expect(Buffer.compare(first, second)).toBe(0);
  });

  it("returns one identifier under two different bodies", async () => {
    const [first, second] = reusedMessageIdPair();
    const parsedFirst = await simpleParser(first);
    const parsedSecond = await simpleParser(second);
    expect(parsedFirst.messageId).toBe("<shared-1@example.net>");
    expect(parsedSecond.messageId).toBe("<shared-1@example.net>");
    expect(parsedFirst.subject).not.toBe(parsedSecond.subject);
    expect(parsedFirst.text).not.toBe(parsedSecond.text);
  });

  it("threads the reply chain through its identifiers", async () => {
    const chain = replyChain();
    const root = await simpleParser(chain[0]!);
    const reply = await simpleParser(chain[1]!);
    const replyToReply = await simpleParser(chain[2]!);
    expect(root.inReplyTo).toBeFalsy();
    expect(reply.inReplyTo).toBe("<chain-root@example.net>");
    expect(replyToReply.inReplyTo).toBe("<chain-reply@example.net>");
    // One reference arrives as a string, several as an array; read both.
    const asList = (value: string | string[] | undefined): string[] =>
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    expect(asList(reply.references)).toEqual(["<chain-root@example.net>"]);
    expect(asList(replyToReply.references)).toEqual(["<chain-root@example.net>", "<chain-reply@example.net>"]);
    // The subjects chain the conventional way.
    expect(reply.subject).toBe("Re: Launch plan");
    expect(replyToReply.subject).toBe("Re: Launch plan");
  });

  it("points the orphan reply at a parent no fixture holds", async () => {
    const parsed = await simpleParser(orphanReplyMessage());
    const chainIds = await Promise.all(
      replyChain().map(async (bytes) => (await simpleParser(bytes)).messageId),
    );
    expect(parsed.inReplyTo).toBe("<never-delivered@example.net>");
    expect(chainIds).not.toContain(parsed.inReplyTo);
  });

  it("differs the Reply-To from the sender", async () => {
    const parsed = await simpleParser(replyToDiffersMessage());
    expect(parsed.from?.value[0]?.address).toBe("news@example.net");
    expect(parsed.replyTo?.value[0]?.address).toBe("editor@example.net");
  });
});
