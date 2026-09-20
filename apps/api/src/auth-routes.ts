import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthCredentialSummary,
  AuthOptionsResponse,
  AuthSessionResponse,
  AuthStatusResponse,
} from "@mail-hub/contracts";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { AuthError, type PasskeyAuthService, type SessionInfo } from "@mail-hub/auth";
import { sendUnclassifiedError } from "./http-errors.ts";

/**
 * Owner authentication routes (SPEC sections 7 and 9). These routes sit
 * outside the mail-mutation recovery gate: enrollment, login, and session
 * revocation stay available while mail work is blocked. Every state-changing
 * request must carry the expected origin.
 */

export const SESSION_COOKIE = "mailhub_session";

/** The service surface the routes need. `PasskeyAuthService` satisfies it. */
export type AuthServiceForRoutes = Pick<
  PasskeyAuthService,
  | "readStatus"
  | "startEnrollment"
  | "completeEnrollment"
  | "startLogin"
  | "completeLogin"
  | "revokeSession"
  | "verifySession"
  | "startReverification"
  | "completeReverification"
  | "listCredentials"
  | "startCredentialEnrollment"
  | "completeCredentialEnrollment"
  | "removeCredential"
>;

export interface AuthRoutesOptions {
  service: AuthServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
}

interface AuthRequestContext {
  sessionToken: string;
  session: SessionInfo;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthRequestContext;
  }
}

const webauthnResponseSchema = {
  type: "object",
  required: ["id", "rawId", "type", "response"],
  properties: {
    id: { type: "string" },
    rawId: { type: "string" },
    type: { const: "public-key" },
    response: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
} as const;

/** Register all owner authentication routes under a scoped error handler. */
export async function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { service, origin } = options;

  await app.register(async function authRoutes(scope) {
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof AuthError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      return sendUnclassifiedError(error, request, reply);
    });

    scope.get<{ Reply: AuthStatusResponse }>(
      "/auth/status",
      {
        schema: {
          response: {
            200: {
              type: "object",
              required: ["ownerRegistered", "login", "control"],
              properties: {
                ownerRegistered: { type: "boolean" },
                login: { enum: ["available", "inspection_only", "blocked"] },
                control: { type: "string" },
              },
            },
          },
        },
      },
      async () => service.readStatus(),
    );

    scope.post<{ Body: { grantToken: string }; Reply: AuthOptionsResponse }>(
      "/auth/enroll/start",
      {
        schema: {
          body: {
            type: "object",
            required: ["grantToken"],
            properties: { grantToken: { type: "string", minLength: 16, maxLength: 200 } },
          },
        },
        preHandler: [requireOrigin],
      },
      async (request) => ({ options: await service.startEnrollment(request.body.grantToken) }),
    );

    scope.post<{
      Body: { grantToken: string; label: string; response: RegistrationResponseJSON };
      Reply: AuthSessionResponse;
    }>(
      "/auth/enroll/complete",
      {
        schema: {
          body: {
            type: "object",
            required: ["grantToken", "label", "response"],
            properties: {
              grantToken: { type: "string", minLength: 16, maxLength: 200 },
              label: { type: "string", minLength: 1, maxLength: 64 },
              response: webauthnResponseSchema,
            },
          },
        },
        preHandler: [requireOrigin],
      },
      async (request, reply) => {
        const { grantToken, label, response } = request.body;
        const opened = await service.completeEnrollment({ grantToken, label, response });
        setSessionCookie(reply, opened.token);
        return sessionBody(opened.session);
      },
    );

    scope.post<{ Reply: AuthOptionsResponse }>(
      "/auth/login/start",
      { preHandler: [requireOrigin] },
      async () => ({ options: await service.startLogin() }),
    );

    scope.post<{ Body: { response: AuthenticationResponseJSON }; Reply: AuthSessionResponse }>(
      "/auth/login/complete",
      {
        schema: {
          body: {
            type: "object",
            required: ["response"],
            properties: { response: webauthnResponseSchema },
          },
        },
        preHandler: [requireOrigin],
      },
      async (request, reply) => {
        const opened = await service.completeLogin(request.body.response);
        setSessionCookie(reply, opened.token);
        return sessionBody(opened.session);
      },
    );

    scope.post(
      "/auth/logout",
      { preHandler: [requireOrigin, requireSession] },
      async (request, reply) => {
        await service.revokeSession(request.auth!.sessionToken);
        reply.clearCookie(SESSION_COOKIE, { path: "/" });
        return reply.code(204).send();
      },
    );

    scope.post<{ Reply: AuthOptionsResponse }>(
      "/auth/verify/start",
      { preHandler: [requireOrigin, requireSession] },
      async (request) => ({ options: await service.startReverification(request.auth!.sessionToken) }),
    );

    scope.post<{ Body: { response: AuthenticationResponseJSON }; Reply: AuthSessionResponse }>(
      "/auth/verify/complete",
      {
        schema: {
          body: {
            type: "object",
            required: ["response"],
            properties: { response: webauthnResponseSchema },
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => sessionBody(await service.completeReverification(request.auth!.sessionToken, request.body.response)),
    );

    scope.get<{ Reply: { credentials: AuthCredentialSummary[] } }>(
      "/auth/credentials",
      { preHandler: [requireSession] },
      async (request) => {
        const credentials = await service.listCredentials(request.auth!.sessionToken);
        return {
          credentials: credentials.map((credential) => ({
            id: credential.id,
            label: credential.label,
            createdAt: credential.createdAt.toISOString(),
            lastUsedAt: credential.lastUsedAt === null ? null : credential.lastUsedAt.toISOString(),
          })),
        };
      },
    );

    scope.post<{ Reply: AuthOptionsResponse }>(
      "/auth/credentials/add/start",
      { preHandler: [requireOrigin, requireSession] },
      async (request) => ({ options: await service.startCredentialEnrollment(request.auth!.sessionToken) }),
    );

    scope.post<{
      Body: { label: string; response: RegistrationResponseJSON };
      Reply: AuthCredentialSummary;
    }>(
      "/auth/credentials/add/complete",
      {
        schema: {
          body: {
            type: "object",
            required: ["label", "response"],
            properties: {
              label: { type: "string", minLength: 1, maxLength: 64 },
              response: webauthnResponseSchema,
            },
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => {
        const credential = await service.completeCredentialEnrollment(
          request.auth!.sessionToken,
          request.body.label,
          request.body.response,
        );
        return {
          id: credential.id,
          label: credential.label,
          createdAt: credential.createdAt.toISOString(),
          lastUsedAt: credential.lastUsedAt === null ? null : credential.lastUsedAt.toISOString(),
        };
      },
    );

    scope.post<{ Body: { id: string } }>(
      "/auth/credentials/remove",
      {
        schema: {
          body: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" } },
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        await service.removeCredential(request.auth!.sessionToken, request.body.id);
        return reply.code(204).send();
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
    request.auth = { sessionToken: token, session: await service.verifySession(token) };
  }
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  });
}

function sessionBody(session: SessionInfo): AuthSessionResponse {
  return {
    kind: session.kind,
    verifiedAt: session.verifiedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}
