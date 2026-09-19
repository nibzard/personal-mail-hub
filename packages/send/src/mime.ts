import nodemailer from "nodemailer";
import type { EmailAddress } from "@mail-hub/database";
import { SendError } from "./errors.ts";

/**
 * Exact MIME bytes for one outbound snapshot (SPEC F6 and F7 step 2).
 *
 * The body is `multipart/alternative`: the Markdown source as `text/plain`
 * and its sanitized render as `text/html`. Adding files wraps the whole
 * alternative in `multipart/mixed`. Blind-copy recipients never enter these
 * bytes; they live only in the envelope snapshot the outbound row stores.
 * One corner: an empty Markdown source yields an HTML-only message, because
 * the composer drops an empty plain part and padding it would break the
 * verbatim rule.
 *
 * `Message-ID` and `Date` are generated once, before SMTP, and passed in
 * frozen, so the stored bytes and every later submission are identical.
 */

/** One file attached to an outbound message, read from durable storage. */
export interface OutboundAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/** The frozen message one snapshot is built from. */
export interface OutboundMimeInput {
  identity: EmailAddress;
  /** Visible recipients. Blind copies are excluded by construction. */
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string | null;
  /** The Markdown source, verbatim as the `text/plain` alternative. */
  markdown: string;
  /** The sanitized HTML alternative. */
  html: string;
  /** Generated once before SMTP, in `<id@domain>` form. */
  rfcMessageId: string;
  /** Generated once before SMTP. */
  date: Date;
  /** The frozen reply identifiers; `null` and empty omit the headers. */
  inReplyTo: string | null;
  referenceIds: string[];
  attachments: OutboundAttachment[];
}

/** A composer that only renders bytes; it opens no connection of any kind. */
const composer = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  disableFileAccess: true,
  disableUrlAccess: true,
  logger: false,
});

/** Compile one frozen message into its exact MIME bytes. */
export async function composeOutboundMime(input: OutboundMimeInput): Promise<Uint8Array> {
  let message: unknown;
  try {
    const info = await composer.sendMail({
      from: { address: input.identity.address, name: input.identity.name ?? undefined },
      to: input.to.map((address) => ({ address: address.address, name: address.name ?? undefined })),
      cc: input.cc.map((address) => ({ address: address.address, name: address.name ?? undefined })),
      subject: input.subject ?? "",
      text: input.markdown,
      html: input.html,
      messageId: input.rfcMessageId,
      date: input.date,
      ...(input.inReplyTo === null ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.referenceIds.length === 0 ? {} : { references: input.referenceIds.join(" ") }),
      attachments: input.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.content),
      })),
    });
    message = info.message;
  } catch (cause) {
    throw new SendError(
      "invalid_request",
      `The outbound message could not be composed: ${describe(cause)}`,
    );
  }

  if (!Buffer.isBuffer(message)) {
    throw new SendError("invalid_request", "The MIME composer returned no bytes.");
  }
  return new Uint8Array(message);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
