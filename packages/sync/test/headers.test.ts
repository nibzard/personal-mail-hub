import { describe, expect, it } from "vitest";
import { parseMime } from "@mail-hub/ingestion";
import { parseHeaderBlock } from "../src/headers.ts";

/** Header-block fixtures for the header import. All lines CRLF, as fetched. */
function block(lines: string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
}

/** One NUL character, built so this file carries no literal control byte. */
const NUL = String.fromCharCode(0);

/** Header lines whose derived text carries raw and Q-encoded NUL (T105). */
function nulHeaderLines(): string[] {
  return [
    "From: =?utf-8?Q?Name=00X?= <nul@example.com>",
    "To: Bob <bob@example.com>",
    `Subject: raw${NUL}nul and =?utf-8?Q?encoded=00nul?=`,
    "Date: Mon, 07 Sep 2026 14:00:00 +0000",
    `Message-ID: <msg${NUL}id@example.com>`,
    `In-Reply-To: <parent${NUL}ref@example.com>`,
    `References: <root@example.com> <parent${NUL}ref@example.com>`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=MIX",
  ];
}

/** The complete message those headers start, exactly as ingestion parses it. */
function nulMessage(): Uint8Array {
  return new TextEncoder().encode(
    [
      ...nulHeaderLines(),
      "",
      "--MIX",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "body=00nul in the plain part",
      "--MIX",
      'Content-Type: application/pdf; name="=?utf-8?Q?file=00name.pdf?="',
      'Content-Disposition: attachment; filename="=?utf-8?Q?file=00name.pdf?="',
      "Content-Transfer-Encoding: base64",
      "",
      "Zm9vYmFy",
      "--MIX--",
      "",
    ].join("\r\n"),
  );
}

describe("parseHeaderBlock", () => {
  it("imports every field of one full header block", async () => {
    const headers = await parseHeaderBlock(
      block([
        "From: Alice Sender <alice@example.com>",
        "To: Bob <bob@example.com>, carol@example.com",
        "Cc: Dave <dave@example.com>",
        "Reply-To: replies@example.com",
        "Subject: Quarterly report",
        "Date: Mon, 07 Sep 2026 10:15:00 +0000",
        "Message-ID: <quarterly@example.com>",
        "In-Reply-To: <parent@example.com>",
        "References: <root@example.com> <parent@example.com>",
      ]),
    );

    // Identifiers keep their angle brackets, exactly as the full parse in
    // ingestion stores them, so linking works before and after the body fetch.
    expect(headers.messageId).toBe("<quarterly@example.com>");
    expect(headers.inReplyTo).toBe("<parent@example.com>");
    expect(headers.referenceIds).toEqual(["<root@example.com>", "<parent@example.com>"]);
    expect(headers.sender).toEqual({ address: "alice@example.com", name: "Alice Sender" });
    expect(headers.replyTo).toEqual([{ address: "replies@example.com", name: null }]);
    expect(headers.recipients).toEqual({
      to: [
        { address: "bob@example.com", name: "Bob" },
        { address: "carol@example.com", name: null },
      ],
      cc: [{ address: "dave@example.com", name: "Dave" }],
    });
    expect(headers.subject).toBe("Quarterly report");
    expect(headers.sentAt).toEqual(new Date("2026-09-07T10:15:00Z"));
    expect(headers.senderText).toBe("alice sender alice@example.com");
    expect(headers.recipientsText).toBe("bob bob@example.com carol@example.com dave dave@example.com");
    expect(headers.subjectText).toBe("quarterly report");
  });

  it("keeps an absent Reply-To distinct from an invalid one", async () => {
    const absent = await parseHeaderBlock(block(["From: a@example.com", "Subject: One"]));
    expect(absent.replyTo).toBeNull();

    const invalid = await parseHeaderBlock(
      block(["From: a@example.com", "Reply-To: not an address"]),
    );
    expect(invalid.replyTo).toEqual([]);
  });

  it("rejects garbage dates instead of trusting them", async () => {
    const headers = await parseHeaderBlock(
      block(["From: a@example.com", "Date: not a date at all"]),
    );
    expect(headers.sentAt).toBeNull();
  });

  it("imports an empty block with every field absent", async () => {
    const headers = await parseHeaderBlock(new Uint8Array(0));
    expect(headers.messageId).toBeNull();
    expect(headers.sender).toBeNull();
    expect(headers.recipients).toBeNull();
    expect(headers.referenceIds).toEqual([]);
    expect(headers.sentAt).toBeNull();
    expect(headers.senderText).toBe("");
  });

  it("never loses a message over an unreadable header block", async () => {
    // A lone continuation line cannot start a header; the parser must still
    // answer rather than throw, so the caller imports the occurrence.
    const headers = await parseHeaderBlock(new TextEncoder().encode(" garbage\r\n"));
    expect(headers).toBeDefined();
    expect(headers.subject).toBeNull();
  });

  it("replaces NUL in every derived header value", async () => {
    const headers = await parseHeaderBlock(block(nulHeaderLines()));

    expect(headers.subject).toBe("raw\uFFFDnul and encoded\uFFFDnul");
    expect(headers.messageId).toBe("<msg\uFFFDid@example.com>");
    expect(headers.inReplyTo).toBe("<parent\uFFFDref@example.com>");
    expect(headers.referenceIds).toEqual(["<root@example.com>", "<parent\uFFFDref@example.com>"]);
    expect(headers.sender).toEqual({ address: "nul@example.com", name: "Name\uFFFDX" });
    expect(headers.subjectText).toBe("raw\uFFFDnul and encoded\uFFFDnul");
    expect(headers.senderText).toBe("name\uFFFDx nul@example.com");
    expect(JSON.stringify(headers)).not.toContain("\\u0000");
  });

  it("derives the same values as the full parse of the same bytes", async () => {
    const headers = await parseHeaderBlock(block(nulHeaderLines()));
    const full = await parseMime(nulMessage());

    // A message must look identical before and after its body is fetched
    // (SPEC F2 identity rules), NUL included: thread linking matches either
    // side by string equality.
    expect(headers.messageId).toBe(full.messageId);
    expect(headers.inReplyTo).toBe(full.inReplyTo);
    expect(headers.referenceIds).toEqual(full.referenceIds);
    expect(headers.sender).toEqual(full.sender);
    expect(headers.recipients).toEqual(full.recipients);
    expect(headers.subject).toBe(full.subject);
  });
});
