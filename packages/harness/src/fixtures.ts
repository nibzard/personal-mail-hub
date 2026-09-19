/**
 * Message fixtures for the fake mailbox harness (SPEC section 12).
 *
 * Every builder returns complete MIME bytes with CRLF line endings, ready to
 * load into the scripted store or submit through the scripted SMTP server.
 * The set covers the scenarios the acceptance suites need: malicious HTML,
 * attachment edge cases, duplicate notifications, reused identifiers, and
 * reply chains with present, missing, and ambiguous parents. Deterministic
 * bytes throughout — no timestamps or randomness — so snapshots and hashes
 * stay stable.
 */

/** Headers and parts of one message under construction. */
export interface MessageSpec {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: string;
  /** Extra header lines, verbatim. */
  extraHeaders?: string[];
  text?: string;
  html?: string;
  attachments?: AttachmentSpec[];
}

/** One attachment part of a message under construction. */
export interface AttachmentSpec {
  filename?: string;
  contentType?: string;
  /** Raw bytes; they are base64-encoded on the wire. */
  bytes: Uint8Array;
  contentId?: string;
  disposition?: "attachment" | "inline";
}

/** Compose one complete message: headers, blank line, body. */
export function buildMessage(spec: MessageSpec): Buffer {
  const headers: string[] = [
    `From: ${spec.from ?? "Sender <sender@example.net>"}`,
    ...(spec.to === undefined ? [] : [`To: ${spec.to}`]),
    ...(spec.cc === undefined ? [] : [`Cc: ${spec.cc}`]),
    `Subject: ${spec.subject ?? "No subject"}`,
    `Date: ${spec.date ?? "Mon, 07 Sep 2026 10:00:00 +0000"}`,
    `Message-ID: ${spec.messageId ?? "<generated-1@example.net>"}`,
    ...(spec.inReplyTo === undefined ? [] : [`In-Reply-To: ${spec.inReplyTo}`]),
    ...(spec.references === undefined || spec.references.length === 0
      ? []
      : [`References: ${spec.references.join(" ")}`]),
    ...(spec.extraHeaders ?? []),
  ];

  const text = endOnCrlf(spec.text ?? "Plain text body.\r\n");
  const attachments = spec.attachments ?? [];
  if (spec.html === undefined && attachments.length === 0) {
    return Buffer.from(`${headers.join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`, "utf8");
  }

  const bodyBoundary = `=_harness-${headers.length}-body`;
  const parts: string[] = [];
  if (spec.html !== undefined) {
    // The alternatives carry the same content two ways (SPEC F6).
    parts.push(
      [
        `--${bodyBoundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
      ].join("\r\n"),
      [
        `--${bodyBoundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        spec.html,
      ].join("\r\n"),
    );
  } else {
    parts.push([`--${bodyBoundary}`, "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n"));
  }
  const body = [
    `Content-Type: multipart/alternative; boundary="${bodyBoundary}"`,
    "",
    ...parts,
    `--${bodyBoundary}--`,
    "",
  ].join("\r\n");

  if (attachments.length === 0) {
    return Buffer.from(`${headers.join("\r\n")}\r\nMIME-Version: 1.0\r\n${body}`, "utf8");
  }

  const mixedBoundary = `=_harness-${headers.length}-mixed`;
  const mixed = [
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    body,
  ].join("\r\n");
  const attachmentParts = attachments.map((attachment) =>
    [
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType ?? "application/octet-stream"}`,
      ...(attachment.filename === undefined
        ? []
        : [`Content-Disposition: ${attachment.disposition ?? "attachment"}; filename="${attachment.filename}"`]),
      ...(attachment.contentId === undefined ? [] : [`Content-ID: ${attachment.contentId}`]),
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(attachment.bytes),
    ].join("\r\n"),
  );
  return Buffer.from(
    `${headers.join("\r\n")}\r\nMIME-Version: 1.0\r\n${mixed}\r\n${attachmentParts.join("\r\n")}\r\n--${mixedBoundary}--\r\n`,
    "utf8",
  );
}

/** Base64 with 76-character lines, as MIME transport wants. */
export function base64Lines(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

/**
 * A hostile HTML body: scripts, remote images, a tracking pixel, event
 * handlers, a `javascript:` link, a stylesheet load, an iframe, a form, and a
 * meta refresh. Sanitizing must remove or neutralize all of them; the reader
 * must never fetch the remote references (SPEC F3 and section 9).
 */
export const MALICIOUS_HTML = [
  "<!DOCTYPE html>",
  "<html><head>",
  "<meta http-equiv=\"refresh\" content=\"0;url=https://tracker.example/redirect\">",
  "<style>body { background: url(https://tracker.example/style.png); }</style>",
  "</head><body>",
  "<script>alert('script body')</script>",
  "<img src=\"https://tracker.example/pixel.gif\" width=\"1\" height=\"1\" alt=\"pixel\">",
  "<img src=\"cid:chart@harness\" alt=\"inline chart\">",
  "<a href=\"javascript:alert('link')\">Click me</a>",
  "<div onclick=\"alert('handler')\">Hover bait</div>",
  "<iframe src=\"https://tracker.example/frame\" width=\"10\" height=\"10\"></iframe>",
  "<form action=\"https://tracker.example/harvest\" method=\"post\"><input name=\"secret\"></form>",
  "<p>Real content the reader must keep: quarterly numbers attached.</p>",
  "</body></html>",
].join("\r\n");

/** One message whose HTML half carries every hostile construct. */
export function maliciousHtmlMessage(spec: MessageSpec = {}): Buffer {
  return buildMessage({
    subject: "Quarterly numbers",
    messageId: "<malicious-1@example.net>",
    text: "Real content the reader must keep: quarterly numbers attached.\r\n",
    html: MALICIOUS_HTML,
    ...spec,
  });
}

/** Two attachments with the same name, type, and decoded size, different bytes. */
export function identicalAttachmentPairMessage(): Buffer {
  return buildMessage({
    subject: "Two reports, one name",
    messageId: "<attachment-pair-1@example.net>",
    text: "Both files claim to be the report.\r\n",
    attachments: [
      { filename: "report.pdf", contentType: "application/pdf", bytes: padded("first-report", 512) },
      { filename: "report.pdf", contentType: "application/pdf", bytes: padded("second-report", 512) },
    ],
  });
}

/** Two inline images that share one Content-ID, with different bytes. */
export function duplicateContentIdMessage(): Buffer {
  return buildMessage({
    subject: "Chart and decoy",
    messageId: "<duplicate-cid-1@example.net>",
    text: "The chart and the decoy answer to one identifier.\r\n",
    html: "<html><body><img src=\"cid:chart@harness\" alt=\"chart\"></body></html>",
    attachments: [
      {
        contentType: "image/png",
        contentId: "<chart@harness>",
        disposition: "inline",
        bytes: padded("chart-pixels", 256),
      },
      {
        contentType: "image/png",
        contentId: "<chart@harness>",
        disposition: "inline",
        bytes: padded("decoy-pixels", 256),
      },
    ],
  });
}

/** A message that wraps a complete inner message with its own attachment. */
export function nestedRfc822Message(): Buffer {
  const inner = buildMessage({
    from: "Inner Sender <inner@example.net>",
    to: "Outer Recipient <outer@example.net>",
    subject: "Inner: signed form",
    messageId: "<inner-1@example.net>",
    date: "Sun, 06 Sep 2026 15:00:00 +0000",
    text: "The signed form is attached.\r\n",
    attachments: [{ filename: "signed-form.pdf", contentType: "application/pdf", bytes: padded("signed-form", 128) }],
  });
  return buildMessage({
    from: "Outer Sender <outer@example.net>",
    to: "Archivist <archivist@example.net>",
    subject: "FW: signed form",
    messageId: "<nested-1@example.net>",
    date: "Mon, 07 Sep 2026 11:00:00 +0000",
    text: "Forwarding the signed form.\r\n",
    attachments: [
      {
        contentType: "message/rfc822",
        filename: undefined,
        bytes: inner,
      },
    ],
  });
}

/** An attachment of a chosen decoded size, for the oversized-attachment path. */
export function oversizedAttachmentMessage(targetBytes = 3 * 1024 * 1024): Buffer {
  return buildMessage({
    subject: "Big backup",
    messageId: "<oversized-1@example.net>",
    text: "The backup is attached.\r\n",
    attachments: [
      { filename: "backup.bin", contentType: "application/octet-stream", bytes: padded("backup-bytes", targetBytes) },
    ],
  });
}

/** Two byte-identical messages, as duplicate server notifications deliver. */
export function duplicateNotificationPair(): [Buffer, Buffer] {
  const bytes = buildMessage({
    subject: "Your receipt",
    messageId: "<receipt-1@example.net>",
    date: "Tue, 08 Sep 2026 08:30:00 +0000",
    text: "Thank you for your purchase.\r\n",
  });
  return [bytes, Buffer.from(bytes)];
}

/** Two messages that share one `Message-ID` but carry different content. */
export function reusedMessageIdPair(): [Buffer, Buffer] {
  const first = buildMessage({
    subject: "Original body",
    messageId: "<shared-1@example.net>",
    text: "The original body.\r\n",
  });
  const second = buildMessage({
    subject: "Different body",
    messageId: "<shared-1@example.net>",
    text: "A different body under the same identifier.\r\n",
  });
  return [first, second];
}

/** A three-message conversation: root, reply, and reply to the reply. */
export function replyChain(): Buffer[] {
  const root = buildMessage({
    from: "Ada <ada@example.net>",
    to: "You <you@example.com>",
    subject: "Launch plan",
    messageId: "<chain-root@example.net>",
    date: "Tue, 08 Sep 2026 08:00:00 +0000",
    text: "What remains before launch?\r\n",
  });
  const reply = buildMessage({
    from: "You <you@example.com>",
    to: "Ada <ada@example.net>",
    subject: "Re: Launch plan",
    messageId: "<chain-reply@example.net>",
    inReplyTo: "<chain-root@example.net>",
    references: ["<chain-root@example.net>"],
    date: "Tue, 08 Sep 2026 08:15:00 +0000",
    text: "Two items: the checklist and the rollback.\r\n",
  });
  const replyToReply = buildMessage({
    from: "Ada <ada@example.net>",
    to: "You <you@example.com>",
    subject: "Re: Launch plan",
    messageId: "<chain-reply-2@example.net>",
    inReplyTo: "<chain-reply@example.net>",
    references: ["<chain-root@example.net>", "<chain-reply@example.net>"],
    date: "Tue, 08 Sep 2026 08:22:00 +0000",
    text: "Both are on the shared drive.\r\n",
  });
  return [root, reply, replyToReply];
}

/** A reply whose parent was never delivered: pending, not unlinked (SPEC F2). */
export function orphanReplyMessage(): Buffer {
  return buildMessage({
    from: "Cyril <cyril@example.net>",
    to: "You <you@example.com>",
    subject: "Re: Lost thread",
    messageId: "<orphan-reply@example.net>",
    inReplyTo: "<never-delivered@example.net>",
    references: ["<never-delivered@example.net>"],
    date: "Wed, 09 Sep 2026 09:00:00 +0000",
    text: "Following up on the thread you never saw.\r\n",
  });
}

/** A message whose `Reply-To` differs from its `From` (SPEC reply rules). */
export function replyToDiffersMessage(): Buffer {
  return buildMessage({
    from: "Newsletter <news@example.net>",
    to: "You <you@example.com>",
    subject: "Issue 12",
    messageId: "<newsletter-12@example.net>",
    extraHeaders: ["Reply-To: Editor <editor@example.net>"],
    date: "Wed, 09 Sep 2026 12:00:00 +0000",
    text: "Reply to the editor, not the sender.\r\n",
  });
}

/** Deterministic bytes of a chosen length: a repeating marker. */
function padded(marker: string, targetBytes: number): Buffer {
  const unit = Buffer.from(`${marker}|`, "utf8");
  const repeats = Math.ceil(targetBytes / unit.length);
  return Buffer.concat(Array(repeats).fill(unit)).subarray(0, targetBytes);
}

/** One body block that ends on exactly one line terminator. */
function endOnCrlf(text: string): string {
  return text.endsWith("\r\n") ? text : `${text}\r\n`;
}
