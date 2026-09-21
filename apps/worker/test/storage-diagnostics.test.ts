import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageError,
  collectUnreferencedDurableObjects,
  sweepTempFiles,
  type MailHubDatabase,
} from "@mail-hub/database";

/*
 * The storage passes that report failures by approved kind
 * (docs/sync-repair-plan.md T104): the full-volume sync pause, the temp-file
 * sweep, and durable-object collection. Error text can repeat paths and
 * query parameters, so every diagnostic names a code only (SPEC section 9).
 */

process.env.DATABASE_URL ??= "postgresql://worker-tests.invalid/db";

vi.mock("@mail-hub/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mail-hub/database")>();
  return {
    ...actual,
    sweepTempFiles: vi.fn(),
    collectUnreferencedDurableObjects: vi.fn(),
  };
});

const { recordStoragePause, sweepStorageTempTree, collectDurableObjectsOnce } = await import(
  "../src/main.ts"
);

/** A value no diagnostic may ever emit. */
const SENTINEL = "SENTINEL-private-7f3a1";

/** A drizzle-style query wrapper around a UTF8 database fault. */
function wrappedFault(): Error {
  return Object.assign(new Error(`Failed query: insert into bodies … ${SENTINEL}`), {
    cause: Object.assign(new Error(`invalid byte sequence for encoding "UTF8": 0x00 — ${SENTINEL}`), {
      code: "22021",
    }),
  });
}

/** Records every event row a pause attempts to insert. */
function databaseDouble() {
  const inserts: Array<Record<string, unknown>> = [];
  const handle = {
    insert() {
      return {
        values(row: Record<string, unknown>) {
          inserts.push(row);
          return { catch: () => Promise.resolve() };
        },
      };
    },
  };
  return { db: handle as unknown as MailHubDatabase, inserts };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("recordStoragePause", () => {
  it("records a full-volume pause with fixed text and a coded event", async () => {
    const { db, inserts } = databaseDouble();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const paused = await recordStoragePause(
      db,
      new StorageError("insufficient_space", `only ${SENTINEL} bytes free on the volume`),
    );

    expect(paused).toBe(true);
    expect(warned.mock.calls).toEqual([
      ["Sync cycle paused: the durable volume is below the free-space threshold."],
    ]);
    expect(inserts).toEqual([
      {
        actor: "system",
        type: "storage.paused",
        payload: { kind: "sync_cycle", code: "insufficient_space" },
      },
    ]);
    expect(JSON.stringify({ warned: warned.mock.calls, inserts })).not.toContain(SENTINEL);
  });

  it("answers false for causes that are not a full-volume pause", async () => {
    const { db, inserts } = databaseDouble();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await recordStoragePause(db, new Error(SENTINEL))).toBe(false);
    expect(await recordStoragePause(db, new StorageError("io_failed", SENTINEL))).toBe(false);

    expect(warned).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });
});

describe("sweepStorageTempTree", () => {
  it("logs the approved kind only when the sweep fails", async () => {
    vi.mocked(sweepTempFiles).mockRejectedValueOnce(wrappedFault());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sweepStorageTempTree("data/storage")).resolves.toBeUndefined();

    expect(errors.mock.calls).toEqual([["Storage temp sweep failed: database_22021"]]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SENTINEL);
  });

  it("reports cleared debris by count", async () => {
    vi.mocked(sweepTempFiles).mockResolvedValueOnce(2);
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await sweepStorageTempTree("data/storage");

    expect(logged.mock.calls).toEqual([
      ["Cleared 2 temp file(s) that a crashed write left behind."],
    ]);
  });
});

describe("collectDurableObjectsOnce", () => {
  it("logs the approved kind only when the collection fails", async () => {
    vi.mocked(collectUnreferencedDurableObjects).mockRejectedValueOnce(wrappedFault());
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      collectDurableObjectsOnce("data/storage", {} as MailHubDatabase),
    ).resolves.toBeUndefined();

    expect(errors.mock.calls).toEqual([["Durable collection failed: database_22021"]]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(SENTINEL);
  });

  it("skips quietly while the backup holds the collection pause", async () => {
    vi.mocked(collectUnreferencedDurableObjects).mockResolvedValueOnce({
      considered: 0,
      removed: 0,
      bytesFreed: 0,
      retainedByGrace: 0,
      paused: true,
    });
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await collectDurableObjectsOnce("data/storage", {} as MailHubDatabase);

    expect(logged.mock.calls).toEqual([
      ["Durable collection skipped: the backup holds the collection pause."],
    ]);
    expect(errors).not.toHaveBeenCalled();
  });
});
