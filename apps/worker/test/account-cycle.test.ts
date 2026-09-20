import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountService } from "@mail-hub/accounts";
import type { ActionService } from "@mail-hub/actions";
import { StorageError, type MailHubDatabase } from "@mail-hub/database";
import { SyncError, type ImapMailboxSessionFactory, type SyncRunner } from "@mail-hub/sync";

/*
 * One contained account failure. The cycle resolves so the accounts that
 * follow still run, but it stays visible: the log carries the cause and one
 * `sync.failed` event lands in the audit trail. A full volume is the one
 * contained failure that propagates, so the cycle handler can pause on it.
 */

process.env.DATABASE_URL ??= "postgresql://worker-tests.invalid/db";
const { runAccountCycle } = await import("../src/main.ts");

const ACCOUNT_ID = "65863e64-b935-4dbe-b02a-000000000001";

/** Records every event row this cycle attempts to insert. */
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

/** The stored credentials one cycle resolves before it opens a session. */
const CREDENTIALS = {
  imap: { host: "imap.example.test", port: 993 },
  smtp: { host: "smtp.example.test", port: 465, security: "implicit_tls" },
  username: "user@example.test",
  password: "sealed-by-the-cipher",
};

/**
 * One cycle's collaborators as doubles. `open` controls the failure the
 * cycle must contain; the happy path runs through a logging-out session.
 */
function doubles(open: (options: unknown, writes: unknown) => Promise<object>) {
  const logout = vi.fn(async () => undefined);
  const summary = {
    folders: 2,
    batches: 1,
    imported: 0,
    bodiesFetched: 0,
    generationChanges: 0,
  };
  const accounts = {
    resolveCredentials: async () => CREDENTIALS,
  } as unknown as AccountService;
  const sessions = { open } as unknown as ImapMailboxSessionFactory;
  const runner = {
    runAccountCycle: async () => summary,
  } as unknown as SyncRunner;
  const actions = {
    reconcileIncomplete: async () => ({ executed: 0, held: 0, generationMismatch: 0 }),
  } as unknown as ActionService;
  return { logout, accounts, sessions, runner, actions, summary };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAccountCycle", () => {
  it("resolves on an unexpected failure and records one sync.failed event", async () => {
    const { db, inserts } = databaseDouble();
    const { accounts, sessions, runner, actions, logout } = doubles(async () => {
      throw new TypeError("fetch failed");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runAccountCycle(db, accounts, runner, actions, sessions, ACCOUNT_ID, new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(inserts).toEqual([
      {
        actor: "system",
        type: "sync.failed",
        entityType: "account",
        entityId: ACCOUNT_ID,
        payload: { accountId: ACCOUNT_ID, kind: "unexpected_failure" },
      },
    ]);
    const lines = logged.mock.calls.map((call) => String(call[0]));
    // The message line names the cause; the stack follows for a failure no
    // SyncError classified.
    expect(lines[0]).toContain(`Sync cycle for account ${ACCOUNT_ID} failed: TypeError: fetch failed`);
    expect(lines.some((line) => line.startsWith("TypeError: fetch failed\n"))).toBe(true);
    expect(logout).not.toHaveBeenCalled();
  });

  it("records the sync error code and keeps classified failures to one log line", async () => {
    const { db, inserts } = databaseDouble();
    const { accounts, sessions, runner, actions } = doubles(async () => {
      throw new SyncError("mailbox_error", "The SELECT command failed.");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runAccountCycle(db, accounts, runner, actions, sessions, ACCOUNT_ID, new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.type).toBe("sync.failed");
    expect(inserts[0]?.payload).toEqual({ accountId: ACCOUNT_ID, kind: "mailbox_error" });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("SyncError: The SELECT command failed.");
  });

  it("propagates a full-volume pause without logging or recording an event", async () => {
    const { db, inserts } = databaseDouble();
    const { accounts, sessions, runner, actions } = doubles(async () => {
      throw new StorageError("insufficient_space", "The durable volume is full.");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runAccountCycle(db, accounts, runner, actions, sessions, ACCOUNT_ID, new AbortController().signal),
    ).rejects.toBeInstanceOf(StorageError);

    expect(inserts).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("runs the cycle through and logs the session out on success", async () => {
    const { db, inserts } = databaseDouble();
    const { logout, accounts, sessions, runner, actions } = doubles(
      async () => ({ logout }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runAccountCycle(db, accounts, runner, actions, sessions, ACCOUNT_ID, new AbortController().signal),
    ).resolves.toBeUndefined();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(inserts).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });
});
