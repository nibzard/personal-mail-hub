import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ActionErrorBody, MailActionResponse } from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import {
  ActionError,
  type ActionReceipt,
  type MailActionSubmission,
  type SubmitResult,
} from "@mail-hub/actions";
import { buildApp } from "../src/app.ts";
import { registerActionRoutes, type ActionServiceForRoutes } from "../src/action-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F4, section 7, and section 9): session and
 * origin enforcement, body validation, recovery-generation forwarding, wire
 * views, and error mapping. Freezing, gating, and receipt rules are covered
 * by the `@mail-hub/actions` suite.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const OLD_GENERATION = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const FOLDER_ID = "b7e3d2f1-4c5a-4d69-9f30-2d1c3b4a5e6f";
const ACTION_ID = "5c2d8e7f-1a4b-4c6d-9e8f-0a1b2c3d4e5f";
const OCCURRENCE_A = "1e7b9c3d-6a42-4f8b-b5c7-8d9e0f1a2b3c";
const OCCURRENCE_B = "2f8c0d4e-7b53-4a9c-c6d8-9e0f1a2b3d4e";

const RECEIPT: ActionReceipt = {
  actionId: ACTION_ID,
  kind: "star",
  status: "complete",
  idempotencyKey: "idem-1",
  items: [
    { itemKey: OCCURRENCE_A, status: "confirmed", outcome: { unread: false } },
    { itemKey: OCCURRENCE_B, status: "conflicted", outcome: null },
  ],
};

/** What the fake service recorded, for call assertions. */
interface ServiceCalls {
  submissions: MailActionSubmission[];
  readIds: string[];
}

/** A controllable stand-in for the action service. */
function fakeService(
  overrides: Partial<ActionServiceForRoutes> = {},
): ActionServiceForRoutes & { calls: ServiceCalls } {
  const calls: ServiceCalls = { submissions: [], readIds: [] };
  const base = {
    async submit(submission: MailActionSubmission): Promise<SubmitResult> {
      calls.submissions.push(submission);
      if (submission.idempotencyKey === "conflicting") {
        throw new ActionError("idempotency_conflict", "This key was used for a different action.");
      }
      return { created: true, receipt: RECEIPT };
    },
    async receipt(actionId: string): Promise<ActionReceipt> {
      calls.readIds.push(actionId);
      if (actionId !== ACTION_ID) {
        throw new ActionError("not_found", "No action exists with that identifier.");
      }
      return RECEIPT;
    },
  };
  const merged = { ...base, ...overrides } as ActionServiceForRoutes;
  return Object.assign(merged, { calls });
}

/** Build one app with action routes and a signed-in session. */
async function makeApp(service: ActionServiceForRoutes): Promise<FastifyInstance> {
  const app = buildApp();
  await registerActionRoutes(app, {
    service,
    origin: ORIGIN,
    verifySession: (token) => {
      if (token !== TOKEN) {
        throw new AuthError("unauthorized", "Sign in to continue.");
      }
      return Promise.resolve(null);
    },
  });
  await app.ready();
  return app;
}

const sessionCookie = `${SESSION_COOKIE}=${TOKEN}`;
const originHeaders = { origin: ORIGIN, cookie: sessionCookie };

/** The body one client sends to star two frozen occurrences. */
function starBody(): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    kind: "star",
    idempotencyKey: "idem-1",
    occurrenceIds: [OCCURRENCE_A, OCCURRENCE_B],
  };
}

describe("action routes", () => {
  it("submits from the deployed origin for a live session with the captured generation", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const anonymous = await app.inject({
      method: "POST",
      url: "/actions",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: starBody(),
    });
    expect(anonymous.statusCode).toBe(401);

    const foreignOrigin = await app.inject({
      method: "POST",
      url: "/actions",
      headers: { origin: "https://evil.example", cookie: sessionCookie, "content-type": "application/json" },
      payload: starBody(),
    });
    expect(foreignOrigin.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/actions",
      headers: {
        ...originHeaders,
        "content-type": "application/json",
        "x-recovery-generation": GENERATION,
      },
      payload: starBody(),
    });
    expect(created.statusCode).toBe(201);
    expect(service.calls.submissions).toEqual([
      {
        accountId: ACCOUNT_ID,
        kind: "star",
        idempotencyKey: "idem-1",
        occurrenceIds: [OCCURRENCE_A, OCCURRENCE_B],
        recoveryGeneration: GENERATION,
      },
    ]);
    expect(created.json<MailActionResponse>().action).toEqual({
      actionId: ACTION_ID,
      kind: "star",
      status: "complete",
      idempotencyKey: "idem-1",
      items: [
        { itemKey: OCCURRENCE_A, status: "confirmed", outcome: { unread: false } },
        { itemKey: OCCURRENCE_B, status: "conflicted", outcome: null },
      ],
    });
  });

  it("forwards a missing generation header as an empty one", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/actions",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: starBody(),
    });

    expect(response.statusCode).toBe(201);
    expect(service.calls.submissions[0]!.recoveryGeneration).toBe("");
  });

  it("freezes the destination a move or archive names (SPEC F4)", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/actions",
      headers: {
        ...originHeaders,
        "content-type": "application/json",
        "x-recovery-generation": GENERATION,
      },
      payload: {
        accountId: ACCOUNT_ID,
        kind: "archive",
        idempotencyKey: "idem-2",
        occurrenceIds: [OCCURRENCE_A],
        destinationFolderId: FOLDER_ID,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.calls.submissions[0]).toEqual({
      accountId: ACCOUNT_ID,
      kind: "archive",
      idempotencyKey: "idem-2",
      occurrenceIds: [OCCURRENCE_A],
      destinationFolderId: FOLDER_ID,
      recoveryGeneration: GENERATION,
    });
  });

  it("answers a repeated idempotency key with 200 and its receipts", async () => {
    const replayed = fakeService({
      async submit() {
        return { created: false, receipt: RECEIPT };
      },
    });
    const app = await makeApp(replayed);

    const response = await app.inject({
      method: "POST",
      url: "/actions",
      headers: {
        ...originHeaders,
        "content-type": "application/json",
        "x-recovery-generation": GENERATION,
      },
      payload: starBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<MailActionResponse>().action.idempotencyKey).toBe("idem-1");
  });

  it("reads one receipt for a live session without an origin", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const anonymous = await app.inject({ method: "GET", url: `/actions/${ACTION_ID}` });
    expect(anonymous.statusCode).toBe(401);

    const read = await app.inject({
      method: "GET",
      url: `/actions/${ACTION_ID}`,
      headers: { cookie: sessionCookie },
    });
    expect(read.statusCode).toBe(200);
    expect(service.calls.readIds).toEqual([ACTION_ID]);
    expect(read.json<MailActionResponse>().action.status).toBe("complete");
  });

  it("validates the body before the service runs", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const cases: { payload: Record<string, unknown> }[] = [
      { payload: { kind: "star", idempotencyKey: "idem-1", occurrenceIds: [OCCURRENCE_A] } },
      { payload: { accountId: "not-a-uuid", kind: "star", idempotencyKey: "idem-1", occurrenceIds: [OCCURRENCE_A] } },
      { payload: { accountId: ACCOUNT_ID, kind: "delete", idempotencyKey: "idem-1", occurrenceIds: [OCCURRENCE_A] } },
      { payload: { accountId: ACCOUNT_ID, kind: "star", occurrenceIds: [OCCURRENCE_A] } },
      { payload: { accountId: ACCOUNT_ID, kind: "star", idempotencyKey: "", occurrenceIds: [OCCURRENCE_A] } },
      { payload: { accountId: ACCOUNT_ID, kind: "star", idempotencyKey: "idem-1", occurrenceIds: [] } },
      { payload: { accountId: ACCOUNT_ID, kind: "star", idempotencyKey: "idem-1", occurrenceIds: ["nope"] } },
      // A move without a destination cannot freeze its scope (SPEC F4).
      { payload: { accountId: ACCOUNT_ID, kind: "move", idempotencyKey: "idem-1", occurrenceIds: [OCCURRENCE_A] } },
    ];
    for (const { payload } of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/actions",
        headers: { ...originHeaders, "content-type": "application/json" },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(service.calls.submissions).toEqual([]);
  });

  it("maps service rejections to the error body", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const conflict = await app.inject({
      method: "POST",
      url: "/actions",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { ...starBody(), idempotencyKey: "conflicting" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<ActionErrorBody>()).toEqual({
      error: {
        code: "idempotency_conflict",
        message: "This key was used for a different action.",
      },
    });

    const missing = await app.inject({
      method: "GET",
      url: "/actions/00000000-0000-4000-8000-000000000000",
      headers: { cookie: sessionCookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ActionErrorBody>().error.code).toBe("not_found");
  });

  it("maps a blocked recovery gate to 409 with the current generation", async () => {
    const blocked = fakeService({
      async submit() {
        throw new RecoveryBlockedError("recovery_required", GENERATION);
      },
    });
    const app = await makeApp(blocked);

    const response = await app.inject({
      method: "POST",
      url: "/actions",
      headers: {
        ...originHeaders,
        "content-type": "application/json",
        "x-recovery-generation": OLD_GENERATION,
      },
      payload: starBody(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string; currentGeneration?: string } }>().error).toEqual({
      code: "recovery_required",
      message: expect.any(String),
      currentGeneration: GENERATION,
    });
  });
});
