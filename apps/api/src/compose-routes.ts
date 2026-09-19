import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  DraftAttachmentView,
  DraftAttachmentsResponse,
  DraftResponse,
  DraftsResponse,
  DraftUploadVerificationResponse,
  DraftView,
  IdentitySelection,
  MessageRecipients,
  UploadResponse,
  UploadView,
} from "@mail-hub/contracts";
import { ComposeError, UPLOAD_MAX_BYTES, type ComposeService, type DraftAttachmentRecord, type DraftRecord, type MutationContext, type UploadRecord } from "@mail-hub/compose";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { AuthError } from "@mail-hub/auth";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";

/**
 * Draft and upload routes (SPEC F6 and F9). Reads need a session; every
 * state change also needs the deployed origin and the recovery generation
 * the client captured, which the compose service checks before it writes
 * (SPEC section 7, step 1). Upload bytes arrive as one raw body under the
 * file's own media type; the durable write finishes before the route
 * acknowledges the upload.
 */

/** The service surface the routes need. `ComposeService` satisfies it. */
export type ComposeServiceForRoutes = Pick<
  ComposeService,
  | "createDraft"
  | "updateDraft"
  | "readDraft"
  | "listDrafts"
  | "deleteDraft"
  | "createUpload"
  | "attachUpload"
  | "detachUpload"
  | "listDraftAttachments"
  | "verifyDraftUploads"
>;

export interface ComposeRoutesOptions {
  service: ComposeServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F-]{36}$";

const draftParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const uploadParams = {
  type: "object",
  required: ["id", "uploadId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    uploadId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const addressSchema = {
  type: "object",
  required: ["address"],
  properties: {
    address: { type: "string", minLength: 3, maxLength: 320 },
    name: { type: ["string", "null"], maxLength: 128 },
  },
  additionalProperties: false,
} as const;

const recipientsSchema = {
  type: "object",
  required: ["to"],
  properties: {
    to: { type: "array", maxItems: 100, items: addressSchema },
    cc: { type: "array", maxItems: 100, items: addressSchema },
    bcc: { type: "array", maxItems: 100, items: addressSchema },
  },
  additionalProperties: false,
} as const;

const identitySchema = {
  type: "object",
  required: ["address"],
  properties: { address: { type: "string", minLength: 3, maxLength: 320 } },
  additionalProperties: false,
} as const;

const draftEditProperties = {
  identity: identitySchema,
  recipients: recipientsSchema,
  subject: { type: ["string", "null"], maxLength: 4096 },
  markdown: { type: ["string", "null"], maxLength: 2_000_000 },
} as const;

/** Register all compose routes under a scoped error handler. */
export async function registerComposeRoutes(
  app: FastifyInstance,
  options: ComposeRoutesOptions,
): Promise<void> {
  const { service, origin } = options;

  await app.register(async function composeRoutes(scope) {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ComposeError) {
        return reply
          .code(error.httpStatus)
          .send({
            error: {
              code: error.code,
              message: error.message,
              ...(error.currentRevision === undefined
                ? {}
                : { currentRevision: error.currentRevision }),
            },
          });
      }
      if (error instanceof AuthError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof RecoveryBlockedError) {
        return reply.code(error.httpStatus).send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentGeneration === undefined ? {} : { currentGeneration: error.currentGeneration }),
          },
        });
      }
      return reply.send(error);
    });

    scope.get<{ Reply: DraftsResponse }>(
      "/drafts",
      { preHandler: [requireSession] },
      async () => ({ drafts: (await service.listDrafts()).map(toDraftView) }),
    );

    scope.post<{ Body: DraftCreateBody; Reply: DraftResponse }>(
      "/drafts",
      {
        schema: {
          body: {
            type: "object",
            required: ["accountId"],
            properties: {
              accountId: { type: "string", pattern: UUID_PATTERN },
              ...draftEditProperties,
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        const body = request.body;
        const draft = await service.createDraft(readContext(request), {
          accountId: body.accountId,
          identity: body.identity,
          recipients: body.recipients,
          subject: body.subject,
          markdown: body.markdown ?? undefined,
        });
        return reply.code(201).send({ draft: toDraftView(draft) });
      },
    );

    scope.get<{ Params: { id: string }; Reply: DraftResponse }>(
      "/drafts/:id",
      { schema: { params: draftParams }, preHandler: [requireSession] },
      async (request) => ({ draft: toDraftView(await service.readDraft(request.params.id)) }),
    );

    scope.patch<{ Params: { id: string }; Body: DraftEditBody; Reply: DraftResponse }>(
      "/drafts/:id",
      {
        schema: {
          params: draftParams,
          body: {
            type: "object",
            required: ["baseRevision"],
            properties: {
              baseRevision: { type: "integer", minimum: 1 },
              ...draftEditProperties,
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => ({
        draft: toDraftView(
          await service.updateDraft(readContext(request), request.params.id, {
            baseRevision: request.body.baseRevision,
            identity: request.body.identity,
            recipients: request.body.recipients,
            subject: request.body.subject,
            markdown: request.body.markdown ?? undefined,
          }),
        ),
      }),
    );

    scope.delete<{ Params: { id: string } }>(
      "/drafts/:id",
      { schema: { params: draftParams }, preHandler: [requireOrigin, requireSession] },
      async (request, reply) => {
        await service.deleteDraft(readContext(request), request.params.id);
        return reply.code(204).send();
      },
    );

    scope.get<{ Params: { id: string }; Reply: DraftAttachmentsResponse }>(
      "/drafts/:id/uploads",
      { schema: { params: draftParams }, preHandler: [requireSession] },
      async (request) => ({
        attachments: (await service.listDraftAttachments(request.params.id)).map(toAttachmentView),
      }),
    );

    scope.post<{ Params: { id: string }; Body: { uploadId: string }; Reply: DraftAttachmentView }>(
      "/drafts/:id/uploads",
      {
        schema: {
          params: draftParams,
          body: {
            type: "object",
            required: ["uploadId"],
            properties: { uploadId: { type: "string", pattern: UUID_PATTERN } },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) =>
        reply
          .code(201)
          .send(
            toAttachmentView(
              await service.attachUpload(readContext(request), request.params.id, request.body.uploadId),
            ),
          ),
    );

    scope.delete<{ Params: { id: string; uploadId: string } }>(
      "/drafts/:id/uploads/:uploadId",
      { schema: { params: uploadParams }, preHandler: [requireOrigin, requireSession] },
      async (request, reply) => {
        await service.detachUpload(readContext(request), request.params.id, request.params.uploadId);
        return reply.code(204).send();
      },
    );

    scope.post<{ Params: { id: string }; Reply: DraftUploadVerificationResponse }>(
      "/drafts/:id/verify-uploads",
      { schema: { params: draftParams }, preHandler: [requireOrigin, requireSession] },
      async (request) => await service.verifyDraftUploads(request.params.id),
    );

    /**
     * Raw upload bodies. One nested scope owns a buffer parser for every
     * media type, so one route can receive any file type verbatim while the
     * JSON routes around it keep their usual parser.
     */
    await scope.register(
      async function uploadRoutes(uploadScope) {
        uploadScope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
          done(null, body);
        });

        uploadScope.post<{ Querystring: UploadQuery; Reply: UploadResponse }>(
          "/uploads",
          {
            schema: {
              querystring: {
                type: "object",
                required: ["accountId", "filename"],
                properties: {
                  accountId: { type: "string", pattern: UUID_PATTERN },
                  filename: { type: "string", minLength: 1, maxLength: 255 },
                },
                additionalProperties: false,
              },
            },
            // The parser limit matches the service limit; larger bodies
            // reject with 413 before any durable write starts.
            bodyLimit: UPLOAD_MAX_BYTES,
            preHandler: [requireOrigin, requireSession],
          },
          async (request, reply) => {
            const bytes = request.body as Buffer;
            const contentType = request.headers["content-type"];
            const upload = await service.createUpload(readContext(request), {
              accountId: request.query.accountId,
              filename: request.query.filename,
              contentType: typeof contentType === "string" ? contentType : null,
              bytes: new Uint8Array(bytes),
            });
            return reply.code(201).send({ upload: toUploadView(upload) });
          },
        );
      },
    );
  });

  /** Cross-site requests must present the deployed origin (SPEC section 9). */
  async function requireOrigin(request: FastifyRequest): Promise<void> {
    if (request.headers.origin !== origin) {
      throw new AuthError(
        "origin_forbidden",
        "Requests must come from the deployed origin of this application.",
      );
    }
  }

  /** Resolve the session cookie before an authenticated route runs. */
  async function requireSession(request: FastifyRequest): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined || token === "") {
      throw new AuthError("unauthorized", "Sign in to continue.");
    }
    await options.verifySession(token);
  }
}

function readContext(request: FastifyRequest): MutationContext {
  return { requestGeneration: readRequestGeneration(request) };
}

/** The querystring of `POST /uploads`: one account and one file name. */
interface UploadQuery {
  accountId: string;
  filename: string;
}

/** The body of `POST /drafts`. */
interface DraftCreateBody {
  accountId: string;
  identity?: IdentitySelection;
  recipients?: MessageRecipients;
  subject?: string | null;
  markdown?: string | null;
}

/** The body of `PATCH /drafts/:id`. */
interface DraftEditBody {
  baseRevision: number;
  identity?: IdentitySelection;
  recipients?: MessageRecipients;
  subject?: string | null;
  markdown?: string | null;
}

/** One stored draft in its wire form: the date becomes ISO text. */
function toDraftView(draft: DraftRecord): DraftView {
  return {
    id: draft.id,
    accountId: draft.accountId,
    identity: { address: draft.identity.address, name: draft.identity.name },
    recipients: {
      to: draft.recipients.to,
      cc: draft.recipients.cc ?? [],
      bcc: draft.recipients.bcc ?? [],
    },
    subject: draft.subject,
    markdown: draft.markdown,
    revision: draft.revision,
    lockedBySend: draft.lockedBySend,
    updatedAt: draft.updatedAt.toISOString(),
  };
}

/** One stored upload in its wire form. */
function toUploadView(upload: UploadRecord): UploadView {
  return {
    id: upload.id,
    accountId: upload.accountId,
    filename: upload.filename,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    sha256: upload.sha256,
    createdAt: upload.createdAt.toISOString(),
  };
}

/** One stored draft attachment in its wire form. */
function toAttachmentView(attachment: DraftAttachmentRecord): DraftAttachmentView {
  return { ...toUploadView(attachment), ordinal: attachment.ordinal };
}
