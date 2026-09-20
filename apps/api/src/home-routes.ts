import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  CreateHomeDismissalBody,
  CreateHomeWorkBody,
  HomeDismissalResponse,
  HomePrioritiesResponse,
  HomeResponse,
  HomeSectionIdWire,
  HomeSectionResponse,
  HomeWorkListResponse,
  HomeWorkResponse,
  RescheduleHomeWorkBody,
  SetHomePriorityBody,
} from "@mail-hub/contracts";
import { HOME_SECTIONS } from "@mail-hub/contracts";
import { HomeError, type HomeMutationContext, type HomeService } from "@mail-hub/home";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { AuthError } from "@mail-hub/auth";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";
import { sendUnclassifiedError } from "./http-errors.ts";

/**
 * Home routes (SPEC F13 and section 7). Reads need a session and never call
 * a model or touch a mailbox; the full read also advances the reading
 * device's visit boundary only after it succeeded. Every mutation needs the
 * deployed origin, a live session, and the recovery generation the client
 * captured, and the service checks that generation before any duplicate
 * resolution.
 */

/** The service surface the routes need. `HomeService` satisfies it. */
export type HomeServiceForRoutes = Pick<
  HomeService,
  | "readHome"
  | "readSection"
  | "listWorkPage"
  | "createWork"
  | "rescheduleWork"
  | "completeWork"
  | "reopenWork"
  | "cancelWork"
  | "listPriorities"
  | "setPriority"
  | "dismiss"
  | "undismiss"
>;

export interface HomeRoutesOptions {
  service: HomeServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** The device identifier bounds the service itself enforces again. */
const deviceIdQuery = { type: "string", minLength: 8, maxLength: 100 };

/** The page size bounds the service itself enforces again. */
const limitQuery = { type: "integer", minimum: 1, maximum: 50 };

const workParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const revisionBody = {
  type: "object",
  required: ["revision"],
  properties: { revision: { type: "integer", minimum: 1 } },
  additionalProperties: false,
} as const;

/** Register the Home routes under one scoped error handler. */
export async function registerHomeRoutes(
  app: FastifyInstance,
  options: HomeRoutesOptions,
): Promise<void> {
  const { service, origin } = options;

  await app.register(async function homeRoutes(scope) {
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof HomeError) {
        return reply.code(error.httpStatus).send({
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
      return sendUnclassifiedError(error, request, reply);
    });

    // The full read assembles every section, reports coverage, and advances
    // the device's visit boundary after every query succeeded.
    scope.get<{ Reply: HomeResponse }>(
      "/home",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["deviceId"],
            properties: { deviceId: deviceIdQuery, limit: limitQuery },
            additionalProperties: false,
          },
        },
        preHandler: [requireSession],
      },
      async (request) =>
        service.readHome({
          deviceId: (request.query as { deviceId: string }).deviceId,
          ...pageLimitOf(request),
        }),
    );

    scope.get<{ Reply: HomeSectionResponse }>(
      "/home/sections/:id",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", enum: [...HOME_SECTIONS] } },
          },
          querystring: {
            type: "object",
            properties: {
              deviceId: deviceIdQuery,
              visitBoundary: { anyOf: [{ type: "string", const: "none" }, { type: "string", format: "date-time", maxLength: 40 }] },
              cursor: { type: "string", minLength: 1, maxLength: 4096 },
              limit: limitQuery,
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireSession],
      },
      async (request) => {
        const query = request.query as { deviceId?: string; cursor?: string; visitBoundary?: string };
        const section = await service.readSection({
          section: (request.params as { id: HomeSectionIdWire }).id,
          cursor: query.cursor ?? null,
          ...(query.visitBoundary === undefined ? {} : { visitBoundary: query.visitBoundary === "none" ? null : query.visitBoundary }),
          ...(query.deviceId === undefined ? {} : { deviceId: query.deviceId }),
          ...pageLimitOf(request),
        });
        return { section };
      },
    );

    scope.get<{ Reply: HomeWorkListResponse }>(
      "/home/work",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["open", "done"] },
              cursor: { type: "string", minLength: 1, maxLength: 4096 },
              limit: limitQuery,
              kind: { type: "string", enum: ["reply_later", "reminder"] },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireSession],
      },
      async (request) => {
        const query = request.query as { status?: "open" | "done"; kind?: "reply_later" | "reminder"; cursor?: string };
        return service.listWorkPage({
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
            ...pageLimitOf(request),
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.kind === undefined ? {} : { kind: query.kind }),
          });
      },
    );

    scope.post<{ Body: CreateHomeWorkBody; Reply: HomeWorkResponse }>(
      "/home/work",
      {
        schema: {
          body: {
            type: "object",
            required: ["accountId", "anchorMessageId", "kind"],
            properties: {
              accountId: { type: "string", pattern: UUID_PATTERN },
              anchorMessageId: { type: "string", pattern: UUID_PATTERN },
              kind: { type: "string", enum: ["reply_later", "reminder"] },
              dueAt: { type: "string", format: "date-time", maxLength: 40 },
              timeZone: { type: "string", minLength: 1, maxLength: 64 },
            },
            // A reminder freezes the resolved instant and the zone that
            // interpreted it; the service checks the same rule again.
            allOf: [
              {
                if: { properties: { kind: { const: "reminder" } } },
                then: { required: ["dueAt", "timeZone"] },
              },
            ],
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => ({
        work: await service.createWork(mutationContext(request), request.body),
      }),
    );

    scope.post<{ Params: { id: string }; Body: RescheduleHomeWorkBody; Reply: HomeWorkResponse }>(
      "/home/work/:id/reschedule",
      {
        schema: {
          params: workParams,
          body: {
            type: "object",
            required: ["revision", "dueAt", "timeZone"],
            properties: {
              revision: { type: "integer", minimum: 1 },
              dueAt: { type: "string", format: "date-time", maxLength: 40 },
              timeZone: { type: "string", minLength: 1, maxLength: 64 },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => ({
        work: await service.rescheduleWork(mutationContext(request), request.params.id, request.body),
      }),
    );

    scope.post<{ Params: { id: string }; Body: { revision: number }; Reply: HomeWorkResponse }>(
      "/home/work/:id/complete",
      {
        schema: { params: workParams, body: revisionBody },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => ({
        work: await service.completeWork(mutationContext(request), request.params.id, request.body),
      }),
    );

    scope.post<{ Params: { id: string }; Body: { revision: number }; Reply: HomeWorkResponse }>(
      "/home/work/:id/reopen",
      {
        schema: { params: workParams, body: revisionBody },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => ({
        work: await service.reopenWork(mutationContext(request), request.params.id, request.body),
      }),
    );

    scope.post<{ Params: { id: string }; Body: { revision: number } }>(
      "/home/work/:id/cancel",
      {
        schema: { params: workParams, body: revisionBody },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        await service.cancelWork(mutationContext(request), request.params.id, request.body);
        return reply.code(204).send();
      },
    );

    scope.get<{ Reply: HomePrioritiesResponse }>(
      "/home/priorities",
      { preHandler: [requireSession] },
      async () => ({ priorities: await service.listPriorities() }),
    );

    scope.put<{ Body: SetHomePriorityBody; Reply: HomePrioritiesResponse }>(
      "/home/priorities",
      {
        schema: {
          body: {
            type: "object",
            required: ["accountId", "target", "prioritized"],
            properties: {
              accountId: { type: "string", pattern: UUID_PATTERN },
              target: {
                type: "object",
                required: ["kind"],
                properties: {
                  kind: { type: "string", enum: ["sender", "thread"] },
                  sender: { type: "string", minLength: 3, maxLength: 254 },
                  threadId: { type: "string", pattern: UUID_PATTERN },
                },
                additionalProperties: false,
              },
              prioritized: { type: "boolean" },
              revision: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => {
        await service.setPriority(mutationContext(request), request.body);
        return { priorities: await service.listPriorities() };
      },
    );

    scope.post<{ Body: CreateHomeDismissalBody; Reply: HomeDismissalResponse }>(
      "/home/dismissals",
      {
        schema: {
          body: {
            type: "object",
            required: ["accountId", "messageId"],
            properties: {
              accountId: { type: "string", pattern: UUID_PATTERN },
              messageId: { type: "string", pattern: UUID_PATTERN },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        const dismissed = await service.dismiss(mutationContext(request), request.body);
        return reply.code(201).send({ dismissed });
      },
    );

    scope.delete<{ Params: { messageId: string } }>(
      "/home/dismissals/:messageId",
      {
        schema: {
          params: {
            type: "object",
            required: ["messageId"],
            properties: { messageId: { type: "string", pattern: UUID_PATTERN } },
          },
          querystring: {
            type: "object",
            required: ["accountId"],
            properties: { accountId: { type: "string", pattern: UUID_PATTERN } },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        const accountId = (request.query as { accountId: string }).accountId;
        await service.undismiss(mutationContext(request), {
          accountId,
          messageId: request.params.messageId,
        });
        return reply.code(204).send();
      },
    );
  });

  /** The generation the client captured, for every mutation above. */
  function mutationContext(request: FastifyRequest): HomeMutationContext {
    return { requestGeneration: readRequestGeneration(request) };
  }

  /** The page size, when the request named one. */
  function pageLimitOf(request: FastifyRequest): { limit?: number } {
    const limit = (request.query as { limit?: number }).limit;
    return limit === undefined ? {} : { limit };
  }

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
