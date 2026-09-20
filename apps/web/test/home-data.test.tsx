// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HomeItemView, HomeResponse, HomeSectionView } from "@mail-hub/contracts";

/*
 * The Home read model (SPEC F13): one full load is one visit, refreshes run
 * per section so the visit boundary never moves mid-session, the frozen
 * `since_visit` window only grows by new arrivals, and the offline cache is
 * bound to the recovery generation it belongs to.
 */

const MESSAGE_A = "11111111-1111-4111-8111-111111111111";
const MESSAGE_B = "22222222-2222-4222-8222-222222222222";

function itemOf(entryKey: string, messageId: string): HomeItemView {
  return {
    entryKey,
    message: {
      messageId,
      accountId: "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d",
      accountLabel: "Main",
      accountColor: "#2563eb",
      threadId: null,
      subject: `Subject ${entryKey}`,
      snippet: `Snippet of ${entryKey}`,
      sender: { address: "who@example.com", name: null },
      sentAt: "2026-09-20T10:00:00.000Z",
      unread: true,
      flagged: false,
      hasAttachments: false,
    },
    messageIds: [messageId],
    reasons: [{ code: "may_need_reply", origin: "suggestion" }],
    work: [],
    occurrences: [],
    noServerCopy: false,
  };
}

function sectionOf(id: string, items: HomeItemView[], total = items.length): HomeSectionView {
  return { id: id as HomeSectionView["id"], total, items, nextCursor: null };
}

const EMPTY_SECTIONS: HomeSectionView[] = ["due_now", "needs_attention", "reply_later", "saved"].map(
  (id) => sectionOf(id, []),
);

const harness = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    homeAnswer: null as HomeResponse | null,
    sectionAnswers: new Map<string, HomeSectionView>(),
    homeReads: 0,
    sectionReads: [] as string[],
    boundaries: [] as (string | null)[],
    failHome: false,
  };
});

/** One network-style failure, shaped the way the client's `toApiError` keeps. */
class TestApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get network(): boolean {
    return this.status === 0;
  }
}

vi.mock("../src/lib/api.ts", () => ({
  apiGet: async (path: string) => {
    if (path.startsWith("/home?")) {
      harness.homeReads += 1;
      if (harness.failHome || harness.homeAnswer === null) {
        throw new TestApiError(0, "network_error", "The mail service cannot be reached.");
      }
      return harness.homeAnswer;
    }
    if (path.startsWith("/home/sections/")) {
      const id = path.slice("/home/sections/".length).split("?")[0]!;
      harness.boundaries.push(new URLSearchParams(path.split("?")[1]).get("visitBoundary"));
      harness.sectionReads.push(`${id}?${new URLSearchParams(path.split("?")[1]).get("cursor")}`);
      const section = harness.sectionAnswers.get(id);
      if (section === undefined) {
        throw new TestApiError(500, "unexpected", "No section answer was prepared.");
      }
      return { section };
    }
    if (path.startsWith("/home/priorities")) {
      return { priorities: [] };
    }
    throw new TestApiError(500, "unexpected", `Unexpected read: ${path}`);
  },
  toApiError: (cause: unknown) => cause,
}));

vi.mock("../src/offline/store.ts", () => ({
  offlineStore: () => ({
    readMeta: async <T,>(key: string): Promise<T | null> => (harness.store.get(key) as T) ?? null,
    writeMeta: async (key: string, value: unknown) => {
      harness.store.set(key, value);
    },
  }),
  resetOfflineStore: () => {},
}));

import { useHomeData, type HomeData } from "../src/home/data.ts";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let data: { current: HomeData | null };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root !== null) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  harness.homeAnswer = null;
  harness.sectionAnswers.clear();
  harness.homeReads = 0;
  harness.sectionReads.length = 0;
  harness.boundaries.length = 0;
  harness.failHome = false;
  harness.store.clear();
});

/** Mounts the hook with one probe that records the value it renders. */
async function mountHome(generation: string | null = "gen-1"): Promise<void> {
  if (root !== null) {
    const previous = root;
    await act(async () => {
      previous.unmount();
    });
  }
  data = { current: null };
  for (const section of harness.homeAnswer?.sections ?? []) {
    if (!harness.sectionAnswers.has(section.id)) harness.sectionAnswers.set(section.id, section);
  }
  function Probe() {
    data.current = useHomeData(generation);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
}

/** Lets every pending promise of the last act run to its state change. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function answerOf(sections: HomeSectionView[]): HomeResponse {
  return {
    generatedAt: "2026-09-20T12:00:00.000Z",
    sections,
    classification: {
      state: "active",
      description: "Classification is running.",
      considered: 40,
      answered: 12,
      newestAnswerAt: "2026-09-20T11:00:00.000Z",
    },
    visitBoundary: "2026-09-19T12:00:00.000Z",
  };
}

describe("the Home data hook", () => {
  it("merges work and messages when a conversation also appears on a later page", async () => {
    const a = itemOf("thread", MESSAGE_A);
    a.work = [{ id: "work-a", kind: "reminder", status: "open", dueAt: "2026-09-20T10:00:00Z", timeZone: "UTC", revision: 1, anchorUnavailable: false }];
    const first = sectionOf("due_now", [a], 1);
    first.nextCursor = "next-page";
    harness.homeAnswer = answerOf([first]);
    await mountHome();
    const b = itemOf("thread", MESSAGE_B);
    b.work = [{ ...a.work[0]!, id: "work-b" }];
    b.reasons = [{ code: "reply_planned", origin: "choice" }];
    harness.sectionAnswers.set("due_now", sectionOf("due_now", [b], 1));
    act(() => { data.current!.loadMore("due_now"); });
    await settle(); await settle();
    const item = data.current!.state.sections[0]!.items[0]!;
    expect(item.messageIds).toEqual([MESSAGE_A, MESSAGE_B]);
    expect(item.work.map(work => work.id)).toEqual(["work-a", "work-b"]);
    expect(item.reasons).toHaveLength(2);
  });

  it("refreshes the original visit window and keeps access to unseen arrivals", async () => {
    const first = sectionOf("since_visit", [itemOf("a", MESSAGE_A)], 10);
    first.nextCursor = "frozen-window-next-page";
    harness.homeAnswer = answerOf([first]);
    await mountHome();
    harness.sectionAnswers.set("since_visit", first);
    act(() => { data.current!.refresh(); });
    await settle(); await settle();
    expect(harness.boundaries).toEqual(["2026-09-19T12:00:00.000Z"]);
    expect(data.current!.state.sections[0]!.nextCursor).toBe("frozen-window-next-page");
    expect(data.current!.state.sections[0]!.total).toBe(10);
  });

  it("loads one visit, caches it, and refreshes sections only", async () => {
    harness.homeAnswer = answerOf([
      ...EMPTY_SECTIONS,
      sectionOf("since_visit", [itemOf("a", MESSAGE_A)]),
    ]);
    await mountHome();
    expect(data.current!.state.phase).toBe("ready");
    expect(data.current!.state.offlineFromCache).toBe(false);
    expect(harness.homeReads).toBe(1);
    expect(data.current!.state.visitBoundary).toBe("2026-09-19T12:00:00.000Z");

    const cached = harness.store.get("cachedHome") as { generation: string | null };
    expect(cached.generation).toBe("gen-1");

    // The refresh answers only through the section route: the visit
    // boundary the session opened with stays the one the server holds.
    act(() => {
      data.current!.refresh();
    });
    await settle();
    await settle();
    expect(harness.homeReads).toBe(1);
    expect(harness.sectionReads).toHaveLength(5);
  });

  it("grows the frozen since window with new arrivals only", async () => {
    const base = itemOf("a", MESSAGE_A);
    harness.homeAnswer = answerOf([
      ...EMPTY_SECTIONS,
      sectionOf("since_visit", [base]),
    ]);
    await mountHome();

    // After the visit, another arrival lands: the section read returns only
    // it, and the merged window keeps the entry the visit already showed.
    harness.sectionAnswers.set(
      "since_visit",
      sectionOf("since_visit", [itemOf("b", MESSAGE_B), base]),
    );
    act(() => {
      data.current!.refresh();
    });
    await settle();
    await settle();
    const since = data.current!.state.sections.find((section) => section.id === "since_visit")!;
    expect(since.items.map((item) => item.entryKey)).toEqual(["b", "a"]);
  });

  it("keeps a dismissed entry out of the refreshed window", async () => {
    harness.homeAnswer = answerOf([
      ...EMPTY_SECTIONS,
      sectionOf("since_visit", [itemOf("a", MESSAGE_A), itemOf("b", MESSAGE_B)]),
    ]);
    await mountHome();

    act(() => {
      data.current!.removeEntry("since_visit", "a");
    });
    const afterRemoval = data.current!.state.sections.find((section) => section.id === "since_visit")!;
    expect(afterRemoval.items.map((item) => item.entryKey)).toEqual(["b"]);
    expect(afterRemoval.total).toBe(1);

    // The server applies the dismissal within the original visit window.
    harness.sectionAnswers.set(
      "since_visit",
      sectionOf("since_visit", [itemOf("b", MESSAGE_B)], 1),
    );
    act(() => {
      data.current!.refresh();
    });
    await settle();
    await settle();
    const refreshed = data.current!.state.sections.find((section) => section.id === "since_visit")!;
    expect(refreshed.items.map((item) => item.entryKey)).toEqual(["b"]);
  });

  it("expands a section through its cursor", async () => {
    const firstPage = sectionOf("needs_attention", [itemOf("a", MESSAGE_A)], 9);
    firstPage.nextCursor = "cursor-1";
    harness.homeAnswer = answerOf([
      ...EMPTY_SECTIONS.filter((section) => section.id !== "needs_attention"),
      sectionOf("since_visit", []),
      firstPage,
    ]);
    await mountHome();

    harness.sectionAnswers.set(
      "needs_attention",
      sectionOf("needs_attention", [itemOf("b", MESSAGE_B)], 9),
    );
    act(() => {
      data.current!.loadMore("needs_attention");
    });
    await settle();
    await settle();
    expect(harness.sectionReads).toContain("needs_attention?cursor-1");
    const attention = data.current!.state.sections.find(
      (section) => section.id === "needs_attention",
    )!;
    expect(attention.items.map((item) => item.entryKey)).toEqual(["a", "b"]);
    expect(attention.loadingMore).toBe(false);
  });

  it("serves the cached copy offline only for the matching generation", async () => {
    harness.homeAnswer = answerOf([...EMPTY_SECTIONS, sectionOf("since_visit", [])]);
    await mountHome("gen-1");
    expect(harness.store.has("cachedHome")).toBe(true);

    // The next open goes offline: the cached answer serves the same
    // generation, marked as cached with its timestamp.
    harness.failHome = true;
    await mountHome("gen-1");
    expect(data.current!.state.phase).toBe("ready");
    expect(data.current!.state.offlineFromCache).toBe(true);
    expect(data.current!.state.cachedAt).not.toBeNull();

    // A different recovery generation invalidates the copy outright.
    await mountHome("gen-2");
    expect(data.current!.state.phase).toBe("error");
    expect(data.current!.state.error?.network).toBe(true);
  });
});
