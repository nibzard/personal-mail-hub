// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchResultsResponse, SearchResultItem } from "@mail-hub/contracts";

/*
 * The message list's paged refresh (SPEC F12 and F4): a manual refresh of a
 * view that already fetched more than one page reloads the whole window and
 * replaces the rows from their first row, so serverReadId rises and the
 * pending action overlays retire — the paged counterpart of the page-one
 * behavior.
 */

const harness = vi.hoisted(() => ({
  rows: [] as SearchResultItem[],
  calls: [] as Array<{ limit: number; offset: number }>,
}));

vi.mock("../src/lib/api.ts", () => ({
  apiGet: async (path: string) => {
    const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    const limit = Number(query.get("limit"));
    const offset = Number(query.get("offset"));
    harness.calls.push({ limit, offset });
    const response: SearchResultsResponse = {
      results: harness.rows.slice(offset, offset + limit),
      total: harness.rows.length,
      indexing: { messages: 0, bodies: 0 },
    };
    return response;
  },
  apiGetBlob: async () => {
    throw new Error("unused in this suite");
  },
  toApiError: () => {
    throw new Error("unused in this suite");
  },
  ApiError: class extends Error {},
}));

import { useMessageList, type MessageList } from "../src/mail/data.ts";
import type { MailScope } from "../src/mail/view.ts";

function row(id: string): SearchResultItem {
  return {
    messageId: id,
    accountId: "acc-1",
    accountLabel: "Main",
    accountColor: "#2563eb",
    threadId: null,
    subject: `Subject ${id}`,
    snippet: null,
    sender: { address: "someone@example.com" },
    sentAt: "2026-09-18T10:00:00Z",
    fetchedBody: true,
    hasAttachments: false,
    unread: false,
    flagged: false,
    activeOccurrences: 1,
    occurrences: [],
    noServerCopy: false,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let list: { current: MessageList | null };

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
  harness.rows = [];
  harness.calls.length = 0;
});

/** Mounts the hook behind one probe that records the list it renders. */
async function mountList(scope: MailScope): Promise<void> {
  list = { current: null };
  function Probe() {
    list.current = useMessageList(scope, "", null, null);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  expect(list.current).not.toBeNull();
}

describe("useMessageList's paged refresh", () => {
  it("reloads the whole window on a refresh of a paged view", async () => {
    harness.rows = Array.from({ length: 120 }, (_, index) => row(`m-${String(index).padStart(3, "0")}`));
    await mountList({ kind: "account", accountId: "acc-1", folderId: "f-1" });

    // The first page reads from its first row.
    expect(list.current!.state.rows).toHaveLength(50);
    expect(list.current!.state.rows[0]!.messageId).toBe("m-000");
    expect(list.current!.state.serverReadId).toBe(1);
    const firstReadId = list.current!.state.serverReadId;

    // Load more appends one page without another replacing read.
    await act(async () => {
      list.current!.loadMore();
    });
    expect(list.current!.state.rows).toHaveLength(100);
    expect(list.current!.state.serverReadId).toBe(firstReadId);
    expect(list.current!.state.loadingMore).toBe(false);

    // The server changes while the owner reads: one row leaves, one arrives.
    harness.rows = [row("m-new"), ...harness.rows.slice(1)];
    await act(async () => {
      list.current!.reload();
    });

    const state = list.current!.state;
    // The refresh asked for the whole window the pages cover, from row zero.
    expect(harness.calls.at(-1)).toEqual({ limit: 100, offset: 0 });
    // The rows were replaced, not stitched under the kept ones.
    expect(state.rows).toHaveLength(100);
    expect(state.rows[0]!.messageId).toBe("m-new");
    expect(state.rows.some((item) => item.messageId === "m-000")).toBe(false);
    // The replacing read raised serverReadId, so the overlays retire.
    expect(state.serverReadId).toBeGreaterThan(firstReadId);
    expect(state.phase).toBe("ready");
    expect(state.refreshing).toBe(false);
    expect(state.loadingMore).toBe(false);
  });

  it("keeps appends continuing after the window a refresh reloaded", async () => {
    harness.rows = Array.from({ length: 120 }, (_, index) => row(`m-${String(index).padStart(3, "0")}`));
    await mountList({ kind: "account", accountId: "acc-1", folderId: "f-1" });
    await act(async () => {
      list.current!.loadMore();
    });
    expect(list.current!.state.rows).toHaveLength(100);

    // A refresh replaces the window; the next appended page continues after
    // the rows the window covers, not after a page-count guess.
    await act(async () => {
      list.current!.reload();
    });
    expect(harness.calls.at(-1)).toEqual({ limit: 100, offset: 0 });
    await act(async () => {
      list.current!.loadMore();
    });
    expect(harness.calls.at(-1)).toEqual({ limit: 50, offset: 100 });
    expect(list.current!.state.rows).toHaveLength(120);
    expect(list.current!.state.rows.at(-1)!.messageId).toBe("m-119");
  });
});
