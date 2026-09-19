// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResultItem } from "@mail-hub/contracts";
import type { QueuedAction, QueuedPayload } from "@mail-hub/offline";

/*
 * The client half of the mail actions (SPEC F4 and section 7): freezing the
 * occurrences of one row, submitting with the captured generation, counting
 * the receipts, and queueing when the device or the request cannot reach
 * the server.
 */

vi.mock("../src/offline/port.ts", () => ({
  offlineSync: () => mockController,
}));

const enqueued: QueuedPayload[] = [];
const mockController = {
  enqueueMailAction: async (payload: QueuedPayload): Promise<QueuedAction> => {
    enqueued.push(payload);
    return {
      localId: "local-1",
      payload,
      state: "pending",
      reviewReason: null,
      failure: null,
      attempts: 0,
      recoveryGeneration: "11111111-1111-4111-8111-111111111111",
      queuedAt: 1,
      syncedAt: null,
    };
  },
};

const { runMailAction } = await import("../src/mail/actions.ts");

const GENERATION = "11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    messageId: "m1",
    accountId: "a1",
    accountLabel: "Personal",
    accountColor: "#336699",
    threadId: null,
    subject: "Quarterly report",
    snippet: "Numbers attached.",
    sender: { address: "boss@example.com", name: "Boss" },
    sentAt: "2026-09-18T08:00:00Z",
    fetchedBody: true,
    hasAttachments: false,
    unread: true,
    flagged: false,
    activeOccurrences: 2,
    occurrences: [
      { occurrenceId: "occ-1", folderId: "f-inbox", revision: 4, modseq: "21" },
      { occurrenceId: "occ-2", folderId: "f-inbox", revision: 2, modseq: null },
    ],
    noServerCopy: false,
    sentCopyStatus: null,
    rank: null,
    highlight: null,
    highlightSource: null,
    ...overrides,
  };
}

/** The fetch calls the module made, for request assertions. */
const fetchCalls: { url: string; init: RequestInit }[] = [];

function fetchRespondingWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      // A plain stand-in: `request` reads only `ok`, `status`, and `text`.
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }),
  );
}

function setOnline(on: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value: on, configurable: true });
}

beforeEach(() => {
  enqueued.length = 0;
  fetchCalls.length = 0;
  setOnline(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runMailAction", () => {
  it("submits the frozen occurrences with the captured generation", async () => {
    fetchRespondingWith({
      action: {
        actionId: "act-1",
        kind: "star",
        status: "complete",
        idempotencyKey: "idem",
        items: [
          { itemKey: "occ-1", status: "confirmed", outcome: null },
          { itemKey: "occ-2", status: "conflicted", outcome: null },
        ],
      },
    });

    const outcome = await runMailAction({
      kind: "star",
      row: row(),
      recoveryGeneration: GENERATION,
    });

    expect(outcome).toEqual({
      state: "submitted",
      kind: "star",
      confirmed: 1,
      pending: 0,
      needsAttention: 1,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("/api/actions");
    const init = fetchCalls[0]!.init as { headers: Record<string, string>; body: string };
    expect(init.headers["x-recovery-generation"]).toBe(GENERATION);
    const body = JSON.parse(init.body as string) as {
      accountId: string;
      kind: string;
      occurrenceIds: string[];
      destinationFolderId?: string;
    };
    expect(body).toMatchObject({ accountId: "a1", kind: "star", occurrenceIds: ["occ-1", "occ-2"] });
    expect(body.destinationFolderId).toBeUndefined();
  });

  it("passes the destination with a move", async () => {
    fetchRespondingWith({
      action: {
        actionId: "act-2",
        kind: "move",
        status: "queued",
        idempotencyKey: "idem",
        items: [{ itemKey: "occ-1", status: "queued", outcome: null }],
      },
    });

    const outcome = await runMailAction({
      kind: "move",
      row: row(),
      destinationFolderId: "f-archive",
      recoveryGeneration: GENERATION,
    });

    expect(outcome).toEqual({
      state: "submitted",
      kind: "move",
      confirmed: 0,
      pending: 1,
      needsAttention: 0,
    });
    const body = JSON.parse((fetchCalls[0]!.init as { body: string }).body) as {
      destinationFolderId?: string;
    };
    expect(body.destinationFolderId).toBe("f-archive");
  });

  it("rejects a retained record before any request", async () => {
    fetchRespondingWith({});

    const outcome = await runMailAction({
      kind: "star",
      row: row({ activeOccurrences: 0, occurrences: [], noServerCopy: true }),
      recoveryGeneration: GENERATION,
    });

    expect(outcome).toEqual({
      state: "rejected",
      kind: "star",
      message: "This message has no server copy, so no server action can run on it.",
    });
    expect(fetchCalls).toHaveLength(0);
  });

  it("reports a server refusal with its message", async () => {
    fetchRespondingWith(
      { error: { code: "recovery_required", message: "The control state moved on." } },
      409,
    );

    const outcome = await runMailAction({
      kind: "archive",
      row: row(),
      destinationFolderId: "f-archive",
      recoveryGeneration: GENERATION,
    });

    expect(outcome).toEqual({
      state: "rejected",
      kind: "archive",
      message: "The control state moved on.",
    });
    expect(enqueued).toEqual([]);
  });

  it("queues the frozen action when a request cannot reach the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const outcome = await runMailAction({
      kind: "mark_read",
      row: row(),
      recoveryGeneration: GENERATION,
    });

    expect(outcome).toEqual({ state: "queued-offline", kind: "mark_read" });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: "flag",
      flag: "unread",
      value: false,
    });
    expect(enqueued[0]).toHaveProperty("idempotencyKey");
    const targets = (enqueued[0] as { targets: unknown[] }).targets;
    expect(targets).toEqual([
      {
        accountId: "a1",
        folderId: "f-inbox",
        messageId: "m1",
        occurrenceId: "occ-1",
        revision: 4,
        modseq: "21",
      },
      {
        accountId: "a1",
        folderId: "f-inbox",
        messageId: "m1",
        occurrenceId: "occ-2",
        revision: 2,
        modseq: null,
      },
    ]);
  });

  it("queues without any request while the device is offline", async () => {
    fetchRespondingWith({});
    setOnline(false);

    const outcome = await runMailAction({
      kind: "move",
      row: row(),
      destinationFolderId: "f-archive",
      recoveryGeneration: GENERATION,
    });

    expect(outcome).toEqual({ state: "queued-offline", kind: "move" });
    expect(fetchCalls).toHaveLength(0);
    expect(enqueued[0]).toMatchObject({
      kind: "move",
      destinationFolderId: "f-archive",
    });
  });

  it("refuses to submit without a server-issued generation", async () => {
    fetchRespondingWith({});

    const outcome = await runMailAction({
      kind: "star",
      row: row(),
      recoveryGeneration: null,
    });

    expect(outcome).toMatchObject({ state: "rejected" });
    expect(fetchCalls).toHaveLength(0);
    expect(enqueued).toEqual([]);
  });
});
