import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { ClassificationCorrectionResponse } from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { ClassificationError, type CorrectionContext, type CorrectionResult } from "@mail-hub/classification";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { buildApp } from "../src/app.ts";
import { registerClassificationRoutes } from "../src/classification-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F8 and section 7): origin and session
 * enforcement, recovery-generation forwarding, error mapping, and body
 * validation. Scope semantics are covered by the `@mail-hub/classification`
 * suite.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

/** A stand-in result the route maps onto its wire form. */
function result(overrides: Partial<CorrectionResult> = {}): CorrectionResult {
  return {
    scope: "message",
    classHint: "correspondence",
    sender: "person@example.com",
    rule: null,
    previous: { source: "jev", classHint: "newsletter" },
    reapplied: 1,
    ...overrides,
  };
}

/** A controllable stand-in for the correction service. */
function fakeService(behavior: { error?: Error } = {}) {
  const calls: { contexts: CorrectionContext[]; bodies: unknown[] } = { contexts: [], bodies: [] };
  return {
    calls,
    async correct(context: CorrectionContext, body: unknown): Promise<CorrectionResult> {
      calls.contexts.push(context);
      calls.bodies.push(body);
      if (behavior.error !== undefined) {
        throw behavior.error;
      }
      // Echo the parts the route must carry through, so the wire form
      // proves the mapping rather than a canned answer.
      const request = body as { scope: CorrectionResult["scope"]; classHint: CorrectionResult["classHint"] };
      return result({ scope: request.scope, classHint: request.classHint });
    },
  };
}

const apps: FastifyInstance[] = [];

function appWith(service: ReturnType<typeof fakeService>): FastifyInstance {
  const app = buildApp();
  apps.push(app);
  void registerClassificationRoutes(app, {
    service,
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

const withCookie = { cookie: `${SESSION_COOKIE}=${TOKEN}` };
const withOrigin = { ...withCookie, origin: ORIGIN };
const withGeneration = { ...withOrigin, "x-recovery-generation": GENERATION };

function correctionBody(payload: Record<string, unknown>): InjectOptions {
  return { method: "POST", url: `/messages/${MESSAGE_ID}/classification/correction`, payload };
}

describe("the classification correction route", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("applies a correction for a valid session and returns its summary", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      ...correctionBody({ scope: "sender", classHint: "marketing", note: "Retail broadcasts" }),
      headers: withGeneration,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      correction: {
        scope: "sender",
        classHint: "marketing",
        sender: "person@example.com",
        rule: null,
        previous: { source: "jev", classHint: "newsletter" },
        reapplied: 1,
      },
    } satisfies ClassificationCorrectionResponse);
    expect(service.calls.contexts).toEqual([{ requestGeneration: GENERATION }]);
    expect(service.calls.bodies).toEqual([
      { messageId: MESSAGE_ID, scope: "sender", classHint: "marketing", note: "Retail broadcasts" },
    ]);
  });

  it("forwards a missing note as null and accepts a null class", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      ...correctionBody({ scope: "message", classHint: null }),
      headers: withGeneration,
    });
    expect(response.statusCode).toBe(200);
    expect(service.calls.bodies).toEqual([
      { messageId: MESSAGE_ID, scope: "message", classHint: null, note: null },
    ]);
  });

  it("rejects corrections without a session or the deployed origin", async () => {
    const app = appWith(fakeService());
    const noSession = await app.inject({
      ...correctionBody({ scope: "message", classHint: "other" }),
      headers: { origin: ORIGIN },
    });
    expect(noSession.statusCode).toBe(401);

    const badToken = await app.inject({
      ...correctionBody({ scope: "message", classHint: "other" }),
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=other-token` },
    });
    expect(badToken.statusCode).toBe(401);

    const foreignOrigin = await app.inject({
      ...correctionBody({ scope: "message", classHint: "other" }),
      headers: { origin: "https://attacker.example", cookie: `${SESSION_COOKIE}=${TOKEN}` },
    });
    expect(foreignOrigin.statusCode).toBe(403);
  });

  it("rejects bodies outside the contract", async () => {
    const app = appWith(fakeService());
    const responses = await Promise.all([
      app.inject({ ...correctionBody({ scope: "everything", classHint: "other" }), headers: withGeneration }),
      app.inject({ ...correctionBody({ scope: "message", classHint: "urgent" }), headers: withGeneration }),
      app.inject({ ...correctionBody({ scope: "message" }), headers: withGeneration }),
      app.inject({
        method: "POST",
        url: `/messages/not-a-uuid/classification/correction`,
        payload: { scope: "message", classHint: "other" },
        headers: withGeneration,
      }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
    }
  });

  it("maps service rejections onto their HTTP status", async () => {
    const invalid = appWith(fakeService({ error: new ClassificationError("invalid_request", "Scope must be named.") }));
    expect(
      (
        await invalid.inject({
          ...correctionBody({ scope: "rule", classHint: "other" }),
          headers: withGeneration,
        })
      ).statusCode,
    ).toBe(400);

    const missing = appWith(fakeService({ error: new ClassificationError("not_found", "No message.") }));
    const missingResponse = await missing.inject({
      ...correctionBody({ scope: "message", classHint: "other" }),
      headers: withGeneration,
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json()).toMatchObject({ error: { code: "not_found" } });

    const blocked = appWith(
      fakeService({ error: new RecoveryBlockedError("recovery_required", GENERATION) }),
    );
    const blockedResponse = await blocked.inject({
      ...correctionBody({ scope: "message", classHint: "other" }),
      headers: withGeneration,
    });
    expect(blockedResponse.statusCode).toBe(409);
    expect(blockedResponse.json()).toMatchObject({
      error: { code: "recovery_required", currentGeneration: GENERATION },
    });
  });
});
