import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ConnectionTestResponse } from "@mail-hub/contracts";
import type { AccountService } from "@mail-hub/accounts";
import type { ConnectionTestRequest, ConnectionTestOutcome } from "@mail-hub/transport";
import { AccountError } from "@mail-hub/accounts";
import { AuthError } from "@mail-hub/auth";
import { SESSION_COOKIE } from "./auth-routes.ts";
import { sendUnclassifiedError } from "./http-errors.ts";

/**
 * The connection-test route (SPEC F1). It runs the stored settings of one
 * account against both protocols and reports each half separately: IMAP
 * over implicit TLS authenticates, lists folders with counts, and discovers
 * capabilities; SMTP over its configured encrypted mode authenticates
 * without sending mail. A connection test verifies no send identities.
 *
 * The route decrypts the stored password to open the sessions, so it needs
 * the deployed origin and a live session like every other account call. It
 * writes nothing: the recovery generation is not checked because nothing
 * mutates. The client feeds the reported folders to the folder-import
 * route, which is the mutation half of the save flow.
 */

/** The account-service surface this route needs. */
export type AccountServiceForConnectionTest = Pick<AccountService, "readAccount" | "resolveCredentials">;

/** Runs both protocol tests. `runConnectionTest` from `@mail-hub/transport` satisfies it. */
export type ConnectionTester = (request: ConnectionTestRequest) => Promise<ConnectionTestOutcome>;

export interface ConnectionTestRoutesOptions {
  service: AccountServiceForConnectionTest;
  tester: ConnectionTester;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F-]{36}$";

/** Register the connection-test route with its scoped error handler. */
export async function registerConnectionTestRoutes(
  app: FastifyInstance,
  options: ConnectionTestRoutesOptions,
): Promise<void> {
  const { tester, origin } = options;

  await app.register(async function connectionTestRoutes(scope) {
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof AccountError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof AuthError) {
        return reply
          .code(error.httpStatus)
          .send({ error: { code: error.code, message: error.message } });
      }
      return sendUnclassifiedError(error, request, reply);
    });

    scope.post<{ Params: { id: string }; Reply: ConnectionTestResponse }>(
      "/accounts/:id/connection-test",
      {
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", pattern: UUID_PATTERN } },
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => {
        const account = await options.service.readAccount(request.params.id);
        const credentials = await options.service.resolveCredentials(account.id);
        const outcome = await tester({
          imap: { host: account.imapHost, port: account.imapPort },
          smtp: {
            host: account.smtpHost,
            port: account.smtpPort,
            security: account.smtpSecurity,
          },
          username: credentials.username,
          password: credentials.password,
        });
        // The reports carry no credentials; the password never travels back.
        return outcome;
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
