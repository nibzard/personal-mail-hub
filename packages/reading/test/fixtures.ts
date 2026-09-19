/** MIME fixtures for the reader tests. Built fresh on every call. */

export function mime(lines: string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
}

/**
 * One message exercising every reader decision: an HTML body with one
 * uniquely-identified inline image, a remote tracking image, an ambiguous
 * Content-ID held by two images, a non-image part that also has a unique
 * Content-ID, and a quoted reply block.
 */
export function readerMessage(): Uint8Array {
  return mime([
    "From: Dana Reporter <dana@example.com>",
    "To: Bob <bob@example.com>",
    "Cc: Carol <carol@example.com>",
    "Subject: September metrics",
    "Date: Tue, 08 Sep 2026 09:30:00 +0000",
    "Message-ID: <metrics@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=RMIX",
    "",
    "--RMIX",
    "Content-Type: multipart/alternative; boundary=RALT",
    "",
    "--RALT",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Metrics attached.",
    "--RALT",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<html><body><p>Chart: <img src="cid:chart@reports"> tracker: '
      + '<img src="https://tracker.example/pixel.gif"> twin: <img src="cid:twin@x"></p>'
      + "<script>alert(1)</script>"
      + "<blockquote><p>On Monday, Alice wrote: earlier note</p></blockquote>"
      + "</body></html>",
    "--RALT--",
    "--RMIX",
    "Content-Type: image/png; name=chart.png",
    "Content-Disposition: inline; filename=chart.png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <chart@reports>",
    "",
    "Zm9vYmFy",
    "--RMIX",
    "Content-Type: image/png; name=left.png",
    "Content-Disposition: inline; filename=left.png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <twin@x>",
    "",
    "Zm9vYmFy",
    "--RMIX",
    "Content-Type: image/png; name=right.png",
    "Content-Disposition: inline; filename=right.png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <twin@x>",
    "",
    "c3BhbQ==",
    "--RMIX",
    "Content-Type: application/pdf; name=metrics.pdf",
    "Content-Disposition: attachment; filename=metrics.pdf",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <doc@pdf>",
    "",
    "Zm9vYmFy",
    "--RMIX--",
  ]);
}

/** One message with a plain body and no HTML alternative. */
export function textOnlyMessage(): Uint8Array {
  return mime([
    "From: plain@example.com",
    "To: bob@example.com",
    "Subject: Plain note",
    "Date: Tue, 08 Sep 2026 10:00:00 +0000",
    "Message-ID: <plain@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Just text.",
  ]);
}

/** Base64 of `foobar`, the decoded content of the fixtures above. */
export const DECODED_FOOBAR = new Uint8Array([102, 111, 111, 98, 97, 114]);

/** Base64 of `spam`. */
export const DECODED_SPAM = new Uint8Array([115, 112, 97, 109]);
