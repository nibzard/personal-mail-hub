import { eq } from "drizzle-orm";
import { folders, type Folder, type MailHubDatabase } from "@mail-hub/database";
import type { MailHubTransaction } from "@mail-hub/recovery";
import { SyncError } from "./errors.ts";
import type { MailboxSession, MailboxState } from "./mailbox.ts";
import {
  importHeaderRecord,
  loadFolder,
  lockFolder,
  recordFolderEvent,
  requireUuid,
} from "./store.ts";

/**
 * Resumable IMAP backfill (SPEC F2).
 *
 * Header import walks bounded UID windows below `backfill_before_uid`,
 * newest first, and commits the imported rows, the durable body work, and the
 * next exclusive boundary in one transaction. A restart repeats only the
 * uncommitted window: the boundary is the checkpoint. `UIDVALIDITY` is
 * checked on every selection and again before every commit, so a UID from
 * another folder generation never lands in the database.
 *
 * Empty ranges advance only after a successful fetch, and the body work of a
 * window is the imported rows themselves: a message row with
 * `fetched_body = false` is the durable body job, committed with the boundary
 * that covers it (SPEC F2 steps 4 and 6).
 */

/** Default width of one UID window, newest first. */
export const DEFAULT_BACKFILL_WINDOW = 200;

/** Smallest useful window; one UID at a time is still a valid batch. */
const MIN_BACKFILL_WINDOW = 1;

/** A folder with initialized checkpoints. */
interface InitializedFolder {
  id: string;
  name: string;
  uidvalidity: number;
  backfillUpperUid: number;
  backfillBeforeUid: number;
  backfillComplete: boolean;
}

/** What one `runBatch` call did. */
export type BackfillBatchOutcome =
  | {
      /** First contact: checkpoints were initialized this call (SPEC step 2). */
      state: "initialized";
      folderId: string;
      uidvalidity: number;
      upperUid: number;
      beforeUid: number;
      complete: boolean;
    }
  | {
      /** One window was fetched and committed with its boundary. */
      state: "imported";
      folderId: string;
      uidvalidity: number;
      range: { low: number; high: number };
      /** UIDs the server reported inside the range. */
      found: number;
      imported: number;
      /** UIDs an occurrence already covered; a repeated window replays safely. */
      skipped: number;
      beforeUid: number;
      complete: boolean;
    }
  | { state: "complete"; folderId: string }
  | {
      /** The folder generation changed; nothing from this call was applied. */
      state: "generation_changed";
      folderId: string;
      recorded: number;
      observed: number;
    };

export interface BackfillOptions {
  /** Maximum UIDs one window covers. */
  windowSize?: number;
}

export class BackfillService {
  private readonly windowSize: number;

  constructor(
    private readonly db: MailHubDatabase,
    options: BackfillOptions = {},
  ) {
    const windowSize = options.windowSize ?? DEFAULT_BACKFILL_WINDOW;
    if (!Number.isSafeInteger(windowSize) || windowSize < MIN_BACKFILL_WINDOW) {
      throw new SyncError("invalid_request", `The backfill window size must be an integer of at least ${MIN_BACKFILL_WINDOW}.`);
    }
    this.windowSize = windowSize;
  }

  /**
   * Run one bounded batch for one folder: initialize the checkpoints on first
   * contact, or fetch and commit the next window below `backfill_before_uid`.
   * Callers loop until the outcome is `complete`.
   */
  async runBatch(
    session: MailboxSession,
    accountId: string,
    folderId: string,
  ): Promise<BackfillBatchOutcome> {
    requireUuid("account id", accountId);
    requireUuid("folder id", folderId);
    const folder = await loadFolder(this.db, accountId, folderId);

    // Selection validates the folder generation before any fetch (SPEC F2
    // reconciliation): a UID from another generation is never applied.
    const mailbox = await session.select(folder.name);
    if (folder.uidvalidity !== null && folder.uidvalidity !== mailbox.uidValidity) {
      return await generationChanged(this.db, accountId, folderId, folder.uidvalidity, mailbox.uidValidity);
    }

    if (folder.backfillComplete) {
      return { state: "complete", folderId };
    }

    let effective: InitializedFolder;
    if (folder.uidvalidity === null || folder.backfillBeforeUid === null) {
      const initialization = await this.db.transaction((tx) =>
        initializeCheckpoints(tx, folder, mailbox),
      );
      if (initialization.result === "generation_changed") {
        return await generationChanged(
          this.db,
          accountId,
          folderId,
          initialization.recorded,
          initialization.observed,
        );
      }
      effective = initialization.folder;
      if (initialization.fresh) {
        return {
          state: "initialized",
          folderId,
          uidvalidity: effective.uidvalidity,
          upperUid: effective.backfillUpperUid,
          beforeUid: effective.backfillBeforeUid,
          complete: effective.backfillComplete,
        };
      }
      // Another worker initialized between the read and the lock; its values
      // stand, and they were checked against this selection inside the lock.
    } else {
      effective = toInitialized(folder);
    }

    if (effective.backfillComplete) {
      return { state: "complete", folderId };
    }

    const high = effective.backfillBeforeUid - 1;
    if (high < 1) {
      // Every range down to UID 1 is scanned; close the folder out.
      await this.db.transaction(async (tx) => {
        const locked = await lockFolder(tx, accountId, folderId);
        if (locked.uidvalidity === mailbox.uidValidity && !locked.backfillComplete) {
          await tx.update(folders).set({ backfillComplete: true }).where(eq(folders.id, folderId));
          await recordFolderEvent(tx, accountId, folderId, "sync.backfill_complete", {
            upperUid: locked.backfillUpperUid,
          });
        }
      });
      return { state: "complete", folderId };
    }
    const low = Math.max(1, high - this.windowSize + 1);

    // Gaps are normal: SEARCH reports the UIDs that exist inside the window.
    const uids = await session.searchUids(low, high);
    const ordered = [...uids].sort((a, b) => b - a);
    const records = ordered.length > 0 ? await session.fetchHeaders(ordered) : [];

    // The generation is checked again after the fetch and before the commit,
    // so results from a changed generation are discarded (SPEC F2).
    const recheck = await session.revalidate();
    if (recheck.uidValidity !== mailbox.uidValidity) {
      return await generationChanged(this.db, accountId, folderId, mailbox.uidValidity, recheck.uidValidity);
    }

    return this.db.transaction(async (tx) => {
      const locked = await lockFolder(tx, accountId, folderId);
      if (locked.uidvalidity !== mailbox.uidValidity) {
        const recorded = locked.uidvalidity ?? mailbox.uidValidity;
        return await generationChanged(tx, accountId, folderId, recorded, mailbox.uidValidity);
      }

      let imported = 0;
      let skipped = 0;
      for (const record of records) {
        const wasImported = await importHeaderRecord(
          tx,
          accountId,
          folderId,
          mailbox.uidValidity,
          record,
        );
        if (wasImported) {
          imported += 1;
        } else {
          skipped += 1;
        }
      }

      // The boundary moves below the scanned window, monotonically, in the
      // same transaction as the rows (SPEC step 4).
      const beforeUid = Math.min(locked.backfillBeforeUid ?? low, low);
      const complete = beforeUid <= 1 || locked.backfillComplete;
      await tx
        .update(folders)
        .set({ backfillBeforeUid: beforeUid, backfillComplete: complete })
        .where(eq(folders.id, folderId));

      await recordFolderEvent(
        tx,
        accountId,
        folderId,
        complete ? "sync.backfill_complete" : "sync.backfill_batch",
        {
          range: { low, high },
          found: ordered.length,
          imported,
          skipped,
          beforeUid,
          upperUid: locked.backfillUpperUid,
        },
      );

      return {
        state: "imported" as const,
        folderId,
        uidvalidity: mailbox.uidValidity,
        range: { low, high },
        found: ordered.length,
        imported,
        skipped,
        beforeUid,
        complete,
      };
    });
  }
}

/**
 * Initialize or take over the checkpoints of one folder inside a lock
 * (SPEC steps 1 and 2). The first writer captures `UIDNEXT - 1` as the upper
 * bound and initializes both checkpoints; a concurrent writer keeps those
 * committed values.
 */
async function initializeCheckpoints(
  tx: MailHubTransaction,
  folder: Folder,
  mailbox: MailboxState,
): Promise<
  | { result: "generation_changed"; recorded: number; observed: number }
  | { result: "initialized"; fresh: boolean; folder: InitializedFolder }
> {
  const locked = await lockFolder(tx, folder.accountId, folder.id);
  if (locked.uidvalidity !== null && locked.uidvalidity !== mailbox.uidValidity) {
    return { result: "generation_changed", recorded: locked.uidvalidity, observed: mailbox.uidValidity };
  }
  if (locked.uidvalidity !== null && locked.backfillBeforeUid !== null) {
    return { result: "initialized", fresh: false, folder: toInitialized(locked) };
  }

  const upperUid = Math.max(0, mailbox.uidNext - 1);
  const updated = await tx
    .update(folders)
    .set({
      uidvalidity: mailbox.uidValidity,
      backfillUpperUid: upperUid,
      // Exclusive bound above the newest UID; windows run below it.
      backfillBeforeUid: upperUid + 1,
      // Arrivals above the bound belong to steady state (SPEC step 2).
      arrivalScannedUid: upperUid,
      // A folder with no UIDs has no range below UID 1 to scan.
      backfillComplete: upperUid === 0,
    })
    .where(eq(folders.id, folder.id))
    .returning();
  await recordFolderEvent(tx, folder.accountId, folder.id, "sync.backfill_initialized", {
    uidvalidity: mailbox.uidValidity,
    upperUid,
  });
  return { result: "initialized", fresh: true, folder: toInitialized(updated[0]!) };
}

/** Narrow one folder row to its initialized checkpoint fields. */
function toInitialized(folder: Folder): InitializedFolder {
  if (folder.uidvalidity === null || folder.backfillBeforeUid === null || folder.backfillUpperUid === null) {
    throw new SyncError(
      "invalid_request",
      `Folder ${folder.id} has incomplete backfill checkpoints; initialization writes them together.`,
    );
  }
  return {
    id: folder.id,
    name: folder.name,
    uidvalidity: folder.uidvalidity,
    backfillUpperUid: folder.backfillUpperUid,
    backfillBeforeUid: folder.backfillBeforeUid,
    backfillComplete: folder.backfillComplete,
  };
}

/** Record one observed generation change, then report it. Nothing else is applied. */
async function generationChanged(
  handle: MailHubDatabase | MailHubTransaction,
  accountId: string,
  folderId: string,
  recorded: number,
  observed: number,
): Promise<BackfillBatchOutcome> {
  await recordFolderEvent(handle, accountId, folderId, "sync.folder_generation_changed", {
    recorded,
    observed,
  });
  return { state: "generation_changed", folderId, recorded, observed };
}
