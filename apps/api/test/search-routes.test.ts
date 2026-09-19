import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  SavedSearchesResponse,
  SearchErrorBody,
  SearchResultsResponse,
} from "@mail-hub/contracts";
import { AuthError } from "@mail-hub/auth";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { SearchError, type MutationContext, type SavedSearchRecord, type SearchHit, type SearchInput } from "@mail-hub/search";
import { buildApp } from "../src/app.ts";
import { registerSearchRoutes, type SearchServiceForRoutes } from "../src/search-routes.ts";
import { SESSION_COOKIE } from "../src/auth-routes.ts";

/**
 * Route behavior only (SPEC F5 and section 9): session enforcement, filter
 * forwarding, wire views, error mapping, and the recovery-generation
 * forwarding on saved-search writes. Query parsing and ranking rules are
 * covered by the `@mail-hub/search` suite.
 */

const ORIGIN = "http://localhost:5173";
const TOKEN = "session-token-abc123";
const GENERATION = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const ACCOUNT_B_ID = "8c1f5c04-1b5d-4aa4-8e4d-1e0f8a0a1b2c";
const FOLDER_ID = "b7e3d2f1-4c5a-4d69-9f30-2d1c3b4a5e6f";
const MESSAGE_ID = "3f0c8a21-77aa-4d5b-9e64-1c2b3a4d5e6f";
const THREAD_ID = "0aa5b6c4-2211-4c8d-8f22-9b6c5d4e3f2a";
const SAVED_ID = "6d4e7f2a-9b3c-4e58-a067-3f5d2c1b4a98";
const NOW = new Date("2026-09-18T10:00:00.000Z");

const HIT: SearchHit = {
  messageId: MESSAGE_ID,
  accountId: ACCOUNT_ID,
  accountLabel: "Main",
  accountColor: "#2563eb",
  threadId: THREAD_ID,
  subject: "Quarterly report",
  snippet: "numbers are great in the appendix",
  sender: { address: "alice@work.example", name: "Alice" },
  sentAt: NOW,
  fetchedBody: true,
  hasAttachments: false,
  unread: true,
  flagged: false,
  activeOccurrences: 1,
  noServerCopy: false,
  sentCopyStatus: null,
  rank: 0.5,
  highlight: "[Quarterly] report",
  highlightSource: "subject",
};

const SAVED: SavedSearchRecord = {
  id: SAVED_ID,
  name: "Unread work",
  query: "is:unread from:work.example",
  scope: { accountIds: [ACCOUNT_ID] },
  createdAt: NOW,
  updatedAt: NOW,
};

/** What the fake service recorded, for call assertions. */
interface ServiceCalls {
  generations: (string | null | undefined)[];
  searches: SearchInput[];
  createdNames: string[];
  deletedIds: string[];
}

/** A controllable stand-in for the search service. */
function fakeService(
  overrides: Partial<SearchServiceForRoutes> = {},
): SearchServiceForRoutes & { calls: ServiceCalls } {
  const calls: ServiceCalls = { generations: [], searches: [], createdNames: [], deletedIds: [] };
  const track = (context: MutationContext) => {
    calls.generations.push(context.requestGeneration);
  };
  const base = {
    async search(input: SearchInput) {
      calls.searches.push(input);
      if (input.query === "color:red") {
        throw new SearchError("invalid_query", 'Unknown operator "color:".');
      }
      return { results: [HIT], total: 1, indexing: { messages: 8, bodies: 5 } };
    },
    async listSavedSearches() {
      return [SAVED];
    },
    async createSavedSearch(
      context: MutationContext,
      input: { name: string; query: string; scope?: SavedSearchRecord["scope"] | null },
    ) {
      track(context);
      calls.createdNames.push(input.name);
      if (input.name === "Unread work") {
        throw new SearchError("name_conflict", 'A saved search named "Unread work" already exists.');
      }
      return { ...SAVED, name: input.name, query: input.query, scope: input.scope ?? {} };
    },
    async deleteSavedSearch(context: MutationContext, id: string) {
      track(context);
      calls.deletedIds.push(id);
      if (id !== SAVED_ID) {
        throw new SearchError("not_found", "No saved search exists with that identifier.");
      }
    },
  };
  const merged = { ...base, ...overrides } as SearchServiceForRoutes;
  return Object.assign(merged, { calls });
}

/** Build one app with search routes and a signed-in session. */
async function makeApp(service: SearchServiceForRoutes): Promise<FastifyInstance> {
  const app = buildApp();
  await registerSearchRoutes(app, {
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

describe("search routes", () => {
  it("searches for a live session and forwards every filter", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const anonymous = await app.inject({ method: "GET", url: "/search?q=quarterly" });
    expect(anonymous.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: "/search?q=quarterly",
      headers: { cookie: `${SESSION_COOKIE}=wrong` },
    });
    expect(badToken.statusCode).toBe(401);

    const searched = await app.inject({
      method: "GET",
      url: `/search?q=quarterly&account=${ACCOUNT_ID}&account=${ACCOUNT_B_ID}&domain=work.example&folder=${FOLDER_ID}&local=true&limit=10&offset=20`,
      headers: { cookie: sessionCookie },
    });
    expect(searched.statusCode).toBe(200);
    expect(service.calls.searches).toEqual([
      {
        query: "quarterly",
        accountIds: [ACCOUNT_ID, ACCOUNT_B_ID],
        domains: ["work.example"],
        folderId: FOLDER_ID,
        localOnly: true,
        limit: 10,
        offset: 20,
      },
    ]);

    const body = searched.json<SearchResultsResponse>();
    expect(body.total).toBe(1);
    expect(body.indexing).toEqual({ messages: 8, bodies: 5 });
    expect(body.results[0]).toEqual({
      messageId: MESSAGE_ID,
      accountId: ACCOUNT_ID,
      accountLabel: "Main",
      accountColor: "#2563eb",
      threadId: THREAD_ID,
      subject: "Quarterly report",
      snippet: "numbers are great in the appendix",
      sender: { address: "alice@work.example", name: "Alice" },
      sentAt: NOW.toISOString(),
      fetchedBody: true,
      hasAttachments: false,
      unread: true,
      flagged: false,
      activeOccurrences: 1,
      noServerCopy: false,
      sentCopyStatus: null,
      rank: 0.5,
      highlight: "[Quarterly] report",
      highlightSource: "subject",
    });
  });

  it("defaults an empty query and accepts one filter as a scalar", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const empty = await app.inject({ method: "GET", url: "/search", headers: { cookie: sessionCookie } });
    expect(empty.statusCode).toBe(200);
    expect(service.calls.searches[0]).toEqual({
      query: "",
      accountIds: null,
      domains: null,
      folderId: null,
      localOnly: false,
      limit: undefined,
      offset: undefined,
    });

    const scalar = await app.inject({
      method: "GET",
      url: `/search?account=${ACCOUNT_ID}`,
      headers: { cookie: sessionCookie },
    });
    expect(scalar.statusCode).toBe(200);
    expect(service.calls.searches[1]!.accountIds).toEqual([ACCOUNT_ID]);
  });

  it("rejects out-of-range pages and malformed identifiers", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const badLimit = await app.inject({
      method: "GET",
      url: "/search?limit=101",
      headers: { cookie: sessionCookie },
    });
    expect(badLimit.statusCode).toBe(400);

    const badAccount = await app.inject({
      method: "GET",
      url: "/search?account=not-a-uuid",
      headers: { cookie: sessionCookie },
    });
    expect(badAccount.statusCode).toBe(400);
  });

  it("maps service rejections to the error body", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const invalid = await app.inject({
      method: "GET",
      url: "/search?q=color%3Ared",
      headers: { cookie: sessionCookie },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<SearchErrorBody>()).toEqual({
      error: { code: "invalid_query", message: 'Unknown operator "color:".' },
    });
  });

  it("lists saved searches for a live session", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const listed = await app.inject({
      method: "GET",
      url: "/searches/saved",
      headers: { cookie: sessionCookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json<SavedSearchesResponse>();
    expect(body.searches).toEqual([
      {
        id: SAVED_ID,
        name: "Unread work",
        query: "is:unread from:work.example",
        scope: { accountIds: [ACCOUNT_ID] },
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ]);
  });

  it("creates a saved search from the deployed origin with the captured generation", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const foreignOrigin = await app.inject({
      method: "POST",
      url: "/searches/saved",
      headers: { origin: "https://evil.example", cookie: sessionCookie, "content-type": "application/json" },
      payload: { name: "Receipts", query: "type:receipt" },
    });
    expect(foreignOrigin.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/searches/saved",
      headers: { ...originHeaders, "content-type": "application/json", "x-recovery-generation": GENERATION },
      payload: { name: "Receipts", query: "type:receipt", scope: { localOnly: true } },
    });
    expect(created.statusCode).toBe(201);
    expect(service.calls.generations).toEqual([GENERATION]);
    expect(service.calls.createdNames).toEqual(["Receipts"]);
    expect(created.json<{ saved: { name: string; scope: { localOnly?: boolean } } }>().saved.scope).toEqual({
      localOnly: true,
    });
  });

  it("reports duplicate names, unknown identifiers, and blocked recovery", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const conflict = await app.inject({
      method: "POST",
      url: "/searches/saved",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { name: "Unread work", query: "is:unread" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<SearchErrorBody>().error.code).toBe("name_conflict");

    const missing = await app.inject({
      method: "DELETE",
      url: "/searches/saved/6d4e7f2a-9b3c-4e58-a067-3f5d2c1b4a99",
      headers: originHeaders,
    });
    expect(missing.statusCode).toBe(404);

    const blocked = fakeService({
      async createSavedSearch() {
        throw new RecoveryBlockedError("recovery_required", GENERATION);
      },
    });
    const blockedApp = await makeApp(blocked);
    const rejected = await blockedApp.inject({
      method: "POST",
      url: "/searches/saved",
      headers: { ...originHeaders, "content-type": "application/json" },
      payload: { name: "Anything", query: "x" },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ error: { code: string; currentGeneration?: string } }>().error).toEqual({
      code: "recovery_required",
      message: expect.any(String),
      currentGeneration: GENERATION,
    });
  });

  it("deletes a saved search from the deployed origin", async () => {
    const service = fakeService();
    const app = await makeApp(service);

    const noOrigin = await app.inject({
      method: "DELETE",
      url: `/searches/saved/${SAVED_ID}`,
      headers: { cookie: sessionCookie },
    });
    expect(noOrigin.statusCode).toBe(403);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/searches/saved/${SAVED_ID}`,
      headers: { ...originHeaders, "x-recovery-generation": GENERATION },
    });
    expect(deleted.statusCode).toBe(204);
    expect(service.calls.deletedIds).toEqual([SAVED_ID]);
  });
});
