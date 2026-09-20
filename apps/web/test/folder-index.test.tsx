// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccountSummary, FolderSummary } from "@mail-hub/contracts";

/*
 * The folder index's per-account tolerance (SPEC F9 and F3): one account's
 * failed read drops only that account's folders — the index stays usable for
 * the accounts that answered — and only a total failure surfaces the error
 * path the shell already renders.
 */

const harness = vi.hoisted(() => ({
  failing: new Set<string>(),
}));

/** One network-style refusal, shaped the way the client's `toApiError` keeps. */
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
    const match = /^\/accounts\/([^/]+)\/folders$/.exec(path);
    if (match === null) {
      throw new TestApiError(500, "unexpected", `Unexpected read: ${path}`);
    }
    const accountId = match[1]!;
    if (harness.failing.has(accountId)) {
      throw new TestApiError(500, "account_read_failed", "The account cannot be reached.");
    }
    return {
      folders: foldersOf(accountId),
      pendingRoleChoices: [],
    };
  },
  apiGetBlob: async () => {
    throw new Error("unused in this suite");
  },
  toApiError: (cause: unknown) => cause,
  ApiError: class extends Error {},
}));

import { useFolderIndex, type FolderIndex } from "../src/mail/data.ts";

function foldersOf(accountId: string): FolderSummary[] {
  return [
    { id: `${accountId}-inbox`, name: "Inbox", role: "inbox" },
    { id: `${accountId}-archive`, name: "Archive", role: "archive" },
  ];
}

function account(id: string): AccountSummary {
  return {
    id,
    label: id,
    color: "#2563eb",
    username: `user@${id}`,
    identities: [{ address: `one@${id}`, name: null, isDefault: true }],
  } as AccountSummary;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let index: { current: FolderIndex | null } = { current: null };
let currentAccounts: AccountSummary[] = [];

/** The probe renders the hook with whatever accounts the test last set. */
function Probe() {
  index.current = useFolderIndex(currentAccounts);
  return null;
}

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
  harness.failing.clear();
  index = { current: null };
  currentAccounts = [];
});

/** Mounts the hook behind the probe. */
async function mountIndex(accounts: AccountSummary[]): Promise<void> {
  currentAccounts = accounts;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  expect(index.current).not.toBeNull();
}

describe("useFolderIndex's per-account tolerance", () => {
  it("keeps the answered accounts when one read fails", async () => {
    harness.failing.add("acc-2");
    await mountIndex([account("acc-1"), account("acc-2"), account("acc-3")]);

    expect(index.current!.phase).toBe("ready");
    expect([...index.current!.data!.keys()]).toEqual(["acc-1", "acc-3"]);
    expect(index.current!.data!.get("acc-1")).toEqual(foldersOf("acc-1"));
    // The rejected account is named, so the interface can degrade per
    // account instead of failing the whole index.
    expect(index.current!.failedAccounts).toEqual(["acc-2"]);
    expect(index.current!.error).toBeNull();
  });

  it("surfaces the error path only when every read fails", async () => {
    harness.failing.add("acc-1");
    harness.failing.add("acc-2");
    await mountIndex([account("acc-1"), account("acc-2")]);

    expect(index.current!.phase).toBe("error");
    expect(index.current!.error?.message).toBe("The account cannot be reached.");
    expect(index.current!.data).toBeNull();
  });

  it("answers an empty account list with an empty index", async () => {
    await mountIndex([]);
    expect(index.current!.phase).toBe("ready");
    expect(index.current!.data!.size).toBe(0);
    expect(index.current!.failedAccounts).toEqual([]);
  });
});
