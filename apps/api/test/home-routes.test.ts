import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  HomeItemView,
  HomeResponse,
  HomeSectionIdWire,
  HomeWorkRecordView,
} from "@mail-hub/contracts";
import { HomeError, type HomeMutationContext } from "@mail-hub/home";
import { AuthError } from "@mail-hub/auth";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { buildApp } from "../src/app.ts";
import { registerHomeRoutes, type HomeServiceForRoutes } from "../src/home-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F13 and section 7): origin and session
 * enforcement, schema validation at the boundary, recovery-generation
 * forwarding, and error mapping. Ranking, grouping, and storage are covered
 * by the `@mail-hub/home` suite against a real database.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const MESSAGE = "8a2f2c51-9f0b-4d1e-8c66-2a5a1b9d0e11";
const WORK = "6c1c8ff0-1cb4-4f76-9f0a-5a6b0b2d3e22";

const ITEM: HomeItemView = {
  entryKey: MESSAGE,
  message: {
    messageId: MESSAGE,
    accountId: ACCOUNT,
    accountLabel: "Main",
    accountColor: "#2563eb",
    threadId: null,
    subject: "One message",
    snippet: "A snippet",
    sender: null,
    sentAt: "2026-09-20T10:00:00.000Z",
    unread: true,
    flagged: false,
    hasAttachments: false,
  },
  messageIds: [MESSAGE],
  reasons: [{ code: "may_need_reply", origin: "suggestion" }],
  work: [],
  occurrences: [],
  noServerCopy: false,
};

const READ: HomeResponse = {
  generatedAt: "2026-09-20T12:00:00.000Z",
  sections: [
    { id: "needs_attention", total: 1, items: [ITEM], nextCursor: null },
  ],
  classification: {
    state: "active",
    description: "Classification is running.",
    considered: 40,
    answered: 12,
    newestAnswerAt: "2026-09-20T11:00:00.000Z",
  },
  visitBoundary: null,
};

const WORK_RECORD: HomeWorkRecordView = {
  id: WORK,
  kind: "reply_later",
  status: "open",
  dueAt: null,
  timeZone: null,
  revision: 1,
  anchorUnavailable: false,
  accountId: ACCOUNT,
  anchorMessageId: MESSAGE,
  anchor: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  completedAt: null,
};

/** A controllable stand-in for the Home service. */
function fakeService(overrides: { reads?: () => Promise<HomeResponse> } = {}) {
  const calls = {
    home: [] as { deviceId: string; limit?: number }[],
    sections: [] as { section: HomeSectionIdWire; cursor: string | null; limit?: number }[],
    generations: [] as (string | null | undefined)[],
  };
  const service: HomeServiceForRoutes = {
    async readHome(input) {
      calls.home.push({ deviceId: input.deviceId, ...("limit" in input ? { limit: input.limit! } : {}) });
      return overrides.reads?.() ?? READ;
    },
    async readSection(input) {
      calls.sections.push({
        section: input.section,
        cursor: input.cursor ?? null,
        ...("limit" in input ? { limit: input.limit! } : {}),
      });
      return { id: input.section, total: 1, items: [ITEM], nextCursor: null };
    },
    async listWork() {
      return [WORK_RECORD];
    },
    async createWork(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
      return WORK_RECORD;
    },
    async rescheduleWork(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
      return { ...WORK_RECORD, kind: "reminder", revision: 2 };
    },
    async completeWork(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
      return { ...WORK_RECORD, status: "done", revision: 2, completedAt: "2026-09-20T12:00:00.000Z" };
    },
    async reopenWork(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
      return WORK_RECORD;
    },
    async cancelWork(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
    },
    async listPriorities() {
      return [];
    },
    async setPriority(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
      return null;
    },
    async dismiss(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
      return { accountId: ACCOUNT, messageId: MESSAGE };
    },
    async undismiss(context: HomeMutationContext) {
      calls.generations.push(context.requestGeneration);
    },
  };
  return Object.assign(service, { calls });
}

const apps: FastifyInstance[] = [];

function appWith(service: HomeServiceForRoutes): FastifyInstance {
  const app = buildApp();
  apps.push(app);
  void registerHomeRoutes(app, {
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

const cookie = { cookie: `${SESSION_COOKIE}=${TOKEN}` };
const withOrigin = { origin: ORIGIN, ...cookie };
const withGeneration = { ...withOrigin, "x-recovery-generation": GENERATION };

describe("the home routes", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("serves the full read for a valid session and forwards the device", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "GET",
      url: "/home?deviceId=device-browser-01&limit=12",
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(READ);
    expect(service.calls.home).toEqual([{ deviceId: "device-browser-01", limit: 12 }]);
  });

  it("rejects reads without a session or without a device identifier", async () => {
    const app = appWith(fakeService());
    const missing = await app.inject({ method: "GET", url: "/home?deviceId=device-browser-01" });
    expect(missing.statusCode).toBe(401);
    const short = await app.inject({ method: "GET", url: "/home?deviceId=short", headers: cookie });
    expect(short.statusCode).toBe(400);
    const absent = await app.inject({ method: "GET", url: "/home", headers: cookie });
    expect(absent.statusCode).toBe(400);
    const badLimit = await app.inject({
      method: "GET",
      url: "/home?deviceId=device-browser-01&limit=0",
      headers: cookie,
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it("serves one section page and forwards its cursor", async () => {
    const service = fakeService();
    const app = appWith(service);
    const response = await app.inject({
      method: "GET",
      url: "/home/sections/needs_attention?cursor=abc123&limit=5",
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { section: { id: string } }).section.id).toBe("needs_attention");
    expect(service.calls.sections).toEqual([
      { section: "needs_attention", cursor: "abc123", limit: 5 },
    ]);

    const unknown = await app.inject({
      method: "GET",
      url: "/home/sections/favorites",
      headers: cookie,
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("lists saved work with the standing filters", async () => {
    const app = appWith(fakeService());
    const response = await app.inject({
      method: "GET",
      url: "/home/work?status=open&kind=reminder",
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { work: HomeWorkRecordView[] };
    expect(body.work).toEqual([WORK_RECORD]);
    const badStatus = await app.inject({
      method: "GET",
      url: "/home/work?status=archived",
      headers: cookie,
    });
    expect(badStatus.statusCode).toBe(400);
  });

  it("requires the deployed origin and the generation on work creation", async () => {
    const service = fakeService();
    const app = appWith(service);
    const payload = { accountId: ACCOUNT, anchorMessageId: MESSAGE, kind: "reply_later" };

    const noOrigin = await app.inject({
      method: "POST",
      url: "/home/work",
      headers: { ...cookie, "x-recovery-generation": GENERATION },
      payload,
    });
    expect(noOrigin.statusCode).toBe(403);

    const noGeneration = await app.inject({
      method: "POST",
      url: "/home/work",
      headers: withOrigin,
      payload,
    });
    expect(noGeneration.statusCode).toBe(200);
    expect(service.calls.generations).toEqual([undefined]);

    const created = await app.inject({
      method: "POST",
      url: "/home/work",
      headers: withGeneration,
      payload,
    });
    expect(created.statusCode).toBe(200);
    expect(service.calls.generations).toEqual([undefined, GENERATION]);
  });

  it("refuses bodies outside the work schemas", async () => {
    const app = appWith(fakeService());
    const cases: { url: string; payload: Record<string, unknown> }[] = [
      {
        url: "/home/work",
        payload: { accountId: ACCOUNT, anchorMessageId: MESSAGE, kind: "someday" },
      },
      {
        url: "/home/work",
        payload: { accountId: "not-a-uuid", anchorMessageId: MESSAGE, kind: "reply_later" },
      },
      {
        // A reminder freezes the resolved instant and the zone.
        url: "/home/work",
        payload: { accountId: ACCOUNT, anchorMessageId: MESSAGE, kind: "reminder" },
      },
      {
        url: `/home/work/${WORK}/reschedule`,
        payload: { revision: 1, dueAt: "2026-09-21T09:00:00Z" },
      },
      { url: `/home/work/${WORK}/complete`, payload: { revision: 0 } },
      { url: `/home/work/${WORK}/reopen`, payload: {} },
    ];
    for (const entry of cases) {
      const response = await app.inject({
        method: "POST",
        url: entry.url,
        headers: withGeneration,
        payload: entry.payload,
      });
      expect(response.statusCode, entry.url).toBe(400);
    }
  });

  it("drives the work life cycle and answers 204 on cancel", async () => {
    const app = appWith(fakeService());
    const rescheduled = await app.inject({
      method: "POST",
      url: `/home/work/${WORK}/reschedule`,
      headers: withGeneration,
      payload: { revision: 1, dueAt: "2026-09-21T09:00:00Z", timeZone: "Europe/Berlin" },
    });
    expect(rescheduled.statusCode).toBe(200);

    const completed = await app.inject({
      method: "POST",
      url: `/home/work/${WORK}/complete`,
      headers: withGeneration,
      payload: { revision: 2 },
    });
    expect(completed.statusCode).toBe(200);

    const reopened = await app.inject({
      method: "POST",
      url: `/home/work/${WORK}/reopen`,
      headers: withGeneration,
      payload: { revision: 3 },
    });
    expect(reopened.statusCode).toBe(200);

    const cancelled = await app.inject({
      method: "POST",
      url: `/home/work/${WORK}/cancel`,
      headers: withGeneration,
      payload: { revision: 4 },
    });
    expect(cancelled.statusCode).toBe(204);
  });

  it("lists and records priority choices", async () => {
    const service = fakeService();
    const app = appWith(service);
    const listed = await app.inject({ method: "GET", url: "/home/priorities", headers: cookie });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { priorities: unknown[] }).priorities).toEqual([]);

    const set = await app.inject({
      method: "PUT",
      url: "/home/priorities",
      headers: withGeneration,
      payload: {
        accountId: ACCOUNT,
        target: { kind: "sender", sender: "Bank@Old.example" },
        prioritized: true,
      },
    });
    expect(set.statusCode).toBe(200);
    expect(service.calls.generations).toEqual([GENERATION]);

    const badTarget = await app.inject({
      method: "PUT",
      url: "/home/priorities",
      headers: withGeneration,
      payload: { accountId: ACCOUNT, target: { kind: "folder" }, prioritized: true },
    });
    expect(badTarget.statusCode).toBe(400);
  });

  it("records and removes dismissals", async () => {
    const service = fakeService();
    const app = appWith(service);
    const dismissed = await app.inject({
      method: "POST",
      url: "/home/dismissals",
      headers: withGeneration,
      payload: { accountId: ACCOUNT, messageId: MESSAGE },
    });
    expect(dismissed.statusCode).toBe(201);
    expect((dismissed.json() as { dismissed: unknown }).dismissed).toEqual({
      accountId: ACCOUNT,
      messageId: MESSAGE,
    });

    const restored = await app.inject({
      method: "DELETE",
      url: `/home/dismissals/${MESSAGE}?accountId=${ACCOUNT}`,
      headers: withGeneration,
    });
    expect(restored.statusCode).toBe(204);

    const unscoped = await app.inject({
      method: "DELETE",
      url: `/home/dismissals/${MESSAGE}`,
      headers: withGeneration,
    });
    expect(unscoped.statusCode).toBe(400);
    expect(service.calls.generations).toEqual([GENERATION, GENERATION]);
  });

  it("maps Home and recovery rejections onto their status codes", async () => {
    const stale = Object.assign(fakeService(), {
      async rescheduleWork() {
        throw new HomeError("work_stale", "This saved work changed on another device.", 409, 7);
      },
    });
    const app = appWith(stale);
    const response = await app.inject({
      method: "POST",
      url: `/home/work/${WORK}/reschedule`,
      headers: withGeneration,
      payload: { revision: 1, dueAt: "2026-09-21T09:00:00Z", timeZone: "UTC" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "work_stale",
        message: "This saved work changed on another device.",
        currentRevision: 7,
      },
    });

    const missing = Object.assign(fakeService(), {
      async readHome() {
        throw new HomeError("invalid_request", "The device identifier must be 8 to 100 characters.");
      },
    });
    const missingApp = appWith(missing);
    const missingResponse = await missingApp.inject({
      method: "GET",
      url: "/home?deviceId=device-browser-01",
      headers: cookie,
    });
    expect(missingResponse.statusCode).toBe(400);

    const blocked = Object.assign(fakeService(), {
      async createWork() {
        throw new RecoveryBlockedError("recovery_required", GENERATION);
      },
    });
    const blockedApp = appWith(blocked);
    const blockedResponse = await blockedApp.inject({
      method: "POST",
      url: "/home/work",
      headers: withGeneration,
      payload: { accountId: ACCOUNT, anchorMessageId: MESSAGE, kind: "reply_later" },
    });
    expect(blockedResponse.statusCode).toBe(409);
    expect(blockedResponse.json().error).toMatchObject({
      code: "recovery_required",
      currentGeneration: GENERATION,
    });
  });
});
