// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountSummary,
  HomeItemView,
  HomeResponse,
  HomeSectionView,
  SearchResultItem,
} from "@mail-hub/contracts";

/*
 * The Home screen (SPEC F13): sections render with their fixed reason
 * labels, empty sections hide and Saved starts collapsed, a row opens the
 * reader, a dismissal removes its row and offers undo, a failure keeps the
 * row with the server's reason, and offline state disables the Home
 * changes instead of queueing them.
 */

const ACCOUNT = "9d0a6d15-2a6e-4bb5-9f5e-0f0a9a1b2c3d";
const MESSAGE_A = "11111111-1111-4111-8111-111111111111";
const MESSAGE_B = "22222222-2222-4222-8222-222222222222";
const MESSAGE_S = "44444444-4444-4444-8444-444444444444";
const GENERATION = "55555555-5555-4555-8555-555555555555";

const harness = vi.hoisted(() => ({
  homeAnswer: null as HomeResponse | null,
  posts: [] as Array<{ path: string; body: unknown; headers: Record<string, string> }>,
  deletes: [] as Array<{ path: string; headers: Record<string, string> }>,
  failNextPost: false,
}));

vi.mock("../src/lib/api.ts", () => ({
  apiGet: async (path: string) => {
    if (path.startsWith("/home?")) {
      if (harness.homeAnswer === null) {
        throw new Error("No Home answer was prepared.");
      }
      return harness.homeAnswer;
    }
    if (path.startsWith("/home/sections/")) {
      const id = path.slice("/home/sections/".length).split("?")[0]!;
      const section = harness.homeAnswer?.sections.find((entry) => entry.id === id);
      return { section: section ?? { id, total: 0, items: [], nextCursor: null } };
    }
    if (path.startsWith("/home/priorities")) {
      return { priorities: [] };
    }
    throw new Error(`Unexpected read: ${path}`);
  },
  apiPost: async (
    path: string,
    body: unknown,
    options: { headers?: Record<string, string> } = {},
  ) => {
    if (harness.failNextPost) {
      harness.failNextPost = false;
      throw new Error("The mail service cannot be reached.");
    }
    harness.posts.push({ path, body, headers: options.headers ?? {} });
    if (path === "/home/dismissals") {
      return { dismissed: body };
    }
    const work = body as { kind?: string };
    return {
      work: {
        id: "33333333-3333-4333-8333-333333333333",
        kind: work.kind ?? "reply_later",
        status: "open",
        dueAt: null,
        timeZone: null,
        revision: 1,
        anchorUnavailable: false,
        accountId: ACCOUNT,
        anchorMessageId: MESSAGE_A,
        anchor: null,
        createdAt: "2026-09-20T10:00:00.000Z",
        updatedAt: "2026-09-20T10:00:00.000Z",
        completedAt: null,
      },
    };
  },
  apiPut: async () => ({ priorities: [] }),
  apiDelete: async (path: string, options: { headers?: Record<string, string> } = {}) => {
    harness.deletes.push({ path, headers: options.headers ?? {} });
    return undefined;
  },
  toApiError: (cause: unknown) =>
    cause instanceof Error
      ? Object.assign(cause, { status: 0, network: true, unauthorized: false })
      : new Error("unexpected"),
  ApiError: class extends Error {},
}));

import { HomeScreen } from "../src/components/home/home-screen.tsx";

const ACCOUNT_SUMMARY: AccountSummary = {
  id: ACCOUNT,
  label: "Main",
  color: "#2563eb",
  imapHost: "imap.example.com",
  imapPort: 993,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecurity: "starttls_required",
  username: "main@hub.example",
  identities: [],
  classifyEnabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const opened: SearchResultItem[] = [];
const propCalls = { inbox: 0, settings: 0 };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  harness.homeAnswer = answerOf([
    sectionOf("due_now", []),
    sectionOf("needs_attention", [itemOf("a", MESSAGE_A), itemOf("b", MESSAGE_B)]),
    sectionOf("reply_later", []),
    sectionOf("since_visit", []),
    sectionOf("saved", [itemOf("s", MESSAGE_S)]),
  ]);
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
  harness.posts.length = 0;
  harness.deletes.length = 0;
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

/** Mounts the screen with the standard account and recorded callbacks. */
async function mountScreen(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <HomeScreen
        accounts={[ACCOUNT_SUMMARY]}
        recoveryGeneration={GENERATION}
        active
        archiveDestination={() => "f-archive"}
        onOpenMessage={(row) => opened.push(row)}
        onOpenInbox={() => {
          propCalls.inbox += 1;
        }}
        onOpenSettings={() => {
          propCalls.settings += 1;
        }}
        onSessionLost={() => {}}
      />,
    );
  });
}

/** Every button whose text contains the given words. */
function buttonsWith(text: string): HTMLButtonElement[] {
  return [...container!.querySelectorAll("button")].filter((button) =>
    (button.textContent ?? "").includes(text),
  ) as HTMLButtonElement[];
}

function noteText(): string | null {
  return container!.querySelector("p[role=status]")?.textContent ?? null;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function itemOf(
  entryKey: string,
  messageId: string,
  overrides: Partial<HomeItemView> = {},
): HomeItemView {
  return {
    entryKey,
    message: {
      messageId,
      accountId: ACCOUNT,
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
    ...overrides,
  };
}

function sectionOf(id: string, items: HomeItemView[], total = items.length): HomeSectionView {
  return { id: id as HomeSectionView["id"], total, items, nextCursor: null };
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
    visitBoundary: null,
  };
}

describe("the Home screen", () => {
  it("renders the sections, hides the empty ones, and collapses Saved", async () => {
    await mountScreen();
    const headings = [...container!.querySelectorAll("h3")].map((node) => node.textContent);
    expect(headings).toContain("Needs attention");
    expect(headings).not.toContain("Due now");
    expect(headings).toContain("Saved");

    // Saved starts collapsed: its heading shows, its rows wait behind the
    // count control.
    expect(buttonsWith("Show 1 starred")).toHaveLength(1);
    expect(container!.textContent).not.toContain("Subject s");
    // The fixed reason vocabulary shows, with the origin spelled out for
    // screen readers.
    expect(container!.textContent).toContain("May need your reply");
    expect(container!.querySelector(".sr-only")?.textContent).toContain("Suggestion");
    // Coverage stays honest about what the suggestions cover.
    expect(container!.textContent).toContain("12");
    expect(container!.textContent).toContain("40");
  });

  it("opens one row in the reader", async () => {
    await mountScreen();
    act(() => {
      buttonsWith("Subject a")[0]!.click();
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.messageId).toBe(MESSAGE_A);
    expect(opened[0]!.accountId).toBe(ACCOUNT);
  });

  it("dismisses a suggestion, removes its row, and undoes it", async () => {
    await mountScreen();
    act(() => {
      buttonsWith("Dismiss")[0]!.click();
    });
    await settle();
    await settle();
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]!.path).toBe("/home/dismissals");
    expect(harness.posts[0]!.body).toEqual({ accountId: ACCOUNT, messageId: MESSAGE_A });
    expect(harness.posts[0]!.headers["x-recovery-generation"]).toBe(GENERATION);

    expect(noteText()).toContain("Suggestion removed");
    expect(container!.textContent).not.toContain("Subject a");
    expect(container!.textContent).toContain("Subject b");

    act(() => {
      buttonsWith("Undo")[0]!.click();
    });
    await settle();
    await settle();
    expect(harness.deletes).toHaveLength(1);
    expect(harness.deletes[0]!.path).toContain(MESSAGE_A);
    expect(noteText()).toContain("Suggestion restored");
  });

  it("saves reply later and reports the result beside the rows", async () => {
    await mountScreen();
    act(() => {
      buttonsWith("Reply later")[0]!.click();
    });
    await settle();
    await settle();
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]!.path).toBe("/home/work");
    expect(harness.posts[0]!.body).toEqual({
      accountId: ACCOUNT,
      anchorMessageId: MESSAGE_A,
      kind: "reply_later",
    });
    expect(harness.posts[0]!.headers["x-recovery-generation"]).toBe(GENERATION);
    expect(noteText()).toContain("Saved to reply later");
    expect(container!.textContent).toContain("Subject a");
  });

  it("sets a reminder through a preset that shows the resolved time first", async () => {
    await mountScreen();
    act(() => {
      buttonsWith("Remind me")[0]!.click();
    });
    // Each preset names the resolved date, time, and timezone before
    // anything saves.
    expect(container!.textContent).toContain("Later today");
    expect(container!.textContent).toContain("Tomorrow");
    expect(container!.textContent).toMatch(/Saves .*(UTC[+-]\d+|GMT)/);

    // The custom control stays empty, so the last enabled preset button is
    // Tomorrow.
    const savers = buttonsWith("Set reminder").filter((button) => !button.disabled);
    expect(savers.length).toBeGreaterThanOrEqual(1);
    act(() => {
      savers[savers.length - 1]!.click();
    });
    await settle();
    await settle();
    expect(harness.posts).toHaveLength(1);
    const body = harness.posts[0]!.body as {
      kind: string;
      dueAt: string;
      timeZone: string;
    };
    expect(body.kind).toBe("reminder");
    expect(Number.isNaN(Date.parse(body.dueAt))).toBe(false);
    expect(body.timeZone.length).toBeGreaterThan(0);
    expect(noteText()).toContain("Reminder set for");
  });

  it("keeps a failed change visible with the server's reason", async () => {
    await mountScreen();
    harness.failNextPost = true;
    act(() => {
      buttonsWith("Reply later")[0]!.click();
    });
    await settle();
    await settle();
    expect(noteText()).toContain("cannot be reached");
    expect(container!.textContent).toContain("Subject a");
  });

  it("disables the Home changes while offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    await mountScreen();
    expect(buttonsWith("Reply later")[0]!.disabled).toBe(true);
    expect(buttonsWith("Remind me")[0]!.disabled).toBe(true);
    expect(container!.textContent).toContain("Home changes need a connection");
    // Mailbox actions keep their established behavior: they queue offline,
    // so they stay available for a row with a server copy.
    expect(buttonsWith("Archive")[0]!.disabled).toBe(false);
  });

  it("shows the empty state when every section is empty", async () => {
    harness.homeAnswer = answerOf([
      sectionOf("due_now", []),
      sectionOf("needs_attention", []),
      sectionOf("reply_later", []),
      sectionOf("since_visit", []),
      sectionOf("saved", []),
    ]);
    await mountScreen();
    expect(container!.textContent).toContain("No suggestions right now");
    expect(buttonsWith("Open Inbox")).not.toHaveLength(0);
  });
});
