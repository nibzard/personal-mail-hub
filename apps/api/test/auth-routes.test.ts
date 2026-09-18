import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AuthErrorBody, AuthStatusResponse } from "@mail-hub/contracts";
import { AuthError, type CredentialSummary, type SessionInfo } from "@mail-hub/auth";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { buildApp } from "../src/app.ts";
import { registerAuthRoutes, SESSION_COOKIE, type AuthServiceForRoutes } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC section 9): origin enforcement, cookie flags,
 * session resolution, and `AuthError` to HTTP mapping. Ceremony verification
 * is covered by the `@mail-hub/auth` suite.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const NOW = new Date("2026-09-18T10:00:00.000Z");
const SESSION: SessionInfo = {
  id: "58c04f61-7e2c-4a3c-9b32-8f9db6c04fac",
  kind: "standard",
  verifiedAt: NOW,
  expiresAt: new Date("2026-09-25T10:00:00.000Z"),
};
const CREDENTIAL: CredentialSummary = {
  id: "3b2194ea-e26b-4db1-b22e-6bb0f4d94a91",
  label: "MacBook",
  createdAt: NOW,
  lastUsedAt: NOW,
};

/** What the fake service recorded, for call assertions. */
interface ServiceCalls {
  revoked: string[];
  removed: string[];
  enrolledLabels: string[];
}

/** A controllable stand-in for the passkey service. */
function fakeService(overrides: Partial<AuthServiceForRoutes> = {}): AuthServiceForRoutes & { calls: ServiceCalls } {
  const calls: ServiceCalls = {
    revoked: [],
    removed: [],
    enrolledLabels: [],
  };
  const base = {
    async readStatus(): Promise<AuthStatusResponse> {
      return { ownerRegistered: true, login: "available", control: "ready" };
    },
    async startEnrollment() {
      return { challenge: "enroll-challenge" };
    },
    async completeEnrollment(input: { grantToken: string; label: string }) {
      calls.enrolledLabels.push(input.label);
      return { token: TOKEN, session: SESSION };
    },
    async startLogin() {
      return { challenge: "login-challenge" };
    },
    async completeLogin() {
      return { token: TOKEN, session: SESSION };
    },
    async revokeSession(token: string) {
      calls.revoked.push(token);
    },
    async verifySession(token: string) {
      if (token !== TOKEN) {
        throw new AuthError("unauthorized", "Sign in to continue.");
      }
      return SESSION;
    },
    async startReverification() {
      return { challenge: "verify-challenge" };
    },
    async completeReverification() {
      return SESSION;
    },
    async listCredentials() {
      return [CREDENTIAL];
    },
    async startCredentialEnrollment() {
      return { challenge: "add-challenge" };
    },
    async completeCredentialEnrollment(_token: string, label: string, _response: RegistrationResponseJSON) {
      calls.enrolledLabels.push(label);
      return CREDENTIAL;
    },
    async removeCredential(_token: string, credentialId: string) {
      calls.removed.push(credentialId);
    },
    ...overrides,
  };
  return Object.assign(base as AuthServiceForRoutes, { calls });
}

const apps: FastifyInstance[] = [];

function appWith(service: AuthServiceForRoutes): FastifyInstance {
  const app = buildApp();
  apps.push(app);
  void registerAuthRoutes(app, { service, origin: ORIGIN });
  return app;
}

const headers = { origin: ORIGIN };
const withCookie = { ...headers, cookie: `${SESSION_COOKIE}=${TOKEN}` };

describe("the owner authentication routes", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("exposes the public status without an origin or session", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "GET", url: "/auth/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ownerRegistered: true, login: "available", control: "ready" });
  });

  it("rejects state changes without the deployed origin", async () => {
    const app = appWith(fakeService());

    const missing = await app.inject({ method: "POST", url: "/auth/login/start" });
    expect(missing.statusCode).toBe(403);
    expect((missing.json() as AuthErrorBody).error.code).toBe("origin_forbidden");

    const foreign = await app.inject({
      method: "POST",
      url: "/auth/login/start",
      headers: { origin: "https://attacker.example" },
    });
    expect(foreign.statusCode).toBe(403);
    expect((foreign.json() as AuthErrorBody).error.code).toBe("origin_forbidden");
  });

  it("accepts a state change with the deployed origin", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "POST", url: "/auth/login/start", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ options: { challenge: "login-challenge" } });
  });

  it("maps blocked login to 503", async () => {
    const app = appWith(
      fakeService({
        async startLogin() {
          throw new AuthError("login_blocked", "Sign-in is blocked.");
        },
      }),
    );
    const response = await app.inject({ method: "POST", url: "/auth/login/start", headers });
    expect(response.statusCode).toBe(503);
    expect((response.json() as AuthErrorBody).error.code).toBe("login_blocked");
  });

  it("sets a strict session cookie on login", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "POST", url: "/auth/login/complete", headers, payload: { response: webauthnBody() } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: "standard",
      verifiedAt: NOW.toISOString(),
      expiresAt: "2026-09-25T10:00:00.000Z",
    });

    const cookie = setCookieHeader(response);
    expect(cookie).toContain(`${SESSION_COOKIE}=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  it("rejects session routes without a cookie", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "GET", url: "/auth/credentials" });
    expect(response.statusCode).toBe(401);
    expect((response.json() as AuthErrorBody).error.code).toBe("unauthorized");
  });

  it("rejects an unknown session cookie", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({
      method: "GET",
      url: "/auth/credentials",
      headers: { cookie: `${SESSION_COOKIE}=other-token` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("lists credentials with ISO dates for a valid session", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "GET", url: "/auth/credentials", headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      credentials: [
        {
          id: CREDENTIAL.id,
          label: CREDENTIAL.label,
          createdAt: NOW.toISOString(),
          lastUsedAt: NOW.toISOString(),
        },
      ],
    });
  });

  it("returns 204 and clears the cookie on logout", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({ method: "POST", url: "/auth/logout", headers: withCookie });
    expect(response.statusCode).toBe(204);
    expect(service.calls.revoked).toEqual([TOKEN]);
    expect(setCookieHeader(response)).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });

  it("requires recent verification for passkey changes", async () => {
    const app = appWith(
      fakeService({
        async startCredentialEnrollment() {
          throw new AuthError("verification_required", "Verify with a passkey.");
        },
      }),
    );
    const response = await app.inject({ method: "POST", url: "/auth/credentials/add/start", headers: withCookie });
    expect(response.statusCode).toBe(403);
    expect((response.json() as AuthErrorBody).error.code).toBe("verification_required");
  });

  it("protects the last passkey with 409", async () => {
    const app = appWith(
      fakeService({
        async removeCredential() {
          throw new AuthError("last_credential", "At least one passkey must remain.");
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/credentials/remove",
      headers: withCookie,
      payload: { id: CREDENTIAL.id },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as AuthErrorBody).error.code).toBe("last_credential");
  });

  it("removes a passkey with 204 and forwards the identifier", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "POST",
      url: "/auth/credentials/remove",
      headers: withCookie,
      payload: { id: CREDENTIAL.id },
    });
    expect(response.statusCode).toBe(204);
    expect(service.calls.removed).toEqual([CREDENTIAL.id]);
  });

  it("rejects malformed request bodies with 400", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({ method: "POST", url: "/auth/enroll/start", headers, payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rejects an invalid enrollment grant with 403", async () => {
    const app = appWith(
      fakeService({
        async startEnrollment() {
          throw new AuthError("grant_invalid", "This enrollment token is not valid.");
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/auth/enroll/start",
      headers,
      payload: { grantToken: "an-enrollment-token-value" },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as AuthErrorBody).error.code).toBe("grant_invalid");
  });

  it("forwards the label on enrollment completion", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "POST",
      url: "/auth/enroll/complete",
      headers,
      payload: { grantToken: "an-enrollment-token-value", label: "MacBook", response: webauthnBody() },
    });
    expect(response.statusCode).toBe(200);
    expect(service.calls.enrolledLabels).toEqual(["MacBook"]);
  });
});

/** All `set-cookie` header values, joined for substring checks. */
function setCookieHeader(response: { headers: Record<string, unknown> }): string {
  const value = response.headers["set-cookie"];
  if (value === undefined) {
    return "";
  }
  return Array.isArray(value) ? value.join(" ") : String(value);
}

/** A body that satisfies the WebAuthn response schema. */
function webauthnBody(): AuthenticationResponseJSON {
  return {
    id: "credential-id",
    rawId: "credential-id",
    response: { clientDataJSON: "e30" },
    clientExtensionResults: {},
    type: "public-key",
  } as unknown as AuthenticationResponseJSON;
}
