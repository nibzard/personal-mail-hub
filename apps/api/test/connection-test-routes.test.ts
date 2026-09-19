import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ConnectionTestResponse } from "@mail-hub/contracts";
import type { ConnectionTestOutcome, ConnectionTestRequest } from "@mail-hub/transport";
import { AuthError } from "@mail-hub/auth";
import { AccountError, type AccountSummary, type AccountService } from "@mail-hub/accounts";
import { buildApp } from "../src/app.ts";
import {
  registerConnectionTestRoutes,
  type AccountServiceForConnectionTest,
  type ConnectionTester,
} from "../src/connection-test-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F1 and section 9): origin and session
 * enforcement, per-protocol reporting, and response bodies without password
 * material. The transport outcomes themselves are covered by the
 * `@mail-hub/transport` suite.
 */
const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const NOW = new Date("2026-09-18T10:00:00.000Z");
const ACCOUNT_ID = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const PASSWORD = "mailbox-secret";

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

/** One failed half and one passing half, to prove the halves stay separate. */
const OUTCOME: ConnectionTestOutcome = {
  imap: {
    protocol: "imap",
    ok: false,
    stage: "tls",
    capabilities: [],
    folders: [],
    error: { code: "tls_invalid", message: "self-signed certificate" },
  },
  smtp: {
    protocol: "smtp",
    ok: true,
    stage: "inspect",
    security: "starttls_required",
    error: null,
  },
};

/** A controllable stand-in for the account service. */
function fakeService(
  overrides: Partial<Pick<AccountService, "readAccount" | "resolveCredentials">> = {},
): AccountServiceForConnectionTest {
  return {
    async readAccount(id: string) {
      if (id !== ACCOUNT_ID) {
        throw new AccountError("not_found", "This account does not exist.");
      }
      return ACCOUNT;
    },
    async resolveCredentials(id: string) {
      if (id !== ACCOUNT_ID) {
        throw new AccountError("not_found", "This account does not exist.");
      }
      return {
        accountId: id,
        imap: { host: ACCOUNT.imapHost, port: ACCOUNT.imapPort },
        smtp: {
          host: ACCOUNT.smtpHost,
          port: ACCOUNT.smtpPort,
          security: ACCOUNT.smtpSecurity,
        },
        username: ACCOUNT.username,
        password: PASSWORD,
      };
    },
    ...overrides,
  };
}

/** A tester that records what the route handed to it. */
type RecordingTester = ConnectionTester & { requests: ConnectionTestRequest[] };

/** A tester stand-in returning the given outcome and recording its input. */
function fakeTester(outcome: ConnectionTestOutcome = OUTCOME): RecordingTester {
  const requests: ConnectionTestRequest[] = [];
  const tester = async (request: ConnectionTestRequest) => {
    requests.push(request);
    return outcome;
  };
  return Object.assign(tester, { requests });
}

const apps: FastifyInstance[] = [];

function appWith(service: AccountServiceForConnectionTest, tester: RecordingTester = fakeTester()): FastifyInstance {
  const app = buildApp();
  apps.push(app);
  void registerConnectionTestRoutes(app, {
    service,
    tester,
    origin: ORIGIN,
    verifySession: async (token) => {
      if (token !== TOKEN) {
        throw new AuthError("unauthorized", "Sign in to continue.");
      }
      return null;
    },
  });
  return app;
}

const headers = { origin: ORIGIN };
const withCookie = { ...headers, cookie: `${SESSION_COOKIE}=${TOKEN}` };

describe("the connection-test route", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("runs the stored settings and reports each protocol separately", async () => {
    const tester = fakeTester();
    const app = appWith(fakeService(), tester);
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID}/connection-test`,
      headers: withCookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(OUTCOME as ConnectionTestResponse);
    // The failed IMAP half did not sink the passing SMTP half.
    const body = response.json() as ConnectionTestResponse;
    expect(body.imap.ok).toBe(false);
    expect(body.smtp.ok).toBe(true);
  });

  it("passes the stored settings and decrypted password to the tester", async () => {
    const tester = fakeTester();
    const app = appWith(fakeService(), tester);
    await app.inject({ method: "POST", url: `/accounts/${ACCOUNT_ID}/connection-test`, headers: withCookie });

    expect(tester.requests).toEqual([
      {
        imap: { host: "imap.purelymail.com", port: 993 },
        smtp: { host: "smtp.purelymail.com", port: 587, security: "starttls_required" },
        username: "user@example.com",
        password: PASSWORD,
      },
    ]);
  });

  it("returns no password material in the response", async () => {
    const app = appWith(fakeService(), fakeTester());
    const response = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID}/connection-test`,
      headers: withCookie,
    });
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain("password");
  });

  it("rejects the call without the deployed origin", async () => {
    const app = appWith(fakeService(), fakeTester());

    const missing = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID}/connection-test`,
      headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(missing.statusCode).toBe(403);

    const foreign = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID}/connection-test`,
      headers: { origin: "https://attacker.example", cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("rejects the call without a session", async () => {
    const app = appWith(fakeService(), fakeTester());

    const missing = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID}/connection-test`,
      headers,
    });
    expect(missing.statusCode).toBe(401);

    const unknown = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID}/connection-test`,
      headers: { ...headers, cookie: `${SESSION_COOKIE}=other-token` },
    });
    expect(unknown.statusCode).toBe(401);
  });

  it("maps an unknown account to 404 and a malformed id to 400", async () => {
    const app = appWith(fakeService(), fakeTester());

    const unknown = await app.inject({
      method: "POST",
      url: `/accounts/${ACCOUNT_ID.replace("9", "8")}/connection-test`,
      headers: withCookie,
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({
      method: "POST",
      url: "/accounts/not-a-uuid/connection-test",
      headers: withCookie,
    });
    expect(malformed.statusCode).toBe(400);
  });
});
