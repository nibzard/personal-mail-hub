/**
 * The shared malformed-mail corpus (T109).
 *
 * Every fixture is one incident class reduced to synthetic bytes: raw and
 * decoded NUL, missing or malformed headers, folded references, nested
 * address metadata, and attachment metadata edge shapes. Fixtures are plain
 * strings — header lines and body, CRLF-joined — so the fake mailbox loads
 * them directly and `malformedMailBytes` turns them into complete MIME for
 * parser and wire boundaries.
 *
 * Reducing an incident into a fixture:
 *
 * 1. Take the smallest byte shape that reproduced the incident. Strip every
 *    fact about the sender, the recipient, the provider, and the mailbox.
 * 2. Replace remaining real values with `example.net` domains and invented
 *    local parts. Never commit raw provider mail, and never copy private
 *    log parameters — URLs, hostnames, token fragments — into a fixture.
 * 3. Keep bytes deterministic: fixed dates, fixed identifiers, no random
 *    values, so hashes and snapshots stay stable.
 * 4. State in the docblock which behavior the fixture pins, and add the
 *    boundary assertions beside the existing ones for that boundary.
 * 5. Prove the fixture has teeth: revert the fix it guards and watch a test
 *    fail. A fixture no failing mutation catches is vacuous.
 *
 * All fixtures are valid UTF-8 strings, because every transport in the test
 * stack round-trips messages through JavaScript strings before encoding.
 */

/** One malformed-mail fixture: raw header lines and the body, CRLF-joined. */
export interface MalformedMail {
  /** Header block exactly as a header fetch would return it. */
  headers: string;
  /** Everything after the blank line. */
  body: string;
}

/**
 * One NUL character, built so this file carries no literal control byte.
 * A source file with a raw `0x00` inside reads as truncated in editors and
 * diffs, so every fixture spells the byte out instead.
 */
const NUL = String.fromCharCode(0);

/** The complete MIME bytes of one fixture: headers, blank line, body. */
export function malformedMailBytes(mail: MalformedMail): Uint8Array {
  return new TextEncoder().encode(`${mail.headers}\r\n\r\n${mail.body}`);
}

/**
 * The NUL incident in one message (docs/sync-repair-plan.md T105): raw NUL
 * in the subject, Message-ID, In-Reply-To, and References; Q-encoded NUL
 * (`=00`) in the display name, the body text, and the attachment filename.
 * Derived values must replace every NUL with U+FFFD; the stored original
 * keeps its raw bytes and hash.
 */
export function nulEverywhere(): MalformedMail {
  return {
    headers: [
      "From: =?utf-8?Q?Name=00X?= <nul@example.com>",
      "To: Bob <bob@example.com>",
      `Subject: raw${NUL}nul and =?utf-8?Q?encoded=00nul?=`,
      "Date: Mon, 07 Sep 2026 10:15:00 +0000",
      `Message-ID: <msg${NUL}id@example.com>`,
      `In-Reply-To: <parent${NUL}ref@example.com>`,
      `References: <root@example.com> <parent${NUL}ref@example.com>`,
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=MIX",
    ].join("\r\n"),
    body: [
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
  };
}

/**
 * The parent the fixture above replies to: its Message-ID carries the same
 * raw NUL, so both sides of the link sanitize to the same stored identifier
 * and thread linking must still match them.
 */
export function nulParent(): MalformedMail {
  return {
    headers: [
      "From: Root Writer <root@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Parent with a raw nul",
      "Date: Mon, 07 Sep 2026 10:14:00 +0000",
      `Message-ID: <parent${NUL}ref@example.com>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "Parent body.",
  };
}

/**
 * One neighbor whose address tokens carry Q-encoded NUL: the decoded NUL
 * survives address tokenization, so validation must keep the address
 * invalid — dropped, never sanitized into a valid one — while the message
 * still imports.
 */
export function nulAddressNeighbor(): MalformedMail {
  return {
    headers: [
      "From: =?utf-8?Q?a=00b@example.com?=",
      "To: =?utf-8?Q?c=00d@example.com?=",
      "Subject: Neighbor with poisoned addresses",
      "Date: Mon, 07 Sep 2026 10:16:00 +0000",
      "Message-ID: <neighbor@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "Neighbor body.",
  };
}

/**
 * A NUL that arrives base64-encoded, the encoding path quoted-printable
 * does not cover: the part decodes to `x`, `0x00`, `y`, so the derived body
 * text must carry `x�y` while the decoded bytes keep the `0x00`.
 */
export function base64NulBody(): MalformedMail {
  return {
    headers: [
      "From: Encoder <encoder@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Base64 nul body",
      "Date: Mon, 07 Sep 2026 10:17:00 +0000",
      "Message-ID: <base64-nul@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ].join("\r\n"),
    // base64("x\0y") === "eAB5".
    body: "eAB5",
  };
}

/** One message missing exactly one required header, for per-field behavior. */
export function missingHeader(field: "from" | "subject" | "message-id" | "date" | "to"): MalformedMail {
  const lines = new Map<string, string>([
    ["from", "From: Present <present@example.com>"],
    ["subject", "Subject: Subject present"],
    ["message-id", "Message-ID: <present-id@example.com>"],
    ["date", "Date: Mon, 07 Sep 2026 10:18:00 +0000"],
    ["to", "To: Bob <bob@example.com>"],
  ]);
  lines.delete(field);
  return {
    headers: [...lines.values(), "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"].join("\r\n"),
    body: `Body of the message without ${field}.`,
  };
}

/**
 * Malformed header shapes in one block: an unparseable date, a line with no
 * colon, and a subject continued by a whitespace-only folding line. The
 * parser must answer rather than throw, the date must import as absent, and
 * the subject must survive the folding without the empty line's noise.
 */
export function malformedHeaderLines(): MalformedMail {
  return {
    headers: [
      "From: Malformed <malformed@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Folded subject",
      "\t",
      "This line has no colon",
      "Date: not a date at all",
      "Message-ID: <malformed-lines@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "Body of the malformed-lines message.",
  };
}

/**
 * A reply whose `References` and `In-Reply-To` arrive folded across
 * continuation lines — leading-space folding on References, leading-tab
 * folding on In-Reply-To. Unfolding must rebuild the full identifier list,
 * and thread reconciliation must link the reply to its parent through the
 * folded reference.
 */
export function foldedReferencesReply(): MalformedMail {
  return {
    headers: [
      "From: Folder <folder@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Re: Folded thread",
      "Date: Mon, 07 Sep 2026 10:20:00 +0000",
      "Message-ID: <folded-reply@example.com>",
      "In-Reply-To:",
      "\t<folded-parent@example.com>",
      "References: <folded-root@example.com>",
      " <folded-mid@example.com>",
      " <folded-parent@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "The reply with folded references.",
  };
}

/** The parent the folded reply points at, with a plain unfolded header. */
export function foldedReferencesParent(): MalformedMail {
  return {
    headers: [
      "From: Folder <folder@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Folded thread",
      "Date: Mon, 07 Sep 2026 10:19:00 +0000",
      "Message-ID: <folded-parent@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "The parent of the folded reply.",
  };
}

/**
 * Nested address metadata: a group in `To`, a display name with a comment,
 * a quoted display name with an escaped quote, an encoded word that carries
 * both a language tag and a Q-encoded NUL, and a second address object in
 * `Cc`. Flattening must keep every valid address in order, replace the NUL
 * in the decoded name, and drop the tokens that never were addresses.
 */
export function nestedAddressMetadata(): MalformedMail {
  return {
    headers: [
      "From: \"Quoted \\\"Name\\\"\" <quoted@example.com>",
      "To: Team: alice@example.com, =?utf-8*en?Q?Team=00Member?= <member@example.com>;",
      "Cc: Ed (the editor) <ed@example.com>, carol@example.com",
      "Reply-To: Replies: r1@example.com, r2@example.com;",
      "Subject: Nested address metadata",
      "Date: Mon, 07 Sep 2026 10:21:00 +0000",
      "Message-ID: <nested-addresses@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "Body of the nested-address message.",
  };
}

/** Known decoded bytes of each attachment part, for hash assertions. */
export const ATTACHMENT_EDGE_PARTS = [
  { marker: "extended-filename-part", filename: "nähme.txt" },
  { marker: "continued-filename-part", filename: "continued-name.bin" },
  { marker: "nameless-part", filename: null },
  { marker: "", filename: "empty.bin" },
  { marker: "inline-no-cid-part", filename: "inline.png" },
] as const;

/**
 * Attachment metadata edges: an RFC 2231 extended filename with non-ASCII
 * percent-escapes, an RFC 2231 continued filename split over two
 * parameters, a part with no filename at all, a zero-byte part, and an
 * inline part without a Content-ID. Filenames must decode, hashes must
 * cover the decoded bytes, and the empty part must store with size zero.
 */
export function attachmentEdgeMetadata(): MalformedMail {
  return {
    headers: [
      "From: Attacher <attacher@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Attachment metadata edges",
      "Date: Mon, 07 Sep 2026 10:22:00 +0000",
      "Message-ID: <attachment-edges@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=EDGES",
    ].join("\r\n"),
    body: [
      "--EDGES",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Parts with edge metadata follow.",
      "--EDGES",
      "Content-Type: text/plain",
      "Content-Disposition: attachment; filename*=utf-8''n%C3%A4hme.txt",
      "Content-Transfer-Encoding: base64",
      "",
      base64Of("extended-filename-part"),
      "--EDGES",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment;",
      " filename*0=continued-;",
      " filename*1=name.bin",
      "Content-Transfer-Encoding: base64",
      "",
      base64Of("continued-filename-part"),
      "--EDGES",
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "",
      base64Of("nameless-part"),
      "--EDGES",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment; filename=empty.bin",
      "Content-Transfer-Encoding: base64",
      "",
      "",
      "--EDGES",
      "Content-Type: image/png",
      "Content-Disposition: inline; filename=inline.png",
      "Content-Transfer-Encoding: base64",
      "",
      base64Of("inline-no-cid-part"),
      "--EDGES--",
      "",
    ].join("\r\n"),
  };
}

/**
 * A valid neighbor with non-ASCII text everywhere the eye lands: a UTF-8
 * display name, a raw UTF-8 subject, and body text with CJK, an emoji, and
 * a combining accent. Nothing here is malformed; every derived value must
 * keep these characters byte-for-byte, with no replacement character added.
 */
export function validUnicodeNeighbor(): MalformedMail {
  return {
    headers: [
      "From: Grüße <gruesse@example.com>",
      "To: 日本語 <nihongo@example.com>",
      "Subject: Zusammenfassung — Prüfung",
      "Date: Mon, 07 Sep 2026 10:23:00 +0000",
      "Message-ID: <unicode-neighbor@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "Café 日本語 🌊 stays as written.",
  };
}

/** A boring valid neighbor: ASCII throughout, nothing to sanitize. */
export function plainValidNeighbor(): MalformedMail {
  return {
    headers: [
      "From: Plain Sender <plain@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Plain neighbor",
      "Date: Mon, 07 Sep 2026 10:24:00 +0000",
      "Message-ID: <plain-neighbor@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
    ].join("\r\n"),
    body: "Plain body.",
  };
}

/** Base64 without line wrapping; corpus markers stay short. */
function base64Of(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
