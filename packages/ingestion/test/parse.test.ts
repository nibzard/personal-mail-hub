import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMime } from "../src/parse.ts";
import {
  DECODED_FOOBAR,
  DECODED_SPAM,
  duplicateContentIdMessage,
  mime,
  nestedMessage,
  nulMessage,
  singlePartPdf,
  standardMessage,
} from "./fixtures.ts";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("parseMime", () => {
  it("normalizes headers of an ordinary message", async () => {
    const parsed = await parseMime(standardMessage());

    expect(parsed.messageId).toBe("<quarterly@example.com>");
    expect(parsed.inReplyTo).toBe("<parent@example.com>");
    expect(parsed.referenceIds).toEqual(["<root@example.com>", "<parent@example.com>"]);
    expect(parsed.sender).toEqual({ address: "alice@example.com", name: "Alice Sender" });
    expect(parsed.replyTo).toEqual([{ address: "replies@example.com", name: null }]);
    expect(parsed.recipients).toEqual({
      to: [
        { address: "bob@example.com", name: "Bob" },
        { address: "carol@example.com", name: null },
      ],
      cc: [{ address: "dave@example.com", name: "Dave" }],
    });
    expect(parsed.subject).toBe("Quarterly report");
    expect(parsed.sentAt).toEqual(new Date("2026-09-07T10:15:00.000Z"));
    expect(parsed.textPlain).toBe("Numbers look great.");
    expect(parsed.html).toContain("Numbers look");
  });

  it("locates the attachment of a multipart message at /2 with verified bytes", async () => {
    const parsed = await parseMime(standardMessage());

    expect(parsed.attachments).toHaveLength(1);
    const part = parsed.attachments[0]!;
    expect(part.partPath).toBe("/2");
    expect(part.filename).toBe("report.pdf");
    expect(part.contentType).toBe("application/pdf");
    expect(part.disposition).toBe("attachment");
    expect(part.contentId).toBeNull();
    expect(part.sizeBytes).toBe(6);
    expect(new Uint8Array(part.content)).toEqual(DECODED_FOOBAR);
    expect(part.decodedSha256).toBe(sha256Hex(DECODED_FOOBAR));
  });

  it("addresses a single-part message body as the root", async () => {
    const parsed = await parseMime(singlePartPdf());

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.partPath).toBe("/");
    expect(parsed.attachments[0]!.sizeBytes).toBe(6);
    expect(parsed.textPlain).toBeNull();
  });

  it("continues locators below an embedded message payload", async () => {
    const parsed = await parseMime(nestedMessage());

    const paths = parsed.attachments.map((part) => [part.partPath, part.contentType] as const);
    expect(paths).toEqual([
      ["/2", "message/rfc822"],
      ["/2/1/2", "application/pdf"],
    ]);
    const wrapper = parsed.attachments[0]!;
    expect(wrapper.filename).toBeNull();
    expect(wrapper.disposition).toBeNull();
    const innerPdf = parsed.attachments[1]!;
    expect(innerPdf.filename).toBe("doc.pdf");
    expect(innerPdf.contentId).toBe("pdf1@inner");
    expect(innerPdf.decodedSha256).toBe(sha256Hex(DECODED_FOOBAR));
  });

  it("keeps both parts of duplicate Content-ID values on distinct locators", async () => {
    const parsed = await parseMime(duplicateContentIdMessage());

    expect(parsed.attachments.map((part) => part.contentId)).toEqual(["same@x", "same@x"]);
    expect(parsed.attachments.map((part) => part.partPath)).toEqual(["/2", "/3"]);
    expect(parsed.attachments[0]!.decodedSha256).toBe(sha256Hex(DECODED_FOOBAR));
    expect(parsed.attachments[1]!.decodedSha256).toBe(sha256Hex(DECODED_SPAM));
  });

  it("distinguishes an absent Reply-To from an invalid one", async () => {
    const absent = await parseMime(mime(["From: a@example.com", "Subject: t", "", "body"]));
    expect(absent.replyTo).toBeNull();

    const invalid = await parseMime(
      mime(["From: a@example.com", "Reply-To: not an address <<<", "Subject: t", "", "body"]),
    );
    expect(invalid.replyTo).toEqual([]);
  });

  it("keeps sentAt null for unreadable dates and missing identifiers absent", async () => {
    const parsed = await parseMime(
      mime(["From: a@example.com", "Subject: t", "Date: not a date", "", "body"]),
    );
    expect(parsed.sentAt).toBeNull();

    const bare = await parseMime(mime(["From: a@example.com", "Subject: t", "", "body"]));
    expect(bare.messageId).toBeNull();
    expect(bare.inReplyTo).toBeNull();
    expect(bare.referenceIds).toEqual([]);
  });

  it("drops invalid addresses from sender and recipients", async () => {
    const parsed = await parseMime(
      mime(["From: broken address", "To: good@example.com, bad address", "Subject: t", "", "body"]),
    );
    expect(parsed.sender).toBeNull();
    expect(parsed.recipients).toEqual({ to: [{ address: "good@example.com", name: null }] });
  });

  it("replaces NUL in every derived value and keeps the decoded bytes", async () => {
    const parsed = await parseMime(nulMessage());

    // Every value the database stores carries the replacement character
    // exactly where the NUL stood, and no NUL anywhere (T105).
    expect(parsed.subject).toBe("raw\uFFFDnul and encoded\uFFFDnul");
    expect(parsed.messageId).toBe("<msg\uFFFDid@example.com>");
    expect(parsed.inReplyTo).toBe("<parent\uFFFDref@example.com>");
    expect(parsed.referenceIds).toEqual(["<root@example.com>", "<parent\uFFFDref@example.com>"]);
    expect(parsed.sender).toEqual({ address: "nul@example.com", name: "Name\uFFFDX" });
    expect(parsed.textPlain).toContain("body\uFFFDnul");
    expect(parsed.attachments).toHaveLength(1);
    const part = parsed.attachments[0]!;
    expect(part.filename).toBe("file\uFFFDname.pdf");
    expect(part.decodedSha256).toBe(sha256Hex(DECODED_FOOBAR));
    expect(JSON.stringify(parsed)).not.toContain("\\u0000");
  });

  it("keeps an address with a decoded NUL invalid instead of sanitizing it valid", async () => {
    // The encoded word decodes after address tokenization, so the NUL
    // survives inside the address token itself. Validation must reject it —
    // never strip a byte and turn an invalid address into a valid one — so
    // the message imports without a sender (T105).
    const parsed = await parseMime(
      mime([
        "From: =?utf-8?Q?a=00b@example.com?=",
        "To: Bob <bob@example.com>",
        "Subject: Poisoned address",
        "Date: Mon, 07 Sep 2026 15:00:00 +0000",
        "Message-ID: <poisoned-address@example.com>",
        "",
        "body",
      ]),
    );

    expect(parsed.sender).toBeNull();
    expect(parsed.recipients).toEqual({ to: [{ address: "bob@example.com", name: "Bob" }] });
    expect(parsed.subject).toBe("Poisoned address");
    expect(JSON.stringify(parsed.sender)).not.toContain("\\u0000");
  });

  it("keeps valid Unicode unchanged while replacing the NUL beside it", async () => {
    const nul = String.fromCharCode(0);
    const replacement = String.fromCharCode(0xfffd);
    const parsed = await parseMime(
      mime([
        "From: Grüße <g@example.com>",
        "Subject: Gemüse" + nul + "tag",
        "Date: Mon, 07 Sep 2026 15:05:00 +0000",
        "Message-ID: <unicode@example.com>",
        "",
        "Sehr gut.",
      ]),
    );

    expect(parsed.subject).toBe("Gemüse" + replacement + "tag");
    expect(parsed.sender).toEqual({ address: "g@example.com", name: "Grüße" });
    expect(parsed.textPlain).toBe("Sehr gut.\n");
  });
});
