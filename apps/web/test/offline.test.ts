// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api.ts";
import {
  describeSyncStatus,
  reviewKindLabel,
  reviewReasonLabel,
} from "../src/components/mail/sync-status.tsx";
import { classifyReplayFailure, webOfflinePort } from "../src/offline/port.ts";
import { uploadFits, UPLOAD_MAX_BYTES } from "../src/offline/store.ts";
import type { FailedItem, FrozenTarget, OfflineStore, SyncSnapshot } from "@mail-hub/offline";

/*
 * The offline wiring's decisions (SPEC F9): how one failed replay attempt
 * classifies, what the always-visible sync line says, and the upload
 * preflight limit.
 */

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    serverGeneration: "11111111-1111-4111-8111-111111111111",
    reviewRequired: false,
    restore: null,
    signInRequired: false,
    pendingActions: 0,
    unsupportedActions: 0,
    waitingSends: 0,
    reviewActions: [],
    failedActions: [],
    dirtyDrafts: 0,
    pendingUploads: 0,
    lastSyncedAt: null,
    ...overrides,
  };
}

/** One refused queue item, as the fixture shows it. */
function failedItem(overrides: Partial<FailedItem> = {}): FailedItem {
  return {
    localId: "failed-1",
    kind: "upload",
    failure: "413 too large",
    queuedAt: 1,
    draftId: "d1",
    ...overrides,
  };
}

describe("replay failure classification", () => {
  it("retries a network failure for ordinary kinds", () => {
    const outcome = classifyReplayFailure(new ApiError(0, "network_error", "Unreachable."));
    expect(outcome).toEqual({ state: "retry", reason: "Unreachable." });
  });

  it("holds a send's lost response as uncertain, never retryable", () => {
    const outcome = classifyReplayFailure(new ApiError(0, "network_error", "Unreachable."), {
      lostResponseIsUncertain: true,
    });
    expect(outcome).toEqual({ state: "review", reason: "uncertain_send" });
  });

  it("moves stale drafts and restore refusals to review", () => {
    expect(classifyReplayFailure(new ApiError(409, "draft_stale", "Stale."))).toEqual({
      state: "review",
      reason: "draft_conflict",
    });
    expect(classifyReplayFailure(new ApiError(409, "recovery_required", "Restored."))).toEqual({
      state: "review",
      reason: "server_restored",
    });
    // Recovery still in progress is server-side trouble, not a restore.
    expect(classifyReplayFailure(new ApiError(503, "recovery_in_progress", "Recovering."))).toEqual(
      {
        state: "retry",
        reason: "Recovering.",
      },
    );
  });

  it("retries server-side trouble and records definitive refusals", () => {
    expect(classifyReplayFailure(new ApiError(502, "http_502", "Bad gateway."))).toEqual({
      state: "retry",
      reason: "Bad gateway.",
    });
    expect(classifyReplayFailure(new ApiError(429, "http_429", "Slow down."))).toEqual({
      state: "retry",
      reason: "Slow down.",
    });
    expect(classifyReplayFailure(new ApiError(413, "http_413", "Too large."))).toEqual({
      state: "failed",
      reason: "Too large.",
    });
    expect(classifyReplayFailure(new ApiError(400, "invalid_request", "Malformed."))).toEqual({
      state: "failed",
      reason: "Malformed.",
    });
  });

  it("pauses for sign-in on an ended session instead of failing the item", () => {
    expect(classifyReplayFailure(new ApiError(401, "http_401", "The session ended."))).toEqual({
      state: "retry",
      reason: "The session ended.",
      signInRequired: true,
    });
  });
});

describe("the sync status line", () => {
  it("stays hidden when everything synchronized", () => {
    expect(describeSyncStatus(snapshot(), true, false).tone).toBe("hidden");
    expect(describeSyncStatus(null, true, false).tone).toBe("hidden");
  });

  it("shows the restore review above everything else", () => {
    const view = describeSyncStatus(
      snapshot({ reviewRequired: true, pendingActions: 3 }),
      false,
      true,
    );
    expect(view.tone).toBe("review");
    expect(view.label).toBe("Server restored; review pending changes");
  });

  it("counts waiting work, online or not", () => {
    expect(describeSyncStatus(snapshot({ pendingActions: 2 }), true, false)).toMatchObject({
      tone: "pending",
      label: "2 waiting on this device",
    });
    expect(describeSyncStatus(snapshot({ pendingActions: 2 }), false, false)).toMatchObject({
      tone: "offline",
      label: "Offline · 2 waiting on this device",
    });
    expect(describeSyncStatus(snapshot(), false, false)).toMatchObject({
      tone: "offline",
      label: "Offline",
    });
    expect(describeSyncStatus(snapshot(), true, true)).toMatchObject({
      tone: "syncing",
      label: "Syncing",
    });
  });

  it("asks for sign-in when a pass paused on the ended session", () => {
    expect(
      describeSyncStatus(snapshot({ signInRequired: true, pendingActions: 2 }), true, false),
    ).toMatchObject({
      tone: "sign-in",
      label: "Sign in to sync · 2 waiting on this device",
    });
    // Offline stays the visible condition; sign-in returns with the network.
    expect(
      describeSyncStatus(snapshot({ signInRequired: true, pendingActions: 2 }), false, false),
    ).toMatchObject({
      tone: "offline",
    });
  });

  it("counts definitively refused changes below the sign-in request", () => {
    expect(describeSyncStatus(snapshot({ failedActions: [failedItem()] }), true, false)).toMatchObject(
      {
        tone: "failed",
        label: "1 failed to sync",
      },
    );
    expect(
      describeSyncStatus(
        snapshot({ signInRequired: true, failedActions: [failedItem()] }),
        true,
        false,
      ),
    ).toMatchObject({
      tone: "sign-in",
    });
  });
});

describe("review labels", () => {
  it("names every queued kind and review reason in interface terms", () => {
    expect(reviewKindLabel("send")).toBe("Queued send");
    expect(reviewKindLabel("draft-save")).toBe("Draft edits");
    expect(reviewKindLabel("upload")).toBe("File upload");
    expect(reviewKindLabel("flag")).toBe("Flag change");
    expect(reviewKindLabel("move")).toBe("Move to a folder");
    expect(reviewReasonLabel("server_restored")).toBe(
      "Created before the server was restored.",
    );
    expect(reviewReasonLabel("uncertain_send")).toBe(
      "The send result is unknown. It may have arrived.",
    );
    expect(reviewReasonLabel("draft_conflict")).toBe(
      "The draft changed on the server after these edits.",
    );
  });
});

describe("upload preflight", () => {
  it("mirrors the compose service limit", () => {
    expect(UPLOAD_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(uploadFits({ sizeBytes: UPLOAD_MAX_BYTES })).toBe(true);
    expect(uploadFits({ sizeBytes: UPLOAD_MAX_BYTES + 1 })).toBe(false);
  });
});

describe("queued mail action replay", () => {
  const GENERATION = "11111111-1111-4111-8111-111111111111";
  const target: FrozenTarget = {
    accountId: "a1",
    folderId: "f-inbox",
    messageId: "m1",
    occurrenceId: "occ-1",
    revision: 4,
    modseq: "21",
  };

  /** The port over a store that always reports one generation. */
  function port() {
    const store = { serverGeneration: async () => GENERATION } as Partial<OfflineStore>;
    return webOfflinePort(store as OfflineStore);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a frozen flag back to its wire kind and reports it synced", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              action: { actionId: "act-1", kind: "star", status: "complete", idempotencyKey: "idem", items: [] },
            }),
        } as unknown as Response;
      }),
    );

    const outcome = await port().runMailAction!({
      kind: "flag",
      flag: "flagged",
      value: true,
      targets: [target],
      idempotencyKey: "idem",
    });

    expect(outcome).toEqual({ state: "synced" });
    expect(bodies).toEqual([
      { accountId: "a1", kind: "star", idempotencyKey: "idem", occurrenceIds: ["occ-1"] },
    ]);
  });

  it("replays a move with its frozen destination", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
      }),
    );

    const outcome = await port().runMailAction!({
      kind: "move",
      targets: [target],
      destinationFolderId: "f-archive",
      idempotencyKey: "idem-2",
    });

    expect(outcome).toEqual({ state: "synced" });
    expect(bodies).toEqual([
      {
        accountId: "a1",
        kind: "move",
        idempotencyKey: "idem-2",
        occurrenceIds: ["occ-1"],
        destinationFolderId: "f-archive",
      },
    ]);
  });

  it("fails an item whose queue entry lost every target", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const outcome = await port().runMailAction!({
      kind: "flag",
      flag: "unread",
      value: false,
      targets: [],
      idempotencyKey: "idem-3",
    });

    expect(outcome).toEqual({ state: "failed", reason: "The queued action held no targets." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies a replay refusal through the shared rules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 409,
            text: async () =>
              JSON.stringify({ error: { code: "recovery_required", message: "Restored." } }),
          }) as unknown as Response,
      ),
    );

    const outcome = await port().runMailAction!({
      kind: "flag",
      flag: "unread",
      value: false,
      targets: [target],
      idempotencyKey: "idem-4",
    });

    expect(outcome).toEqual({ state: "review", reason: "server_restored" });
  });
});
