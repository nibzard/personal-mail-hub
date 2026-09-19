import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AccountErrorBody, AccountsResponse } from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { RecoveryBlockedError, type ControlStatus } from "@mail-hub/recovery";
import {
  AccountError,
  type AccountFolders,
  type AccountSummary,
  type CreateAccountInput,
  type FolderImportResult,
  type FolderSummary,
  type MutationContext,
} from "@mail-hub/accounts";
import { buildApp } from "../src/app.ts";
import { registerAccountRoutes, type AccountServiceForRoutes } from "../src/account-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F1 and section 9): origin and session
 * enforcement, recovery-generation forwarding, error mapping, and response
 * bodies without password material. Role mapping and sealing are covered by
 * the `@mail-hub/accounts` suite.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const CURRENT_GENERATION = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-18T10:00:00.000Z");
const ACCOUNT_ID = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const FOLDER_ID = "6f2c1b98-93b4-45f2-8f5f-2a7d1c0e4b77";

const ACCOUNT: AccountSummary = {
  id: ACCOUNT_ID,
  label: "Main mailbox",
  color: "#2563eb",
  imapHost: "imap.purelymail.com",
  imapPort: 993,
  smtpHost: "smtp.purelymail.com",
  smtpPort: 587,
  smtpSecurity: "starttls_required",
  username: "user@example.com",
  identities: [{ address: "user@example.com", name: "Main User", isDefault: true }],
  classifyEnabled: true,
  createdAt: NOW,
};

const FOLDER: FolderSummary = { id: FOLDER_ID, name: "INBOX", role: "inbox" };

/** What the fake service recorded, for call assertions. */
interface ServiceCalls {
  createGenerations: (string | null | undefined)[];
  createdLabels: string[];
  updatedIds: string[];
  passwordIds: string[];
  identityIds: string[];
  importedFolders: { accountId: string; names: string[] }[];
  assignedRoles: { accountId: string; folderId: string; role: string }[];
  clearedFolderIds: { accountId: string; folderId: string }[];
}

/** A controllable stand-in for the account service. */
function fakeService(
  overrides: Partial<AccountServiceForRoutes> = {},
): AccountServiceForRoutes & { calls: ServiceCalls } {
  const calls: ServiceCalls = {
    createGenerations: [],
    createdLabels: [],
    updatedIds: [],
    passwordIds: [],
    identityIds: [],
    importedFolders: [],
    assignedRoles: [],
    clearedFolderIds: [],
  };
  const base = {
    async listAccounts() {
      return [ACCOUNT];
    },
    async readAccount(id: string) {
      if (id !== ACCOUNT_ID) {
        throw new AccountError("not_found", "This account does not exist.");
      }
      return ACCOUNT;
    },
    async createAccount(context: MutationContext, input: CreateAccountInput) {
      calls.createGenerations.push(context.requestGeneration);
      calls.createdLabels.push(input.label);
      return { ...ACCOUNT, label: input.label, classifyEnabled: input.classifyEnabled !== false };
    },
    async updateAccount(_context: MutationContext, id: string) {
      calls.updatedIds.push(id);
      return ACCOUNT;
    },
    async updatePassword(_context: MutationContext, id: string, _password: string) {
      calls.passwordIds.push(id);
    },
    async setIdentities(_context: MutationContext, id: string) {
      calls.identityIds.push(id);
      return ACCOUNT;
    },
    async listFolders(id: string): Promise<AccountFolders> {
      if (id !== ACCOUNT_ID) {
        throw new AccountError("not_found", "This account does not exist.");
      }
      return { folders: [FOLDER], pendingRoleChoices: ["archive"] };
    },
    async importFolders(
      _context: MutationContext,
      id: string,
      discovered: { name: string }[],
    ): Promise<FolderImportResult & AccountFolders> {
      calls.importedFolders.push({ accountId: id, names: discovered.map((folder) => folder.name) });
      return {
        created: [FOLDER],
        assignedRoles: { inbox: FOLDER.name },
        ambiguousRoles: [],
        conflicts: [],
        folders: [FOLDER],
        pendingRoleChoices: ["archive"],
      };
    },
    async assignFolderRole(_context: MutationContext, accountId: string, folderId: string, role: string) {
      calls.assignedRoles.push({ accountId, folderId, role });
      return { ...FOLDER, role: role as FolderSummary["role"] };
    },
    async clearFolderRole(_context: MutationContext, accountId: string, folderId: string) {
      calls.clearedFolderIds.push({ accountId, folderId });
      return { ...FOLDER, role: null };
    },
    ...overrides,
  };
  return Object.assign(base as AccountServiceForRoutes, { calls });
}

const apps: FastifyInstance[] = [];

function appWith(
  service: AccountServiceForRoutes,
  status: ControlStatus = { state: "ready", generation: GENERATION },
): FastifyInstance {
  const app = buildApp();
  apps.push(app);
  void registerAccountRoutes(app, {
    service,
    origin: ORIGIN,
    verifySession: async (token) => {
      if (token !== TOKEN) {
        throw new AuthError("unauthorized", "Sign in to continue.");
      }
      return null;
    },
    controls: { readStatus: async () => status },
  });
  return app;
}

const headers = { origin: ORIGIN };
const withCookie = { ...headers, cookie: `${SESSION_COOKIE}=${TOKEN}` };
const withGeneration = { ...withCookie, "x-recovery-generation": GENERATION };

describe("the account routes", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("lists accounts for a valid session, with ISO dates and no password", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "GET", url: "/accounts", headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AccountsResponse;
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toEqual({
      id: ACCOUNT_ID,
      label: "Main mailbox",
      color: "#2563eb",
      imapHost: "imap.purelymail.com",
      imapPort: 993,
      smtpHost: "smtp.purelymail.com",
      smtpPort: 587,
      smtpSecurity: "starttls_required",
      username: "user@example.com",
      identities: [{ address: "user@example.com", name: "Main User", isDefault: true }],
      classifyEnabled: true,
      createdAt: NOW.toISOString(),
    });
    expect(response.body).not.toContain("password");
  });

  it("exposes the current recovery generation on the session probe", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "GET", url: "/accounts", headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    expect((response.json() as AccountsResponse).recoveryGeneration).toBe(GENERATION);
  });

  it("exposes the deployed generation during a mismatch, and null without configuration", async () => {
    const mismatched: ControlStatus = {
      state: "generation_mismatch",
      deploymentGeneration: CURRENT_GENERATION,
      databaseGeneration: GENERATION,
      mode: "ready",
    };
    const mismatchApp = appWith(fakeService(), mismatched);
    const mismatchResponse = await mismatchApp.inject({
      method: "GET",
      url: "/accounts",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect((mismatchResponse.json() as AccountsResponse).recoveryGeneration).toBe(
      CURRENT_GENERATION,
    );

    const unconfiguredApp = appWith(fakeService(), { state: "config_missing" });
    const unconfiguredResponse = await unconfiguredApp.inject({
      method: "GET",
      url: "/accounts",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect((unconfiguredResponse.json() as AccountsResponse).recoveryGeneration).toBeNull();
  });

  it("rejects reads without a session", async () => {
    const app = appWith(fakeService());

    const missing = await app.inject({ method: "GET", url: "/accounts" });
    expect(missing.statusCode).toBe(401);
    expect((missing.json() as AccountErrorBody).error.code).toBe("unauthorized");

    const unknown = await app.inject({
      method: "GET",
      url: "/accounts",
      headers: { cookie: `${SESSION_COOKIE}=other-token` },
    });
    expect(unknown.statusCode).toBe(401);
  });

  it("rejects state changes without the deployed origin", async () => {
    const app = appWith(fakeService());

    const missing = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
      payload: validCreateBody(),
    });
    expect(missing.statusCode).toBe(403);
    expect((missing.json() as AccountErrorBody).error.code).toBe("origin_forbidden");

    const foreign = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: { origin: "https://attacker.example", cookie: `${SESSION_COOKIE}=${TOKEN}` },
      payload: validCreateBody(),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("rejects state changes without a session", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "POST", url: "/accounts", headers, payload: validCreateBody() });
    expect(response.statusCode).toBe(401);
    expect((response.json() as AccountErrorBody).error.code).toBe("unauthorized");
  });

  it("creates an account and forwards the recovery generation", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: withGeneration,
      payload: validCreateBody(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ account: { label: "Main mailbox", classifyEnabled: true } });
    expect(response.body).not.toContain("mailbox-secret");
    expect(service.calls.createGenerations).toEqual([GENERATION]);
  });

  it("maps account errors to their HTTP status", async () => {
    const invalid = appWith(
      fakeService({
        async createAccount() {
          throw new AccountError("invalid_request", "The account label is not valid.");
        },
      }),
    );
    const bad = await invalid.inject({ method: "POST", url: "/accounts", headers: withGeneration, payload: validCreateBody() });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as AccountErrorBody).error.code).toBe("invalid_request");

    const missing = appWith(fakeService());
    const notFound = await missing.inject({
      method: "GET",
      url: `/accounts/${ACCOUNT_ID.replace("9", "8")}`,
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(notFound.statusCode).toBe(404);
    expect((notFound.json() as AccountErrorBody).error.code).toBe("not_found");
  });

  it("maps a blocked mutation to 409 with the current generation", async () => {
    const app = appWith(
      fakeService({
        async createAccount() {
          throw new RecoveryBlockedError("recovery_required", CURRENT_GENERATION);
        },
      }),
    );
    const response = await app.inject({ method: "POST", url: "/accounts", headers: withGeneration, payload: validCreateBody() });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "recovery_required",
        message: expect.any(String),
        currentGeneration: CURRENT_GENERATION,
      },
    });
  });

  it("rejects malformed paths and bodies with 400", async () => {
    const app = appWith(fakeService());

    const badId = await app.inject({
      method: "GET",
      url: "/accounts/not-a-uuid",
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(badId.statusCode).toBe(400);

    const missingPassword = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: withGeneration,
      payload: { label: "Main", color: "#2563eb", username: "user@example.com" },
    });
    expect(missingPassword.statusCode).toBe(400);

    // Fastify strips unknown fields, so they never reach the service.
    const extraField = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: withGeneration,
      payload: { ...validCreateBody(), unexpected: true },
    });
    expect(extraField.statusCode).toBe(201);

    const badColor = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: withGeneration,
      payload: { ...validCreateBody(), color: "blue" },
    });
    expect(badColor.statusCode).toBe(400);
  });

  it("changes the password with 204 and forwards no body", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "PUT",
      url: `/accounts/${ACCOUNT_ID}/password`,
      headers: withGeneration,
      payload: { password: "rotated-secret" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(service.calls.passwordIds).toEqual([ACCOUNT_ID]);
  });

  it("replaces identities and returns the account", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "PUT",
      url: `/accounts/${ACCOUNT_ID}/identities`,
      headers: withGeneration,
      payload: { identities: [{ address: "alias@example.com", name: null, isDefault: true }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ account: { id: ACCOUNT_ID } });
    expect(service.calls.identityIds).toEqual([ACCOUNT_ID]);
  });

  it("lists folders with the pending role choices", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({
      method: "GET",
      url: `/accounts/${ACCOUNT_ID}/folders`,
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ folders: [FOLDER], pendingRoleChoices: ["archive"] });
  });

  it("imports a discovery run and forwards its folders", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID}/folders/import`,
      headers: withGeneration,
      payload: { folders: [{ name: "INBOX" }, { name: "Sent", specialUse: ["\\Sent"] }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      created: [FOLDER],
      assignedRoles: { inbox: "INBOX" },
      ambiguousRoles: [],
      conflicts: [],
      folders: [FOLDER],
      pendingRoleChoices: ["archive"],
    });
    expect(service.calls.importedFolders).toEqual([{ accountId: ACCOUNT_ID, names: ["INBOX", "Sent"] }]);
  });

  it("assigns and clears one folder role", async () => {
    const service = fakeService();
    const app = appWith(service);

    const assigned = await app.inject({
      method: "PUT",
      url: `/accounts/${ACCOUNT_ID}/folders/${FOLDER_ID}/role`,
      headers: withGeneration,
      payload: { role: "archive" },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({ ...FOLDER, role: "archive" });
    expect(service.calls.assignedRoles).toEqual([{ accountId: ACCOUNT_ID, folderId: FOLDER_ID, role: "archive" }]);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/accounts/${ACCOUNT_ID}/folders/${FOLDER_ID}/role`,
      headers: withGeneration,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ ...FOLDER, role: null });
    expect(service.calls.clearedFolderIds).toEqual([{ accountId: ACCOUNT_ID, folderId: FOLDER_ID }]);
  });
});

/** A body that satisfies the create-account schema. */
function validCreateBody() {
  return {
    label: "Main mailbox",
    color: "#2563eb",
    username: "user@example.com",
    password: "mailbox-secret",
    identities: [{ address: "user@example.com", name: "Main User", isDefault: true }],
  };
}
