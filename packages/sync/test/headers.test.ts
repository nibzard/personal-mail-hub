import { describe, expect, it } from "vitest";
import {
  foldedReferencesReply,
  malformedHeaderLines,
  malformedMailBytes,
  missingHeader,
  nestedAddressMetadata,
  nulEverywhere,
  type MalformedMail,
} from "@mail-hub/harness";
import { parseMime } from "@mail-hub/ingestion";
import { parseHeaderBlock } from "../src/headers.ts";

/** Header-block fixtures for the header import. All lines CRLF, as fetched. */
function block(lines: string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
}

/** The header block of one corpus fixture, exactly as a fetch returns it. */
function headerBlock(mail: MalformedMail): Uint8Array {
  return new TextEncoder().encode(`${mail.headers}\r\n`);
}

/** Header lines whose derived text carries raw and Q-encoded NUL (T105). */
function nulHeaderLines(): string[] {
  return nulEverywhere().headers.split("\r\n");
}

/** The complete message those headers start, exactly as ingestion parses it. */
function nulMessage(): Uint8Array {
  return malformedMailBytes(nulEverywhere());
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

describe("parseHeaderBlock over the malformed corpus", () => {
  it("unfolds folded references into the full identifier list", async () => {
    const headers = await parseHeaderBlock(headerBlock(foldedReferencesReply()));

    // Folding is transport whitespace, not content: the identifiers rebuild
    // exactly as one unfolded line would parse, so linking still matches.
    expect(headers.inReplyTo).toBe("<folded-parent@example.com>");
    expect(headers.referenceIds).toEqual([
      "<folded-root@example.com>",
      "<folded-mid@example.com>",
      "<folded-parent@example.com>",
    ]);
  });

  it("flattens nested address metadata and keeps valid addresses in order", async () => {
    const headers = await parseHeaderBlock(headerBlock(nestedAddressMetadata()));

    expect(headers.sender).toEqual({ address: "quoted@example.com", name: 'Quoted "Name"' });
    expect(headers.recipients).toEqual({
      to: [
        { address: "alice@example.com", name: null },
        { address: "member@example.com", name: "Team�Member" },
      ],
      cc: [
        // The parser strips the RFC comment from the display name.
        { address: "ed@example.com", name: "Ed" },
        { address: "carol@example.com", name: null },
      ],
    });
    expect(headers.replyTo).toEqual([
      { address: "r1@example.com", name: null },
      { address: "r2@example.com", name: null },
    ]);
    // Address filter text holds participants: the sender and the recipient
    // lists, group members included, never the Reply-To instruction.
    expect(headers.addressesText).toBe(
      "quoted@example.com alice@example.com member@example.com ed@example.com carol@example.com",
    );
    expect(JSON.stringify(headers)).not.toContain("\\u0000");
  });

  it.each(["from", "subject", "message-id", "date", "to"] as const)(
    "imports a message whose %s header is missing, with the rest intact",
    async (field) => {
      const headers = await parseHeaderBlock(headerBlock(missingHeader(field)));

      // A missing header is absence, not a failure: the message imports with
      // that field absent and every other field derived as usual.
      switch (field) {
        case "from":
          expect(headers.sender).toBeNull();
          expect(headers.senderText).toBe("");
          expect(headers.subject).toBe("Subject present");
          break;
        case "subject":
          expect(headers.subject).toBeNull();
          expect(headers.subjectText).toBe("");
          expect(headers.sender).toEqual({ address: "present@example.com", name: "Present" });
          break;
        case "message-id":
          expect(headers.messageId).toBeNull();
          expect(headers.subject).toBe("Subject present");
          break;
        case "date":
          expect(headers.sentAt).toBeNull();
          expect(headers.messageId).toBe("<present-id@example.com>");
          break;
        case "to":
          expect(headers.recipients).toBeNull();
          expect(headers.recipientsText).toBe("");
          expect(headers.subject).toBe("Subject present");
          break;
      }
    },
  );

  it("keeps a garbage header line and an unreadable date contained", async () => {
    const headers = await parseHeaderBlock(headerBlock(malformedHeaderLines()));

    // The unparseable parts import as absent values; the readable headers
    // beside them still derive. Nothing escalates past the broken line.
    expect(headers.sentAt).toBeNull();
    expect(headers.messageId).toBe("<malformed-lines@example.com>");
    expect(headers.sender).toEqual({ address: "malformed@example.com", name: "Malformed" });
    expect(headers.subject).toBe("Folded subject");
    expect(JSON.stringify(headers)).not.toContain("\\u0000");
  });

  it.each([
    { name: "nulEverywhere", build: nulEverywhere },
    { name: "foldedReferencesReply", build: foldedReferencesReply },
    { name: "nestedAddressMetadata", build: nestedAddressMetadata },
    { name: "malformedHeaderLines", build: malformedHeaderLines },
  ])(
    "derives the same values as the full parse of the same corpus bytes ($name)",
    async ({ build }) => {
      const headers = await parseHeaderBlock(headerBlock(build()));
      const full = await parseMime(malformedMailBytes(build()));

      // A message must look identical before and after its body is fetched
      // (SPEC F2 identity rules), malformed input included: thread linking
      // matches either side by string equality.
      expect(headers.messageId).toBe(full.messageId);
      expect(headers.inReplyTo).toBe(full.inReplyTo);
      expect(headers.referenceIds).toEqual(full.referenceIds);
      expect(headers.sender).toEqual(full.sender);
      expect(headers.recipients).toEqual(full.recipients);
      expect(headers.subject).toBe(full.subject);
    },
  );
});
