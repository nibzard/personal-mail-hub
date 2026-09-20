// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftAttachmentView } from "@mail-hub/contracts";
import {
  addFileToDraft,
  attachAcknowledgedUploads,
  formatRecipientList,
  invalidAddresses,
  newSendIdempotencyKey,
  parseRecipientList,
  recipientCount,
  type ComposeSession,
} from "../src/mail/compose-data.ts";

/*
 * The compose data layer (SPEC F6): recipient lines parse and format
 * round-trip, rough validation names the entries a person must correct,
 * every deliberate send earns its own idempotency key, and an upload the
 * server acknowledged never loses its id to a refused or lost link.
 */

const GENERATION = "11111111-1111-4111-8111-111111111111";

const offlineHarness = vi.hoisted(() => {
  return {
    uploads: [] as {
      localId: string;
      draftId: string;
      serverId: string | null;
      attachedAt: number | null;
    }[],
    attached: [] as string[],
    enqueued: [] as Record<string, unknown>[],
    storeAvailable: true,
    controllerAvailable: true,
  };
});

vi.mock("../src/offline/store.ts", () => ({
  offlineStore: () =>
    offlineHarness.storeAvailable
      ? {
          uploadsForDraft: async (draftId: string) =>
            offlineHarness.uploads.filter((upload) => upload.draftId === draftId),
          markUploadAttached: async (localId: string) => {
            offlineHarness.attached.push(localId);
            const upload = offlineHarness.uploads.find((entry) => entry.localId === localId);
            if (upload !== undefined) {
              upload.attachedAt = 1;
            }
          },
          serverGeneration: async () => "11111111-1111-4111-8111-111111111111",
        }
      : null,
  uploadFits: (upload: { sizeBytes: number }) => upload.sizeBytes <= 25 * 1024 * 1024,
  UPLOAD_MAX_BYTES: 25 * 1024 * 1024,
  resetOfflineStore: () => {},
}));

vi.mock("../src/offline/port.ts", () => ({
  offlineSync: () =>
    offlineHarness.controllerAvailable
      ? {
          enqueueUpload: async (upload: Record<string, unknown>) => {
            offlineHarness.enqueued.push(upload);
            return { action: { localId: "q-1" }, upload: { localId: "l-new", ...upload } };
          },
        }
      : null,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  offlineHarness.uploads.length = 0;
  offlineHarness.attached.length = 0;
  offlineHarness.enqueued.length = 0;
  offlineHarness.storeAvailable = true;
  offlineHarness.controllerAvailable = true;
});

describe("parseRecipientList", () => {
  it("splits on commas and semicolons and drops empties", () => {
    expect(parseRecipientList("a@example.com, b@example.com;;  ,c@example.com")).toEqual([
      { address: "a@example.com", name: null },
      { address: "b@example.com", name: null },
      { address: "c@example.com", name: null },
    ]);
  });

  it("reads a display name in angle brackets", () => {
    expect(parseRecipientList("Sam Rivera <sam@example.com>")).toEqual([
      { address: "sam@example.com", name: "Sam Rivera" },
    ]);
    expect(parseRecipientList("<bare@example.com>")).toEqual([
      { address: "bare@example.com", name: null },
    ]);
  });

  it("keeps an unparseable entry verbatim for validation to name", () => {
    expect(parseRecipientList("not an address")).toEqual([
      { address: "not an address", name: null },
    ]);
  });

  it("round-trips through formatRecipientList", () => {
    const line = "Sam Rivera <sam@example.com>, bare@example.com";
    expect(formatRecipientList(parseRecipientList(line))).toBe(line);
  });
});

describe("invalidAddresses", () => {
  it("names the entries without an address shape", () => {
    const parsed = parseRecipientList("a@example.com, oops, b@example.com");
    expect(invalidAddresses(parsed)).toEqual(["oops"]);
  });

  it("accepts every plain address shape", () => {
    expect(invalidAddresses(parseRecipientList("a.b+c@example.co.uk"))).toEqual([]);
  });
});

describe("recipientCount", () => {
  it("sums to, cc, and bcc", () => {
    expect(
      recipientCount({
        to: parseRecipientList("a@example.com"),
        cc: parseRecipientList("b@example.com, c@example.com"),
        bcc: parseRecipientList("d@example.com"),
      }),
    ).toBe(4);
  });

  it("treats absent lists as empty", () => {
    expect(recipientCount({ to: parseRecipientList("a@example.com") })).toBe(1);
  });
});

describe("newSendIdempotencyKey", () => {
  it("never repeats within one session", () => {
    const keys = new Set(Array.from({ length: 64 }, () => newSendIdempotencyKey()));
    expect(keys.size).toBe(64);
  });
});

/** One attachment row of the list the server's draft carries. */
function attachment(id: string): DraftAttachmentView {
  return {
    id,
    accountId: "a1",
    filename: "photo.png",
    contentType: "image/png",
    sizeBytes: 6,
    sha256: "0".repeat(64),
    createdAt: "2026-09-20T10:00:00.000Z",
    ordinal: 0,
  };
}

/** One scripted network over the draft and upload routes. */
function json(status: number, body: unknown): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe("attachAcknowledgedUploads", () => {
  const session: ComposeSession = { recoveryGeneration: GENERATION };

  it("marks an upload the server draft already references as attached", async () => {
    offlineHarness.uploads.push({
      localId: "l1",
      draftId: "d1",
      serverId: "u-1",
      attachedAt: null,
    });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${String(url)}`);
        return json(500, { error: { code: "http_500", message: "Duplicate link." } });
      }),
    );

    const outcome = await attachAcknowledgedUploads(session, "d1", [attachment("u-1")]);

    // Without the local convergence, this record blocks its draft's send
    // with UploadsUnverifiedError forever (SPEC F6).
    expect(outcome).toEqual({ changed: false, failed: 0 });
    expect(offlineHarness.attached).toEqual(["l1"]);
    expect(offlineHarness.uploads[0]!.attachedAt).not.toBeNull();
    expect(requests).toEqual([]);
  });

  it("attaches an acknowledged upload the draft does not reference", async () => {
    offlineHarness.uploads.push({
      localId: "l2",
      draftId: "d1",
      serverId: "u-2",
      attachedAt: null,
    });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        requests.push(`${init?.method ?? "GET"} ${String(url)}`);
        return json(201, attachment("u-2"));
      }),
    );

    const outcome = await attachAcknowledgedUploads(session, "d1", [attachment("u-1")]);

    expect(outcome).toEqual({ changed: true, failed: 0 });
    expect(offlineHarness.attached).toEqual(["l2"]);
    expect(requests).toEqual(["POST /api/drafts/d1/uploads"]);
  });

  it("counts a refused attach without dropping the acknowledged id", async () => {
    offlineHarness.uploads.push({
      localId: "l3",
      draftId: "d1",
      serverId: "u-3",
      attachedAt: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          json(409, { error: { code: "draft_locked", message: "The draft is locked." } }) as Response,
      ),
    );

    const outcome = await attachAcknowledgedUploads(session, "d1", []);

    expect(outcome).toEqual({ changed: false, failed: 1 });
    expect(offlineHarness.attached).toEqual([]);
  });
});

describe("addFileToDraft", () => {
  const session: ComposeSession = { recoveryGeneration: GENERATION };
  const draft = { id: "d1", accountId: "a1" };

  /** One small file, as the editor's file input hands it over. */
  function photo(): File {
    return new File(["bytes"], "photo.png", { type: "image/png" });
  }

  it("keeps the acknowledged id when the server refuses the link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith("/api/uploads")) {
          return json(201, { upload: attachment("u-9") });
        }
        return json(409, { error: { code: "draft_locked", message: "The draft is locked." } });
      }),
    );

    const outcome = await addFileToDraft(session, draft, photo());

    expect(outcome).toEqual({ state: "queued-offline", filename: "photo.png" });
    expect(offlineHarness.enqueued).toEqual([
      expect.objectContaining({
        draftId: "d1",
        serverId: "u-9",
        attachedAt: null,
        recoveryGeneration: GENERATION,
      }),
    ]);
    // The server owns the bytes; only the link still waits.
    expect((offlineHarness.enqueued[0]!.bytes as Blob).size).toBe(0);
  });

  it("returns the attached file when the link lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).startsWith("/api/uploads")) {
          return json(201, { upload: attachment("u-9") });
        }
        return json(201, attachment("u-9"));
      }),
    );

    const outcome = await addFileToDraft(session, draft, photo());

    expect(outcome).toEqual({ state: "attached", attachment: attachment("u-9") });
    expect(offlineHarness.enqueued).toEqual([]);
  });

  it.each([true, false])("reuses an acknowledged upload after a lost attach response (landed: %s)", async (landed) => {
    const serverAttachments: DraftAttachmentView[] = [];
    let uploads = 0;
    let attaches = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).startsWith("/api/uploads")) {
        uploads += 1;
        return json(201, { upload: attachment("u-9") });
      }
      attaches += 1;
      if (attaches === 1) {
        if (landed) serverAttachments.push(attachment("u-9"));
        throw new TypeError("Failed to fetch");
      }
      serverAttachments.push(attachment("u-9"));
      return json(201, attachment("u-9"));
    }));

    expect(await addFileToDraft(session, draft, photo())).toEqual({
      state: "queued-offline", filename: "photo.png",
    });
    expect(offlineHarness.enqueued[0]).toMatchObject({ serverId: "u-9", attachedAt: null });
    offlineHarness.uploads.push({ localId: "l-new", draftId: "d1", serverId: "u-9", attachedAt: null });

    const result = await attachAcknowledgedUploads(session, draft.id, serverAttachments);

    expect(result.failed).toBe(0);
    expect(uploads).toBe(1);
    expect(attaches).toBe(landed ? 1 : 2);
    expect(serverAttachments).toHaveLength(1);
    expect(offlineHarness.attached).toEqual(["l-new"]);
  });

  it("queues the bytes again when the upload never received an acknowledgement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("The connection left.");
      }),
    );

    const outcome = await addFileToDraft(session, draft, photo());

    expect(outcome).toEqual({ state: "queued-offline", filename: "photo.png" });
    expect(offlineHarness.enqueued).toEqual([
      expect.objectContaining({ serverId: null, attachedAt: null }),
    ]);
    expect((offlineHarness.enqueued[0]!.bytes as Blob).size).toBe(5);
  });

  it("rejects when the server refuses the bytes themselves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          json(413, { error: { code: "invalid_request", message: "Too large." } }) as Response,
      ),
    );

    const outcome = await addFileToDraft(session, draft, photo());

    expect(outcome).toEqual({ state: "rejected", message: "Too large." });
    expect(offlineHarness.enqueued).toEqual([]);
  });
});
