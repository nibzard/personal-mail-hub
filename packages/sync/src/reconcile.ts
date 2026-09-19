import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  folders,
  messageOccurrences,
  type Folder,
  type MailHubDatabase,
} from "@mail-hub/database";
import { SyncError } from "./errors.ts";
import type { MailboxSession } from "./mailbox.ts";
import {
  importHeaderRecord,
  lastFolderEventAt,
  loadFolder,
  lockFolder,
  recordFolderEvent,
  requireUuid,
} from "./store.ts";

/**
 * Folder reconciliation (SPEC F2).
 *
 * Two jobs live here. A generation change resets one folder: the occurrences
 * of the old generation are invalidated — a queued action target that names
 * one of them can no longer be refreshed — both checkpoints return to their
 * first-contact state, and the next backfill walks the new generation from
 * its own `UIDNEXT`. Stored messages, bodies, and originals never move.
 *
 * The nightly inventory compares one full folder UID set with the database:
 * active occurrences the server no longer holds are marked expunged, and
 * UIDs inside an already-covered range that no occurrence covers are
 * re-imported, bounded, as repairs.
 */

/** The event that marks one folder inventoried; its newest row sets the due time. */
export const FOLDER_INVENTORY_EVENT = "sync.folder_inventory";

/** The event recorded when one folder generation reset was applied. */
export const FOLDER_GENERATION_RESET_EVENT = "sync.folder_generation_reset";

/** Full inventory cadence (SPEC F2: nightly). */
export const INVENTORY_INTERVAL_MS = 24 * 60 * 60_000;

/** Repairs one inventory imports; the rest wait for the next run. */
export const DEFAULT_REPAIR_LIMIT = 200;

/** What one generation reset did. */
export type ResetOutcome =
  | {
      state: "reset";
      folderId: string;
      /** The generation the checkpoints held before the reset. */
      recorded: number;
      /** The generation the server reported. */
      observed: number;
      /** Occurrences of the old generation that were invalidated. */
      invalidated: number;
    }
  | { state: "already_current"; folderId: string; uidvalidity: number }
  | { state: "uninitialized"; folderId: string };

/** What one inventory did. */
export type InventoryOutcome =
  | {
      state: "inventoried";
      folderId: string;
      uidvalidity: number;
      /** UIDs the server holds in the whole folder. */
      present: number;
      /** Active occurrences of the current generation before the inventory. */
      active: number;
      /** Occurrences newly marked expunged. */
      expunged: number;
      /** Missed UIDs re-imported inside the covered range. */
      repaired: number;
      skipped: number;
      /** Missed UIDs beyond the repair limit, left for the next inventory. */
      pendingRepairs: number;
    }
  | { state: "generation_changed"; folderId: string; recorded: number; observed: number }
  | { state: "uninitialized"; folderId: string };

export interface ReconciliationOptions {
  /** Missed UIDs one inventory imports. */
  repairLimit?: number;
}

export class ReconciliationService {
  private readonly repairLimit: number;

  constructor(
    private readonly db: MailHubDatabase,
    options: ReconciliationOptions = {},
  ) {
    const repairLimit = options.repairLimit ?? DEFAULT_REPAIR_LIMIT;
    if (!Number.isSafeInteger(repairLimit) || repairLimit < 1) {
      throw new SyncError("invalid_request", "The inventory repair limit must be a positive integer.");
    }
    this.repairLimit = repairLimit;
  }

  /**
   * Apply one observed generation change: invalidate the old occurrences,
   * reset both checkpoints, and hand the folder back to backfill. Idempotent:
   * a reset that already happened reports `already_current`.
   */
  async resetFolderGeneration(
    accountId: string,
    folderId: string,
    observed: number,
  ): Promise<ResetOutcome> {
    requireUuid("account id", accountId);
    requireUuid("folder id", folderId);
    return this.db.transaction(async (tx) => {
      const locked = await lockFolder(tx, accountId, folderId);
      if (locked.uidvalidity === null) {
        return { state: "uninitialized" as const, folderId };
      }
      if (locked.uidvalidity === observed) {
        return { state: "already_current" as const, folderId, uidvalidity: observed };
      }

      const invalidated = await tx
        .update(messageOccurrences)
        .set({ invalidatedAt: new Date() })
        .where(
          and(
            eq(messageOccurrences.accountId, accountId),
            eq(messageOccurrences.folderId, folderId),
            eq(messageOccurrences.uidvalidity, locked.uidvalidity),
            isNull(messageOccurrences.invalidatedAt),
          ),
        )
        .returning({ id: messageOccurrences.id });

      // Both checkpoints reset together: the new generation gets its own
      // bound, its own arrival marker, and a fresh backfill (SPEC F2).
      await tx
        .update(folders)
        .set({
          uidvalidity: observed,
          backfillUpperUid: null,
          backfillBeforeUid: null,
          backfillComplete: false,
          arrivalScannedUid: 0,
        })
        .where(eq(folders.id, folderId));

      await recordFolderEvent(tx, accountId, folderId, FOLDER_GENERATION_RESET_EVENT, {
        recorded: locked.uidvalidity,
        observed,
        invalidated: invalidated.length,
      });
      return {
        state: "reset" as const,
        folderId,
        recorded: locked.uidvalidity,
        observed,
        invalidated: invalidated.length,
      };
    });
  }

  /** When one folder was last inventoried, from the audit trail. */
  lastInventoriedAt(folderId: string): Promise<Date | null> {
    return lastFolderEventAt(this.db, folderId, FOLDER_INVENTORY_EVENT);
  }

  /** Whether the nightly interval has elapsed. A never-inventoried folder is due. */
  async inventoryDue(folderId: string, now: Date = new Date()): Promise<boolean> {
    const last = await this.lastInventoriedAt(folderId);
    if (last === null) {
      return true;
    }
    return now.getTime() - last.getTime() >= INVENTORY_INTERVAL_MS;
  }

  /**
   * Run one full inventory of one folder: compare the complete UID set with
   * the occurrences of the current generation, mark expunges, and repair
   * missed imports inside the range the checkpoints already cover.
   */
  async inventoryFolder(
    session: MailboxSession,
    accountId: string,
    folderId: string,
  ): Promise<InventoryOutcome> {
    requireUuid("account id", accountId);
    requireUuid("folder id", folderId);
    const folder = await loadFolder(this.db, accountId, folderId);

    const mailbox = await session.select(folder.name);
    if (folder.uidvalidity !== null && folder.uidvalidity !== mailbox.uidValidity) {
      return {
        state: "generation_changed",
        folderId,
        recorded: folder.uidvalidity,
        observed: mailbox.uidValidity,
      };
    }
    if (folder.uidvalidity === null || folder.backfillBeforeUid === null) {
      return { state: "uninitialized", folderId };
    }
    const generation = folder.uidvalidity;
    const bound = Math.max(0, mailbox.uidNext - 1);
    const present = bound >= 1 ? await session.searchUids(1, bound) : [];
    const presentSet = new Set(present);

    const rows = await this.db
      .select({
        id: messageOccurrences.id,
        uid: messageOccurrences.uid,
        expungedAt: messageOccurrences.expungedAt,
        invalidatedAt: messageOccurrences.invalidatedAt,
      })
      .from(messageOccurrences)
      .where(
        and(
          eq(messageOccurrences.accountId, accountId),
          eq(messageOccurrences.folderId, folderId),
          eq(messageOccurrences.uidvalidity, generation),
        ),
      );
    const active = rows.filter((row) => row.expungedAt === null && row.invalidatedAt === null);
    const absent = active.filter((row) => !presentSet.has(row.uid));

    // Repairs only cover UIDs both scans should have reached: the arrivals
    // zone above the backfill bound, plus the whole folder once backfill
    // completes. Below an incomplete backfill, missing UIDs are unscanned
    // history, not misses.
    const known = new Set(rows.map((row) => row.uid));
    const covered = coveredRange(folder);
    const missed = present
      .filter((uid) => !known.has(uid) && covered.includes(uid))
      .sort((a, b) => b - a);
    const repairs = missed.slice(0, this.repairLimit);
    const records = repairs.length > 0 ? await session.fetchHeaders(repairs) : [];

    // Discard everything when the generation moved before the commit.
    const recheck = await session.revalidate();
    if (recheck.uidValidity !== generation) {
      return { state: "generation_changed", folderId, recorded: generation, observed: recheck.uidValidity };
    }

    const committed = await this.db.transaction(async (tx) => {
      const locked = await lockFolder(tx, accountId, folderId);
      if (locked.uidvalidity !== generation) {
        return null;
      }
      let repaired = 0;
      let skipped = 0;
      for (const record of records) {
        const wasImported = await importHeaderRecord(tx, accountId, folderId, generation, record);
        if (wasImported) {
          repaired += 1;
        } else {
          skipped += 1;
        }
      }
      const expunged = absent.length === 0 ? [] : await tx
        .update(messageOccurrences)
        .set({ expungedAt: new Date() })
        .where(
          and(
            inArray(
              messageOccurrences.id,
              absent.map((row) => row.id),
            ),
            isNull(messageOccurrences.expungedAt),
          ),
        )
        .returning({ id: messageOccurrences.id });
      await recordFolderEvent(tx, accountId, folderId, FOLDER_INVENTORY_EVENT, {
        uidvalidity: generation,
        bound,
        present: present.length,
        active: active.length,
        expunged: expunged.length,
        repaired,
        skipped,
        pendingRepairs: missed.length - repairs.length,
      });
      return { repaired, skipped, expunged: expunged.length };
    });
    if (committed === null) {
      return { state: "generation_changed", folderId, recorded: generation, observed: generation };
    }
    return {
      state: "inventoried",
      folderId,
      uidvalidity: generation,
      present: present.length,
      active: active.length,
      expunged: committed.expunged,
      repaired: committed.repaired,
      skipped: committed.skipped,
      pendingRepairs: missed.length - repairs.length,
    };
  }
}

/**
 * The UID range one folder's checkpoints already promised to cover. Arrivals
 * above the backfill bound are always covered; the historical range below it
 * is covered once backfill completes.
 */
function coveredRange(folder: Folder): { includes: (uid: number) => boolean } {
  const upper = folder.backfillUpperUid ?? 0;
  const arrivalScanned = folder.arrivalScannedUid;
  const complete = folder.backfillComplete;
  return {
    includes(uid: number): boolean {
      if (uid > upper && uid <= arrivalScanned) {
        return true;
      }
      return complete && uid <= Math.max(upper, arrivalScanned);
    },
  };
}
