/** MIME fixtures shared by the ingestion tests. Built fresh on every call. */

export function mime(lines: string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
}

/** One ordinary message: alternative bodies plus one PDF attachment. */
export function standardMessage(): Uint8Array {
  return mime([
    "From: Alice Sender <alice@example.com>",
    "To: Bob <bob@example.com>, carol@example.com",
    "Cc: Dave <dave@example.com>",
    "Reply-To: replies@example.com",
    "Subject: Quarterly report",
    "Date: Mon, 07 Sep 2026 10:15:00 +0000",
    "Message-ID: <quarterly@example.com>",
    "In-Reply-To: <parent@example.com>",
    "References: <root@example.com> <parent@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=MIX",
    "",
    "--MIX",
    "Content-Type: multipart/alternative; boundary=ALT",
    "",
    "--ALT",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Numbers look great.",
    "--ALT",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Numbers look <b>great</b>.</p><script>alert(1)</script></body></html>",
    "--ALT--",
    "--MIX",
    "Content-Type: application/pdf; name=report.pdf",
    "Content-Disposition: attachment; filename=report.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "Zm9vYmFy",
    "--MIX--",
  ]);
}

/** One message whose whole body is a single PDF part. */
export function singlePartPdf(): Uint8Array {
  return mime([
    "From: sender@example.com",
    "To: bob@example.com",
    "Subject: Single part",
    "Date: Mon, 07 Sep 2026 11:00:00 +0000",
    "Message-ID: <single@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: application/pdf; name=report.pdf",
    "Content-Disposition: attachment; filename=report.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "Zm9vYmFy",
  ]);
}

/** One message wrapping an embedded message that itself carries a PDF. */
export function nestedMessage(): Uint8Array {
  return mime([
    "From: a@example.com",
    "To: b@example.com",
    "Subject: Outer with embedded message",
    "Date: Mon, 07 Sep 2026 12:00:00 +0000",
    "Message-ID: <outer@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=OUTER",
    "",
    "--OUTER",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Outer text.",
    "--OUTER",
    "Content-Type: message/rfc822",
    "",
    "From: c@example.com",
    "Subject: Inner",
    "Message-ID: <inner@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=INNER",
    "",
    "--INNER",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Inner text.",
    "--INNER",
    "Content-Type: application/pdf; name=doc.pdf",
    "Content-Disposition: attachment; filename=doc.pdf",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <pdf1@inner>",
    "",
    "Zm9vYmFy",
    "--INNER--",
    "--OUTER--",
  ]);
}

/** Two attachments that share one Content-ID. */
export function duplicateContentIdMessage(): Uint8Array {
  return mime([
    "From: a@example.com",
    "Subject: Duplicate content ids",
    "Date: Mon, 07 Sep 2026 13:00:00 +0000",
    "Message-ID: <dupcid@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=D",
    "",
    "--D",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body",
    "--D",
    "Content-Type: image/png; name=first.png",
    "Content-Disposition: inline; filename=first.png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <same@x>",
    "",
    "Zm9vYmFy",
    "--D",
    "Content-Type: image/png; name=second.png",
    "Content-Disposition: inline; filename=second.png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <same@x>",
    "",
    "c3BhbQ==",
    "--D--",
  ]);
}

/** Base64 of `foobar`, the decoded content of the fixtures above. */
export const DECODED_FOOBAR = new Uint8Array([102, 111, 111, 98, 97, 114]);

/** Base64 of `spam`. */
export const DECODED_SPAM = new Uint8Array([115, 112, 97, 109]);
