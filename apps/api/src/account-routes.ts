import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AccountFoldersResponse,
  AccountIdentityInput,
  AccountResponse,
  AccountsResponse,
  AccountSummary,
  DiscoveredFolder,
  FolderImportResponse,
  FolderRole,
  FolderSummary,
  SmtpSecurityMode,
} from "@mail-hub/contracts";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { AccountError, type AccountService, type AccountSummary as StoredAccountSummary } from "@mail-hub/accounts";
import { AuthError } from "@mail-hub/auth";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";

/**
 * Account and identity management routes (SPEC F1). Reads need a session;
 * every state change also needs the deployed origin and the recovery
 * generation the client captured, which the account service checks before it
 * writes (SPEC section 7, step 1). No route ever returns password material.
 */

/** The service surface the routes need. `AccountService` satisfies it. */
export type AccountServiceForRoutes = Pick<
  AccountService,
  | "listAccounts"
  | "readAccount"
  | "createAccount"
  | "updateAccount"
  | "updatePassword"
  | "setIdentities"
  | "listFolders"
  | "importFolders"
  | "assignFolderRole"
  | "clearFolderRole"
>;

export interface AccountRoutesOptions {
  service: AccountServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F-]{36}$";

const identitySchema = {
  type: "object",
  required: ["address", "isDefault"],
  properties: {
    address: { type: "string", minLength: 3, maxLength: 320 },
    name: { type: ["string", "null"], maxLength: 128 },
    isDefault: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const accountParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const folderParams = {
  type: "object",
  required: ["id", "folderId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    folderId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

/** Register all account routes under a scoped error handler. */
export async function registerAccountRoutes(
  app: FastifyInstance,
  options: AccountRoutesOptions,
): Promise<void> {
  const { service, origin } = options;

  await app.register(async function accountRoutes(scope) {
    scope.setErrorHandler((error, _request, reply) => {
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

    scope.get<{ Reply: AccountsResponse }>("/accounts", { preHandler: [requireSession] }, async () => {
      const accounts = await service.listAccounts();
      return { accounts: accounts.map(toAccountView) };
    });

    scope.post<{ Body: AccountCreateBody; Reply: AccountResponse }>(
      "/accounts",
      {
        schema: {
          body: {
            type: "object",
            required: ["label", "color", "username", "password"],
            properties: {
              label: { type: "string", minLength: 1, maxLength: 64 },
              color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
              imapHost: { type: "string", maxLength: 253 },
              imapPort: { type: "integer", minimum: 1, maximum: 65535 },
              smtpHost: { type: "string", maxLength: 253 },
              smtpPort: { type: "integer", minimum: 1, maximum: 65535 },
              smtpSecurity: { enum: ["starttls_required", "implicit_tls"] },
              username: { type: "string", minLength: 1, maxLength: 255 },
              password: { type: "string", minLength: 1, maxLength: 4096 },
              identities: { type: "array", maxItems: 64, items: identitySchema },
              classifyEnabled: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        const body = request.body;
        const account = await service.createAccount(
          { requestGeneration: readRequestGeneration(request) },
          {
            label: body.label,
            color: body.color,
            imapHost: body.imapHost,
            imapPort: body.imapPort,
            smtpHost: body.smtpHost,
            smtpPort: body.smtpPort,
            smtpSecurity: body.smtpSecurity,
            username: body.username,
            password: body.password,
            identities: body.identities,
            classifyEnabled: body.classifyEnabled,
          },
        );
        return reply.code(201).send({ account: toAccountView(account) });
      },
    );

    scope.get<{ Params: { id: string }; Reply: AccountResponse }>(
      "/accounts/:id",
      { schema: { params: accountParams }, preHandler: [requireSession] },
      async (request) => ({ account: toAccountView(await service.readAccount(request.params.id)) }),
    );

    scope.patch<{ Params: { id: string }; Body: AccountEditBody; Reply: AccountResponse }>(
      "/accounts/:id",
      {
        schema: {
          params: accountParams,
          body: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: 64 },
              color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
              imapHost: { type: "string", maxLength: 253 },
              imapPort: { type: "integer", minimum: 1, maximum: 65535 },
              smtpHost: { type: "string", maxLength: 253 },
              smtpPort: { type: "integer", minimum: 1, maximum: 65535 },
              smtpSecurity: { enum: ["starttls_required", "implicit_tls"] },
              username: { type: "string", minLength: 1, maxLength: 255 },
              classifyEnabled: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => ({
        account: toAccountView(
          await service.updateAccount(
            { requestGeneration: readRequestGeneration(request) },
            request.params.id,
            {
              label: request.body.label,
              color: request.body.color,
              imapHost: request.body.imapHost,
              imapPort: request.body.imapPort,
              smtpHost: request.body.smtpHost,
              smtpPort: request.body.smtpPort,
              smtpSecurity: request.body.smtpSecurity,
              username: request.body.username,
              classifyEnabled: request.body.classifyEnabled,
            },
          ),
        ),
      }),
    );

    scope.put<{ Params: { id: string }; Body: { password: string } }>(
      "/accounts/:id/password",
      {
        schema: {
          params: accountParams,
          body: {
            type: "object",
            required: ["password"],
            properties: { password: { type: "string", minLength: 1, maxLength: 4096 } },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        await service.updatePassword(
          { requestGeneration: readRequestGeneration(request) },
          request.params.id,
          request.body.password,
        );
        return reply.code(204).send();
      },
    );

    scope.put<{ Params: { id: string }; Body: { identities: AccountIdentityInput[] }; Reply: AccountResponse }>(
      "/accounts/:id/identities",
      {
        schema: {
          params: accountParams,
          body: {
            type: "object",
            required: ["identities"],
            properties: { identities: { type: "array", maxItems: 64, items: identitySchema } },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) => ({
        account: toAccountView(
          await service.setIdentities(
            { requestGeneration: readRequestGeneration(request) },
            request.params.id,
            request.body.identities,
          ),
        ),
      }),
    );

    scope.get<{ Params: { id: string }; Reply: AccountFoldersResponse }>(
      "/accounts/:id/folders",
      { schema: { params: accountParams }, preHandler: [requireSession] },
      async (request) => await service.listFolders(request.params.id),
    );

    scope.post<{ Params: { id: string }; Body: { folders: DiscoveredFolder[] }; Reply: FolderImportResponse }>(
      "/accounts/:id/folders/import",
      {
        schema: {
          params: accountParams,
          body: {
            type: "object",
            required: ["folders"],
            properties: {
              folders: {
                type: "array",
                maxItems: 1024,
                items: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 512 },
                    specialUse: { type: "array", items: { type: "string", maxLength: 32 }, maxItems: 8 },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) =>
        await service.importFolders(
          { requestGeneration: readRequestGeneration(request) },
          request.params.id,
          request.body.folders,
        ),
    );

    scope.put<{ Params: { id: string; folderId: string }; Body: { role: FolderRole }; Reply: FolderSummary }>(
      "/accounts/:id/folders/:folderId/role",
      {
        schema: {
          params: folderParams,
          body: {
            type: "object",
            required: ["role"],
            properties: { role: { enum: ["inbox", "sent", "drafts", "archive", "trash", "junk"] } },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request) =>
        await service.assignFolderRole(
          { requestGeneration: readRequestGeneration(request) },
          request.params.id,
          request.params.folderId,
          request.body.role,
        ),
    );

    scope.delete<{ Params: { id: string; folderId: string }; Reply: FolderSummary }>(
      "/accounts/:id/folders/:folderId/role",
      { schema: { params: folderParams }, preHandler: [requireOrigin, requireSession] },
      async (request) =>
        await service.clearFolderRole(
          { requestGeneration: readRequestGeneration(request) },
          request.params.id,
          request.params.folderId,
        ),
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

/** The body of `POST /accounts`. */
interface AccountCreateBody {
  label: string;
  color: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SmtpSecurityMode;
  username: string;
  password: string;
  identities?: AccountIdentityInput[];
  classifyEnabled?: boolean;
}

/** The body of `PATCH /accounts/:id`. */
interface AccountEditBody {
  label?: string;
  color?: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SmtpSecurityMode;
  username?: string;
  classifyEnabled?: boolean;
}

/** One stored account summary in its wire form: the date becomes ISO text. */
function toAccountView(account: StoredAccountSummary): AccountSummary {
  return {
    id: account.id,
    label: account.label,
    color: account.color,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecurity: account.smtpSecurity,
    username: account.username,
    identities: account.identities,
    classifyEnabled: account.classifyEnabled,
    createdAt: account.createdAt.toISOString(),
  };
}
