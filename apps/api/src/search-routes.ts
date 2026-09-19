import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  CreateSavedSearchRequestBody,
  SavedSearchView,
  SavedSearchesResponse,
  SearchResultsResponse,
  SearchResultItem,
} from "@mail-hub/contracts";
import {
  MAX_ACCOUNT_FILTERS,
  MAX_DOMAIN_FILTERS,
  MAX_QUERY_CHARS,
  MAX_SAVED_SEARCH_NAME_CHARS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_OFFSET,
  SearchError,
  type MutationContext,
  type SavedSearchRecord,
  type SearchHit,
  type SearchService,
} from "@mail-hub/search";
import { RecoveryBlockedError } from "@mail-hub/recovery";
import { AuthError } from "@mail-hub/auth";
import { readRequestGeneration } from "./recovery.ts";
import { SESSION_COOKIE } from "./auth-routes.ts";
import { sendUnclassifiedError } from "./http-errors.ts";

/**
 * Search and saved-search routes (SPEC F5). Reads need a session; saved
 * searches are durable state, so their mutations also need the deployed
 * origin and the recovery generation the client captured, which the search
 * service checks before it writes (SPEC section 7, step 1).
 */

/** The service surface the routes need. `SearchService` satisfies it. */
export type SearchServiceForRoutes = Pick<
  SearchService,
  "search" | "listSavedSearches" | "createSavedSearch" | "deleteSavedSearch"
>;

export interface SearchRoutesOptions {
  service: SearchServiceForRoutes;
  /** Exact origin clients must present, from `BASE_URL`. */
  origin: string;
  /** Resolves for a live session and throws when the token fails. */
  verifySession(token: string): Promise<unknown>;
}

const UUID_PATTERN = "^[0-9a-fA-F-]{36}$";

/** A filter that may arrive once or repeated; both forms become one list. */
function readList(value: string | string[] | undefined): string[] | null {
  if (value === undefined) {
    return null;
  }
  return typeof value === "string" ? [value] : value;
}

/**
 * One filter chip list: singular and repeated forms share one schema. The
 * branches are spelled out because a plain union type lets a lone string
 * skip its pattern check.
 */
function listFilter(itemsMax: number) {
  return {
    anyOf: [
      { type: "string", pattern: UUID_PATTERN },
      { type: "array", items: { type: "string", pattern: UUID_PATTERN }, maxItems: itemsMax },
    ],
  } as const;
}

/** Register all search routes under a scoped error handler. */
export async function registerSearchRoutes(
  app: FastifyInstance,
  options: SearchRoutesOptions,
): Promise<void> {
  const { service, origin } = options;

  await app.register(async function searchRoutes(scope) {
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof SearchError) {
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
            ...(error.currentGeneration === undefined
              ? {}
              : { currentGeneration: error.currentGeneration }),
          },
        });
      }
      return sendUnclassifiedError(error, request, reply);
    });

    scope.get<{ Querystring: SearchQuery; Reply: SearchResultsResponse }>(
      "/search",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              q: { type: "string", maxLength: MAX_QUERY_CHARS },
              account: listFilter(MAX_ACCOUNT_FILTERS),
              domain: {
                anyOf: [
                  { type: "string", minLength: 1, maxLength: 253 },
                  {
                    type: "array",
                    items: { type: "string", minLength: 1, maxLength: 253 },
                    maxItems: MAX_DOMAIN_FILTERS,
                  },
                ],
              },
              folder: { type: "string", pattern: UUID_PATTERN },
              local: { type: "boolean" },
              limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT },
              offset: { type: "integer", minimum: 0, maximum: MAX_SEARCH_OFFSET },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireSession],
      },
      async (request) => {
        const query = request.query;
        const result = await service.search({
          query: query.q ?? "",
          accountIds: readList(query.account),
          domains: readList(query.domain),
          folderId: query.folder ?? null,
          localOnly: query.local === true,
          limit: query.limit,
          offset: query.offset,
        });
        return {
          results: result.results.map(toResultItem),
          total: result.total,
          indexing: result.indexing,
        };
      },
    );

    scope.get<{ Reply: SavedSearchesResponse }>(
      "/searches/saved",
      { preHandler: [requireSession] },
      async () => ({ searches: (await service.listSavedSearches()).map(toSavedSearchView) }),
    );

    scope.post<{ Body: CreateSavedSearchRequestBody; Reply: { saved: SavedSearchView } }>(
      "/searches/saved",
      {
        schema: {
          body: {
            type: "object",
            required: ["name", "query"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: MAX_SAVED_SEARCH_NAME_CHARS },
              query: { type: "string", minLength: 1, maxLength: MAX_QUERY_CHARS },
              scope: {
                type: "object",
                properties: {
                  accountIds: {
                    type: "array",
                    items: { type: "string", pattern: UUID_PATTERN },
                    maxItems: MAX_ACCOUNT_FILTERS,
                  },
                  folderId: { type: ["string", "null"], pattern: UUID_PATTERN },
                  domains: {
                    type: "array",
                    items: { type: "string", minLength: 1, maxLength: 253 },
                    maxItems: MAX_DOMAIN_FILTERS,
                  },
                  localOnly: { type: "boolean" },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        const saved = await service.createSavedSearch(readContext(request), {
          name: request.body.name,
          query: request.body.query,
          scope: request.body.scope ?? null,
        });
        return reply.code(201).send({ saved: toSavedSearchView(saved) });
      },
    );

    scope.delete<{ Params: { id: string } }>(
      "/searches/saved/:id",
      {
        schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: UUID_PATTERN } } } },
        preHandler: [requireOrigin, requireSession],
      },
      async (request, reply) => {
        await service.deleteSavedSearch(readContext(request), request.params.id);
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
    await options.verifySession(token);
  }
}

/** The querystring of `GET /search`. */
interface SearchQuery {
  q?: string;
  account?: string | string[];
  domain?: string | string[];
  folder?: string;
  local?: boolean;
  limit?: number;
  offset?: number;
}

function readContext(request: FastifyRequest): MutationContext {
  return { requestGeneration: readRequestGeneration(request) };
}

/** One result row in its wire form: the date becomes ISO text. */
function toResultItem(hit: SearchHit): SearchResultItem {
  return {
    messageId: hit.messageId,
    accountId: hit.accountId,
    accountLabel: hit.accountLabel,
    accountColor: hit.accountColor,
    threadId: hit.threadId,
    subject: hit.subject,
    snippet: hit.snippet,
    sender: hit.sender === null ? null : { address: hit.sender.address, name: hit.sender.name },
    sentAt: hit.sentAt === null ? null : hit.sentAt.toISOString(),
    fetchedBody: hit.fetchedBody,
    hasAttachments: hit.hasAttachments,
    unread: hit.unread,
    flagged: hit.flagged,
    activeOccurrences: hit.activeOccurrences,
    occurrences: hit.occurrences.map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId,
      folderId: occurrence.folderId,
      revision: occurrence.revision,
      modseq: occurrence.modseq,
    })),
    noServerCopy: hit.noServerCopy,
    sentCopyStatus: hit.sentCopyStatus,
    rank: hit.rank,
    highlight: hit.highlight,
    highlightSource: hit.highlightSource,
  };
}

/** One saved search in its wire form. */
function toSavedSearchView(record: SavedSearchRecord): SavedSearchView {
  return {
    id: record.id,
    name: record.name,
    query: record.query,
    scope: { ...record.scope },
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
