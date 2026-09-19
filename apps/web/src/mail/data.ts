import type {
  AccountFoldersResponse,
  AccountSummary,
  AccountsResponse,
  AuthStatusResponse,
  CleanViewResponse,
  FolderSummary,
  MessageDetailView,
  MessageDetailResponse,
  SearchResultsResponse,
  SearchResultItem,
} from "@mail-hub/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiGetBlob, toApiError, type ApiError } from "@/lib/api";

import { offlineStore } from "@/offline/store.ts";
import { useResource, type Resource } from "./use-resource";
import { folderForRole, scopeKey, type MailScope } from "./view";

/*
 * Reading data hooks over the existing routes: the session probe and folder
 * index for navigation, and the bounded message list for one scope (SPEC F3
 * and F5). Rows come from `GET /search`, so a free-text query narrows every
 * view.
 */

/** Rows fetched per page. */
export const PAGE_SIZE = 50;

/** Mirrors the API's per-request row limit. */
const REQUEST_LIMIT_CAP = 100;

/** Mirrors the API's maximum page offset. */
const REQUEST_OFFSET_CAP = 10_000;

/** Offline-store keys for the cold-boot copies (SPEC F9). */
const SESSION_META_KEY = "cachedSession";
const FOLDER_INDEX_META_KEY = "cachedFolderIndex";

/** Authentication availability, read before any session exists. */
export function useAuthStatus() {
  return useResource((signal) => apiGet<AuthStatusResponse>("/auth/status", signal), []);
}

export type SessionState =
  | { phase: "loading" }
  | { phase: "signed-in"; accounts: AccountSummary[]; recoveryGeneration: string | null }
  | { phase: "signed-out" }
  | { phase: "error"; message: string };

/**
 * The session probe. The account list loads only with a live session, so one
 * request answers both "is there a session" and "which accounts exist". Its
 * response also carries the recovery generation the server issues for new
 * client work (SPEC section 10).
 */
export function useSession(): { state: SessionState; refresh: () => void } {
  const resource = useResource((signal) => apiGet<AccountsResponse>("/accounts", signal), []);
  // A refresh keeps the last signed-in answer visible, so a reload after a
  // settings mutation never flashes the shell away (SPEC F12).
  const lastAnswer = useRef<AccountsResponse | null>(null);
  if (resource.phase === "ready" && resource.data !== null) {
    lastAnswer.current = resource.data;
  }
  // A cold start with no network serves the copy the last online visit
  // left, so the shell still mounts and the list's own fallback can read
  // mail (SPEC F9). `undefined` marks the copy as not read yet.
  const offline = resource.phase === "error" && resource.error?.network === true;
  const [cachedAnswer, setCachedAnswer] = useState<AccountsResponse | null | undefined>(undefined);

  useEffect(() => {
    if (resource.phase === "ready" && resource.data !== null) {
      cacheSessionAnswer(resource.data);
    }
  }, [resource.phase, resource.data]);

  useEffect(() => {
    if (!offline) {
      return;
    }
    let live = true;
    void (async () => {
      const store = offlineStore();
      const cached =
        store === null ? null : await store.readMeta<AccountsResponse>(SESSION_META_KEY);
      if (live) {
        setCachedAnswer(cached);
      }
    })();
    return () => {
      live = false;
    };
  }, [offline]);

  const fromAnswer = (answer: AccountsResponse): SessionState => ({
    phase: "signed-in",
    accounts: answer.accounts,
    recoveryGeneration: answer.recoveryGeneration,
  });
  switch (resource.phase) {
    case "ready":
      return {
        state:
          resource.data !== null
            ? fromAnswer(resource.data)
            : { phase: "signed-in", accounts: [], recoveryGeneration: null },
        refresh: resource.reload,
      };
    case "error":
      if (resource.error?.unauthorized === true) {
        return { state: { phase: "signed-out" }, refresh: resource.reload };
      }
      // While the offline copy is still loading, the splash stays up in
      // place of a failure the copy is about to replace.
      if (offline && cachedAnswer === undefined) {
        return { state: { phase: "loading" }, refresh: resource.reload };
      }
      if (offline && cachedAnswer != null) {
        return { state: fromAnswer(cachedAnswer), refresh: resource.reload };
      }
      return {
        state: {
          phase: "error",
          message: resource.error?.message ?? "The mail service cannot be reached.",
        },
        refresh: resource.reload,
      };
    default:
      return lastAnswer.current !== null
        ? { state: fromAnswer(lastAnswer.current), refresh: resource.reload }
        : { state: { phase: "loading" }, refresh: resource.reload };
  }
}

/** Caches the session answer for the next cold offline start (SPEC F9). */
function cacheSessionAnswer(answer: AccountsResponse): void {
  const store = offlineStore();
  if (store === null) {
    return;
  }
  void store.writeMeta(SESSION_META_KEY, answer).catch(() => {});
}

/**
 * The full detail of one message, sanitized body included (SPEC F3). A null
 * id reads as null data, so an empty selection stays an empty pane. Downloaded
 * details cache in Dexie, so an offline reader still opens what it fetched
 * before (SPEC F9).
 */
export function useMessageDetail(
  messageId: string | null,
): Resource<MessageDetailResponse | null> & { offlineFromCache: boolean } {
  const resource = useResource<MessageDetailResponse | null>(
    (signal) =>
      messageId === null
        ? Promise.resolve(null)
        : apiGet<MessageDetailResponse>(`/messages/${messageId}`, signal),
    [messageId],
  );
  const [fallback, setFallback] = useState<MessageDetailView | null>(null);
  const offline =
    resource.phase === "error" && resource.error?.network === true && messageId !== null;

  useEffect(() => {
    if (resource.phase === "ready" && resource.data?.message !== undefined) {
      cacheDetail(resource.data.message);
    }
  }, [resource.phase, resource.data]);

  useEffect(() => {
    setFallback(null);
    if (!offline) {
      return;
    }
    const id = messageId;
    let live = true;
    void (async () => {
      const store = offlineStore();
      const detail = store === null || id === null ? null : await store.cachedDetail(id);
      if (live) {
        setFallback(detail);
      }
    })();
    return () => {
      live = false;
    };
  }, [offline, messageId]);

  if (offline && fallback !== null) {
    return {
      phase: "ready",
      data: { message: fallback },
      error: null,
      reload: resource.reload,
      offlineFromCache: true,
    };
  }
  return { ...resource, offlineFromCache: false };
}

/** Cache one downloaded detail; quota problems just skip the copy. */
function cacheDetail(message: MessageDetailView): void {
  const store = offlineStore();
  if (store === null) {
    return;
  }
  void store.cacheMessageDetail(message).catch(() => {});
}

/** Verified inline images of one message, keyed by Content-ID. */
export interface InlineImages {
  /** `null` while the verified set is still loading. */
  map: Map<string, string> | null;
}

/**
 * Fetches the reader's inline images (SPEC F3). Only attachments the server
 * marked resolvable are fetched, and each becomes a data URL, because the
 * sandboxed frame cannot read cookies or blob URLs. A failed image stays a
 * labeled placeholder; it never blocks the others.
 */
export function useInlineImages(message: MessageDetailView | null): InlineImages {
  const [map, setMap] = useState<Map<string, string> | null>(null);

  useEffect(() => {
    if (message === null) {
      setMap(null);
      return;
    }
    const resolvable = message.attachments.filter(
      (attachment) => attachment.inlineResolvable && attachment.contentId !== null,
    );
    if (resolvable.length === 0) {
      setMap(new Map<string, string>());
      return;
    }

    const controller = new AbortController();
    let live = true;
    setMap(null);
    void (async () => {
      const loaded = new Map<string, string>();
      await Promise.all(
        resolvable.map(async (attachment) => {
          try {
            const blob = await apiGetBlob(
              `/messages/${message.id}/attachments/${attachment.id}`,
              controller.signal,
            );
            loaded.set(attachment.contentId!, await blobToDataUrl(blob));
          } catch {
            // One failed image stays a placeholder; the rest still render.
          }
        }),
      );
      if (live) {
        setMap(loaded);
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [message?.id, message?.attachments]);

  return { map };
}

/** Reads one blob as a data URL, the only URL the sandboxed frame can load. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () => reject(new Error("The image could not be decoded.")));
    reader.readAsDataURL(blob);
  });
}

/** The clean view of the open message, fetched only while it is on (SPEC F3). */
export function useCleanView(messageId: string | null, enabled: boolean): Resource<CleanViewResponse | null> {
  return useResource<CleanViewResponse | null>(
    (signal) =>
      messageId === null || !enabled
        ? Promise.resolve(null)
        : apiGet<CleanViewResponse>(`/messages/${messageId}/clean-view`, signal),
    [messageId, enabled],
  );
}

/** Folder lists for every account, keyed by account id. */
export function useFolderIndex(accounts: AccountSummary[]) {
  const key = accounts.map((account) => account.id).join("|");
  const resource = useResource<Map<string, FolderSummary[]>>(async (signal) => {
    if (accounts.length === 0) {
      return new Map<string, FolderSummary[]>();
    }
    const responses = await Promise.all(
      accounts.map((account) =>
        apiGet<AccountFoldersResponse>(`/accounts/${account.id}/folders`, signal),
      ),
    );
    const index = new Map<string, FolderSummary[]>();
    accounts.forEach((account, position) => {
      const response = responses[position];
      if (response !== undefined) {
        index.set(account.id, response.folders);
      }
    });
    return index;
  }, [key]);

  // A cold offline start serves the cached copy the same way the session
  // does: the unified inbox needs its folder roles before the list's own
  // fallback can run (SPEC F9).
  const offline = resource.phase === "error" && resource.error?.network === true;
  const [cachedIndex, setCachedIndex] = useState<Map<string, FolderSummary[]> | null | undefined>(
    undefined,
  );

  useEffect(() => {
    if (resource.phase === "ready" && resource.data !== null) {
      cacheFolderIndex(resource.data);
    }
  }, [resource.phase, resource.data]);

  useEffect(() => {
    if (!offline) {
      return;
    }
    let live = true;
    void (async () => {
      const store = offlineStore();
      const cached =
        store === null
          ? null
          : await store.readMeta<[string, FolderSummary[]][]>(FOLDER_INDEX_META_KEY);
      if (live) {
        setCachedIndex(cached === null ? null : new Map(cached));
      }
    })();
    return () => {
      live = false;
    };
  }, [offline]);

  if (offline) {
    if (cachedIndex === undefined) {
      return { phase: "loading", data: null, error: null, reload: resource.reload };
    }
    if (cachedIndex !== null) {
      return { phase: "ready", data: cachedIndex, error: null, reload: resource.reload };
    }
  }
  return resource;
}

/** Caches the folder index as entries, the offline store's plain shape. */
function cacheFolderIndex(index: Map<string, FolderSummary[]>): void {
  const store = offlineStore();
  if (store === null || index.size === 0) {
    return;
  }
  void store.writeMeta(FOLDER_INDEX_META_KEY, [...index.entries()]).catch(() => {});
}

interface SearchParams {
  q: string;
  accountIds: string[];
  folderId: string | null;
  limit: number;
  offset: number;
}

async function searchMessages(params: SearchParams, signal: AbortSignal) {
  const query = new URLSearchParams();
  if (params.q.length > 0) {
    query.set("q", params.q);
  }
  for (const accountId of params.accountIds) {
    query.append("account", accountId);
  }
  if (params.folderId !== null) {
    query.set("folder", params.folderId);
  }
  query.set("limit", String(params.limit));
  query.set("offset", String(params.offset));
  return apiGet<SearchResultsResponse>(`/search?${query.toString()}`, signal);
}

/**
 * The server's row order, mirrored for merges: search rank first when a
 * query ranks rows, then the effective send date, then the message id.
 */
function compareItems(a: SearchResultItem, b: SearchResultItem): number {
  if (a.rank !== null && b.rank !== null && a.rank !== b.rank) {
    return b.rank - a.rank;
  }
  if (a.rank !== null && b.rank === null) {
    return -1;
  }
  if (a.rank === null && b.rank !== null) {
    return 1;
  }
  const at = a.sentAt === null ? 0 : Date.parse(a.sentAt);
  const bt = b.sentAt === null ? 0 : Date.parse(b.sentAt);
  if (at !== bt) {
    return bt - at;
  }
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

function dedupe(rows: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.messageId)) {
      return false;
    }
    seen.add(row.messageId);
    return true;
  });
}

export interface MessageListState {
  phase: "loading" | "ready" | "error";
  rows: SearchResultItem[];
  /** Total matches past the returned rows, summed over merged sources. */
  total: number;
  /** Body-indexing progress across the scope (SPEC F5). */
  indexing: { messages: number; bodies: number } | null;
  error: ApiError | null;
  loadingMore: boolean;
  canLoadMore: boolean;
  /** True when the rows come from the offline cache, not the server. */
  offlineFromCache: boolean;
}

export interface MessageList {
  state: MessageListState;
  loadMore: () => void;
  reload: () => void;
}

/**
 * The message list of one scope. Requests stay bounded: single-source scopes
 * page with a growing offset, and the unified inbox refetches a growing
 * newest-first window per account, because its rows merge across accounts.
 */
export function useMessageList(
  scope: MailScope,
  query: string,
  folderIndex: Map<string, FolderSummary[]> | null,
): MessageList {
  const key = scopeKey(scope);
  const trimmed = query.trim();
  // The unified inbox reads each account's mapped inbox folder; refetch when
  // the resolved folder set changes.
  const inboxKey =
    scope.kind === "unified-inbox" && folderIndex !== null
      ? [...folderIndex.entries()]
          .map(
            ([accountId, folders]) =>
              `${accountId}:${folderForRole(folders, "inbox")?.id ?? "-"}`,
          )
          .join("|")
      : "";

  const [pages, setPages] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [entry, setEntry] = useState<{
    phase: MessageListState["phase"];
    rows: SearchResultItem[];
    total: number;
    indexing: MessageListState["indexing"];
    error: ApiError | null;
    loadingMore: boolean;
    offlineFromCache: boolean;
  }>({ phase: "loading", rows: [], total: 0, indexing: null, error: null, loadingMore: false, offlineFromCache: false });
  // The failure path reads the entry as it stands now, not the one the
  // effect closure captured: a page-one reload clears the rows before the
  // request runs, so "is anything on screen" must answer for the cleared
  // state. Without this, the offline cache only appears on a second retry.
  const entryRef = useRef(entry);
  entryRef.current = entry;

  // A new scope or query restarts the list from its first page. The reset
  // happens during render so the fetch effect never sees a stale page count.
  const identity = `${key}\n${trimmed}\n${inboxKey}`;
  const previousIdentity = useRef(identity);
  if (previousIdentity.current !== identity) {
    previousIdentity.current = identity;
    setPages(1);
  }

  useEffect(
    () => {
      if (scope.kind === "unified-inbox" && folderIndex === null) {
        return;
      }
      const controller = new AbortController();
      let live = true;
      const loadingMore = pages > 1;
      if (loadingMore) {
        setEntry((current) => ({ ...current, loadingMore: true }));
      } else {
        setEntry({
          phase: "loading",
          rows: [],
          total: 0,
          indexing: null,
          error: null,
          loadingMore: false,
          offlineFromCache: false,
        });
      }

      const run = async () => {
        try {
          if (scope.kind === "unified-inbox") {
            const windowRows = Math.min(pages * PAGE_SIZE, REQUEST_LIMIT_CAP);
            const responses = await Promise.all(
              [...(folderIndex ?? new Map<string, FolderSummary[]>()).entries()].flatMap(
                ([accountId, folders]) => {
                  const inbox = folderForRole(folders, "inbox");
                  return inbox === null
                    ? []
                    : [
                        searchMessages(
                          {
                            q: trimmed,
                            accountIds: [accountId],
                            folderId: inbox.id,
                            limit: windowRows,
                            offset: 0,
                          },
                          controller.signal,
                        ),
                      ];
                },
              ),
            );
            const merged = dedupe(
              responses.flatMap((response) => response.results),
            ).sort(compareItems);
            if (live) {
              setEntry({
                phase: "ready",
                rows: merged.slice(0, pages * PAGE_SIZE),
                total: responses.reduce((sum, response) => sum + response.total, 0),
                indexing: {
                  messages: responses.reduce((sum, response) => sum + response.indexing.messages, 0),
                  bodies: responses.reduce((sum, response) => sum + response.indexing.bodies, 0),
                },
                error: null,
                loadingMore: false,
                offlineFromCache: false,
              });
            }
            cacheRowsLive(merged);
            return;
          }

          const accountIds = scope.kind === "account" ? [scope.accountId] : [];
          const folderId = scope.kind === "account" ? scope.folderId : null;
          const response = await searchMessages(
            {
              q: trimmed,
              accountIds,
              folderId,
              limit: PAGE_SIZE,
              offset: (pages - 1) * PAGE_SIZE,
            },
            controller.signal,
          );
          if (live) {
            setEntry((current) => ({
              phase: "ready",
              rows:
                pages === 1 ? response.results : dedupe([...current.rows, ...response.results]),
              total: response.total,
              indexing: response.indexing,
              error: null,
              loadingMore: false,
              offlineFromCache: false,
            }));
          }
          cacheRowsLive(response.results);
        } catch (error: unknown) {
          if (!live || (error instanceof DOMException && error.name === "AbortError")) {
            return;
          }
          const failure = toApiError(error);
          if (live) {
            const hadRows = entryRef.current.rows.length > 0;
            setEntry((current) => ({
              ...current,
              // Keep the rows already on screen; the failure stays inspectable
              // next to them (SPEC F12).
              phase: current.rows.length > 0 ? "ready" : "error",
              error: failure,
              loadingMore: false,
            }));
            // With nothing on screen and no service, downloaded mail still
            // reads (SPEC F9).
            if (failure.network && !hadRows && pages === 1) {
              void readCachedRows().then((cached) => {
                if (live && cached.length > 0) {
                  setEntry({
                    phase: "ready",
                    rows: cached,
                    total: cached.length,
                    indexing: null,
                    error: failure,
                    loadingMore: false,
                    offlineFromCache: true,
                  });
                }
              });
            }
          }
        }
      };

      void run();
      return () => {
        live = false;
        controller.abort();
      };
    },
    // The inputs are the scope identity, the page, and the reload nonce.
    [identity, pages, nonce],
  );

  const canLoadMore =
    entry.phase === "ready" &&
    entry.rows.length < entry.total &&
    (scope.kind === "unified-inbox"
      ? pages * PAGE_SIZE < REQUEST_LIMIT_CAP
      : pages * PAGE_SIZE < REQUEST_OFFSET_CAP);

  const loadMore = useCallback(() => {
    setPages((current) => current + 1);
  }, []);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return {
    state: { ...entry, canLoadMore },
    loadMore,
    reload,
  };
}

/**
 * Cache downloaded rows for offline reading (SPEC F9). Quota problems skip
 * the copy; they never fail the view that fetched the rows.
 */
function cacheRowsLive(rows: SearchResultItem[]): void {
  const store = offlineStore();
  if (store === null || rows.length === 0) {
    return;
  }
  void (async () => {
    try {
      for (const row of rows) {
        await store.cacheMessageRow(row);
      }
      await store.pruneRecentMail();
    } catch {
      // The cache is best effort; reading stays possible without it.
    }
  })();
}

/** The downloaded rows, when this window keeps an offline store. */
async function readCachedRows(): Promise<SearchResultItem[]> {
  const store = offlineStore();
  if (store === null) {
    return [];
  }
  try {
    return await store.cachedRows();
  } catch {
    return [];
  }
}
