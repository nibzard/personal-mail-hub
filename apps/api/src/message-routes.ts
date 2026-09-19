import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  CleanViewResponse,
  MessageAttachmentView,
  MessageDetailView,
  MessageDetailResponse,
} from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { ReadingError, type MessageDetail, type MessageAttachment, type ReadingService } from "@mail-hub/reading";
import { SESSION_COOKIE } from "./auth-routes.ts";

/**
 * Message detail and attachment download routes (SPEC F3 and section 9).
 * Both are reads behind the session; a download navigation carries no Origin
 * header, so the session cookie is the credential and the served bytes are
 * always verified derivatives, never a stored original.
 */

/** The service surface the routes need. `ReadingService` satisfies it. */
export type ReadingServiceForRoutes = Pick<
  ReadingService,
  "readMessage" | "readCleanView" | "openAttachment"
>;

export interface MessageRoutesOptions {
  service: ReadingServiceForRoutes;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F-]{36}$";

/** Longest media type or filename served in a response header. */
const MAX_HEADER_VALUE_CHARS = 255;

/** A media type, `type/subtype`, with no parameters. */
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/** Register the reader routes under a scoped error handler. */
export async function registerMessageRoutes(
  app: FastifyInstance,
  options: MessageRoutesOptions,
): Promise<void> {
  const { service } = options;

  await app.register(async function messageRoutes(scope) {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ReadingError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof AuthError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      return reply.send(error);
    });

    scope.get<{ Params: { id: string }; Reply: MessageDetailResponse }>(
      "/messages/:id",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", pattern: UUID_PATTERN } },
          },
        },
        preHandler: [requireSession],
      },
      async (request) => ({ message: toMessageDetailView(await service.readMessage(request.params.id)) }),
    );

    // The derived clean view (SPEC F3): extraction of the sanitized body,
    // sanitized again, computed on request and never stored. Reads carry no
    // recovery gate, like every other reader route.
    scope.get<{ Params: { id: string }; Reply: CleanViewResponse }>(
      "/messages/:id/clean-view",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", pattern: UUID_PATTERN } },
          },
        },
        preHandler: [requireSession],
      },
      async (request) => await service.readCleanView(request.params.id),
    );

    scope.get<{ Params: { id: string; attachmentId: string } }>(
      "/messages/:id/attachments/:attachmentId",
      {
        schema: {
          params: {
            type: "object",
            required: ["id", "attachmentId"],
            properties: {
              id: { type: "string", pattern: UUID_PATTERN },
              attachmentId: { type: "string", pattern: UUID_PATTERN },
            },
          },
        },
        preHandler: [requireSession],
      },
      async (request, reply) => {
        const opened = await service.openAttachment(request.params.id, request.params.attachmentId);
        sendAttachment(reply, opened.attachment, opened.bytes);
      },
    );
  });

  /** Resolve the session cookie before an authenticated route runs. */
  async function requireSession(request: FastifyRequest): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined || token === "") {
      throw new AuthError("unauthorized", "Sign in to continue.");
    }
    await options.verifySession(token);
  }
}

/** One message in its wire form: the date becomes ISO text. */
function toMessageDetailView(detail: MessageDetail): MessageDetailView {
  return {
    id: detail.id,
    accountId: detail.accountId,
    threadId: detail.threadId,
    subject: detail.subject,
    sender: detail.sender === null ? null : { address: detail.sender.address, name: detail.sender.name },
    recipients:
      detail.recipients === null
        ? null
        : {
            to: detail.recipients.to.map(toMessageAddress),
            cc: detail.recipients.cc.map(toMessageAddress),
          },
    sentAt: detail.sentAt === null ? null : detail.sentAt.toISOString(),
    fetchedBody: detail.fetchedBody,
    htmlSanitized: detail.htmlSanitized,
    textPlain: detail.textPlain,
    attachments: detail.attachments.map(toMessageAttachmentView),
  };
}

function toMessageAddress(address: { address: string; name: string | null }): {
  address: string;
  name: string | null;
} {
  return { address: address.address, name: address.name };
}

function toMessageAttachmentView(attachment: MessageAttachment): MessageAttachmentView {
  return { ...attachment };
}

/**
 * Serves verified bytes with headers the stored metadata cannot inject into.
 * The media type loses its parameters, an unusable value falls back to a
 * generic stream, and the filename arrives through both the ASCII fallback
 * and the UTF-8 extended form (RFC 6266).
 */
function sendAttachment(reply: FastifyReply, attachment: MessageAttachment, bytes: Uint8Array): void {
  const mediaType = mediaTypeOf(attachment.contentType);
  reply
    .header("Content-Type", mediaType)
    .header("Content-Length", bytes.byteLength)
    .header(
      "Content-Disposition",
      `attachment; ${contentDispositionFilename(attachment.filename)}`,
    )
    // The browser must not reinterpret the served type.
    .header("X-Content-Type-Options", "nosniff")
    // A download is personal data; nothing caches it.
    .header("Cache-Control", "private, no-store")
    .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

/** The media type before any parameter, when it parses as one. */
function mediaTypeOf(contentType: string | null): string {
  const candidate = contentType?.split(";", 1)[0]?.trim() ?? "";
  return MEDIA_TYPE_PATTERN.test(candidate) ? candidate : "application/octet-stream";
}

/** Header-safe filename parameters for one download name. */
function contentDispositionFilename(filename: string | null): string {
  const fallback = asciiFallback(filename);
  const extended = filename === null ? "" : encodeURIComponent(filename).slice(0, MAX_HEADER_VALUE_CHARS);
  const parts = [`filename="${fallback}"`];
  if (extended.length > 0) {
    parts.push(`filename*=UTF-8''${extended}`);
  }
  return parts.join("; ");
}

/** Printable ASCII with quote and backslash removed, for the fallback form. */
function asciiFallback(filename: string | null): string {
  if (filename === null) {
    return "attachment";
  }
  const cleaned = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const trimmed = cleaned.replace(/\.+$/, "").trim();
  return (trimmed.length > 0 ? trimmed : "attachment").slice(0, MAX_HEADER_VALUE_CHARS);
}
