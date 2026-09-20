import type {
  HomeClassificationCoverage,
  HomeItemView,
  HomeResponse,
  HomeSectionIdWire,
  HomeSectionResponse,
  HomeSectionView,
} from "@mail-hub/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, toApiError, type ApiError } from "@/lib/api";
import { offlineStore } from "@/offline/store.ts";
import { homeDeviceId } from "./device.ts";

/*
 * The Home read model (SPEC F13). One full load is one visit: it reports the
 * boundary it used and advances it on the server only after every query
 * succeeded. Refreshes run through the per-section route instead, so they
 * never advance the boundary: the `since_visit` window stays frozen at the
 * value the session opened with. Refreshes include all eligible arrivals
 * after that boundary. A cold offline start serves the copy the last
 * online visit left, stamped with the recovery generation it belongs to; a
 * generation change invalidates that copy.
 */

/** Entries each section page asks for; the plan's "about eight rows". */
export const HOME_PAGE_SIZE = 8;

/** The per-request cap the service enforces, mirrored for refreshes. */
const REQUEST_LIMIT_CAP = 50;

/** Offline-store key of the cached full read (SPEC F13). */
const CACHE_KEY = "cachedHome";

/** The only cache layout this client reads. */
const CACHE_VERSION = 2;

interface CachedHome {
  version: number;
  /** The recovery generation the answer belongs to. */
  generation: string | null;
  response: HomeResponse;
  /** When this device stored the answer, in milliseconds since the epoch. */
  cachedAt: number;
}

/** One Home section as the screen holds it. */
export interface HomeSectionState {
  id: HomeSectionIdWire;
  /** Every entry the section holds, past the loaded page. */
  total: number;
  items: HomeItemView[];
  /** Keyset cursor the next page needs; `null` after the last entry. */
  nextCursor: string | null;
  loadingMore: boolean;
}

export interface HomeDataState {
  phase: "loading" | "ready" | "error";
  sections: HomeSectionState[];
  classification: HomeClassificationCoverage | null;
  /** When the server assembled the answer shown. */
  generatedAt: string | null;
  /** The visit boundary the session opened with; `null` on a first visit. */
  visitBoundary: string | null;
  /** True when the rows come from the offline cache, not the server. */
  offlineFromCache: boolean;
  /** When the cached answer was stored; `null` while it is live. */
  cachedAt: number | null;
  error: ApiError | null;
  /** True while a refresh re-reads the sections of a loaded view. */
  refreshing: boolean;
}

export interface HomeData {
  state: HomeDataState;
  /** This device's visit identity, for the section reads. */
  deviceId: string;
  /** Loads the next page of one section through its cursor. */
  loadMore: (section: HomeSectionIdWire) => void;
  /**
   * Re-reads every loaded section without advancing the visit boundary: the
   * update control and successful mutations call this.
   */
  refresh: () => void;
  /** Runs the full read again, as one new visit attempt. */
  reload: () => void;
  /** Removes one entry locally, after a confirmed dismissal. */
  removeEntry: (section: HomeSectionIdWire, entryKey: string) => void;
}

/** The cached answer, when this device kept one for the given generation. */
async function readCachedHome(generation: string | null): Promise<CachedHome | null> {
  const store = offlineStore();
  if (store === null) {
    return null;
  }
  try {
    const cached = await store.readMeta<CachedHome>(CACHE_KEY);
    if (
      cached === null ||
      cached.version !== CACHE_VERSION ||
      cached.generation !== generation ||
      cached.response === null
    ) {
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

/** Stores one live answer for the next cold offline start. */
function cacheHome(generation: string | null, response: HomeResponse): void {
  const store = offlineStore();
  if (store === null) {
    return;
  }
  void store
    .writeMeta(CACHE_KEY, { version: CACHE_VERSION, generation, response, cachedAt: Date.now() })
    .catch(() => {});
}

function sectionStateOf(section: HomeSectionView): HomeSectionState {
  return {
    id: section.id,
    total: section.total,
    items: section.items,
    nextCursor: section.nextCursor,
    loadingMore: false,
  };
}

/**
 * The Home data of one visit. Mount this while Home is visible: mounting is
 * the visit, so the boundary advances exactly once per open.
 */
export function useHomeData(recoveryGeneration: string | null): HomeData {
  const deviceId = useMemo(homeDeviceId, []);
  const [nonce, setNonce] = useState(0);
  const [entry, setEntry] = useState<HomeDataState>({
    phase: "loading",
    sections: [],
    classification: null,
    generatedAt: null,
    visitBoundary: null,
    offlineFromCache: false,
    cachedAt: null,
    error: null,
    refreshing: false,
  });
  // The generation the cache must match; a ref, because a mid-session change
  // invalidates the copy without restarting the visit.
  const generationRef = useRef(recoveryGeneration);
  generationRef.current = recoveryGeneration;

  useEffect(
    () => {
      const controller = new AbortController();
      let live = true;
      setEntry((current) => ({
        ...current,
        phase: current.sections.length > 0 ? current.phase : "loading",
        refreshing: current.sections.length > 0,
      }));
      apiGet<HomeResponse>(`/home?deviceId=${encodeURIComponent(deviceId)}`, controller.signal).then(
        (response) => {
          if (!live) {
            return;
          }
          cacheHome(generationRef.current, response);
          setEntry({
            phase: "ready",
            sections: response.sections.map(sectionStateOf),
            classification: response.classification,
            generatedAt: response.generatedAt,
            visitBoundary: response.visitBoundary,
            offlineFromCache: false,
            cachedAt: null,
            error: null,
            refreshing: false,
          });
        },
        async (cause: unknown) => {
          if (!live || (cause instanceof DOMException && cause.name === "AbortError")) {
            return;
          }
          const failure = toApiError(cause);
          // Only a failed full read serves the cached copy, and only when it
          // belongs to the recovery generation this session runs with
          // (SPEC F13: a generation change invalidates cached Home data).
          if (failure.network) {
            const cached = await readCachedHome(generationRef.current);
            if (live && cached !== null) {
              setEntry({
                phase: "ready",
                sections: cached.response.sections.map(sectionStateOf),
                classification: cached.response.classification,
                generatedAt: cached.response.generatedAt,
                visitBoundary: cached.response.visitBoundary,
                offlineFromCache: true,
                cachedAt: cached.cachedAt,
                error: failure,
                refreshing: false,
              });
              return;
            }
          }
          if (live) {
            setEntry({
              phase: "error",
              sections: [],
              classification: null,
              generatedAt: null,
              visitBoundary: null,
              offlineFromCache: false,
              cachedAt: null,
              error: failure,
              refreshing: false,
            });
          }
        },
      );
      return () => {
        live = false;
        controller.abort();
      };
    },
    [deviceId, nonce],
  );

  /** Reads one section page, with this device's identity attached. */
  const readSectionPage = useCallback(
    (section: HomeSectionIdWire, cursor: string | null, limit: number, signal: AbortSignal, boundary: string | null) => {
      const query = new URLSearchParams({
        deviceId,
        limit: String(limit),
        visitBoundary: boundary ?? "none",
      });
      if (cursor !== null) {
        query.set("cursor", cursor);
      }
      return apiGet<HomeSectionResponse>(
        `/home/sections/${section}?${query.toString()}`,
        signal,
      ).then((response) => response.section);
    },
    [deviceId],
  );

  const loadMore = useCallback(
    (sectionId: HomeSectionIdWire) => {
      setEntry((current) => {
        const section = current.sections.find((candidate) => candidate.id === sectionId);
        if (
          current.phase !== "ready" ||
          section === undefined ||
          section.loadingMore ||
          section.nextCursor === null
        ) {
          return current;
        }
        // The fetch runs beside the state change; the loading flag guards a
        // second press while the first page is in flight.
        void (async () => {
          const controller = new AbortController();
          try {
            const page = await readSectionPage(sectionId, section.nextCursor, HOME_PAGE_SIZE, controller.signal, current.visitBoundary);
            setEntry((state) => ({
              ...state,
              error: null,
              sections: state.sections.map((candidate) =>
                candidate.id === sectionId
                  ? {
                      ...candidate,
                      total: page.total,
                      items: mergeItems(candidate.items, page.items),
                      nextCursor: page.nextCursor,
                      loadingMore: false,
                    }
                  : candidate,
              ),
            }));
          } catch (cause) {
            setEntry((state) => ({
              ...state,
              error: toApiError(cause),
              sections: state.sections.map((candidate) =>
                candidate.id === sectionId ? { ...candidate, loadingMore: false } : candidate,
              ),
            }));
          }
        })();
        return {
          ...current,
          sections: current.sections.map((candidate) =>
            candidate.id === sectionId ? { ...candidate, loadingMore: true } : candidate,
          ),
        };
      });
    },
    [readSectionPage],
  );

  const refresh = useCallback(() => {
    setEntry((current) => {
      if (current.phase !== "ready" || current.refreshing) {
        return current;
      }
      const sections = current.sections;
      void (async () => {
        const controller = new AbortController();
        try {
          const pages = await Promise.all(
            sections.map(async (section) => {
              let page = await readSectionPage(section.id, null,
                Math.min(Math.max(section.items.length, HOME_PAGE_SIZE), REQUEST_LIMIT_CAP),
                controller.signal, current.visitBoundary);
              while (page.nextCursor !== null && page.items.length < section.items.length) {
                const next = await readSectionPage(section.id, page.nextCursor, REQUEST_LIMIT_CAP,
                  controller.signal, current.visitBoundary);
                page = { ...next, items: mergeItems(page.items, next.items) };
              }
              return page;
            }),
          );
          setEntry((state) => ({
            ...state,
            refreshing: false,
            error: null,
            sections: state.sections.map((section, position) => {
              const page = pages[position] ?? null;
              return page === null
                ? section
                : {
                    ...section,
                    total: page.total,
                    items: page.items,
                    nextCursor: page.nextCursor,
                    loadingMore: false,
                  };
            }),
          }));
        } catch (cause) {
          setEntry((state) => ({ ...state, refreshing: false, error: toApiError(cause) }));
        }
      })();
      return { ...current, refreshing: true };
    });
  }, [readSectionPage]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  const removeEntry = useCallback((sectionId: HomeSectionIdWire, entryKey: string) => {
    setEntry((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              total: Math.max(section.total - 1, 0),
              items: section.items.filter((item) => item.entryKey !== entryKey),
            }
          : section,
      ),
    }));
  }, []);

  return { state: entry, deviceId, loadMore, refresh, reload, removeEntry };
}

/** Appends one page, keeping earlier rows ahead of the new ones. */
function mergeItems(current: HomeItemView[], page: HomeItemView[]): HomeItemView[] {
  const merged = new Map(current.map((item) => [item.entryKey, item]));
  for (const item of page) {
    const previous = merged.get(item.entryKey);
    if (previous === undefined) {
      merged.set(item.entryKey, item);
      continue;
    }
    merged.set(item.entryKey, {
      ...previous,
      messageIds: [...new Set([...previous.messageIds, ...item.messageIds])],
      work: [...new Map([...previous.work, ...item.work].map((work) => [work.id, work])).values()],
      reasons: [...new Map([...previous.reasons, ...item.reasons].map((reason) =>
        [`${reason.code}:${reason.origin}`, reason])).values()],
    });
  }
  return [...merged.values()];
}

/** True while no network connection exists, following the browser's signal. */
export function useOffline(): boolean {
  const [offline, setOffline] = useState(() =>
    typeof navigator === "undefined" ? false : navigator.onLine === false,
  );
  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return offline;
}
