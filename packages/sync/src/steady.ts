import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
 * Steady-state folder polling (SPEC F2).
 *
 * A poll selects the folder, captures `UIDNEXT - 1` as its arrival bound, and
 * imports arrivals above `arrival_scanned_uid` through that bound in one
 * transaction with the bound itself. It then compares the server's UID set
 * with the active occurrences of the current generation and marks absent ones
 * expunged, and refreshes flags in bounded batches without change-tracking
 * extensions. Every database commit rechecks the folder generation first, so
 * a worker discards its results when the generation moves under it.
 */

/** The event that marks one folder polled; its newest row sets the due time. */
export const FOLDER_POLLED_EVENT = "sync.folder_polled";

/** Inbox poll cadence (SPEC F2 steady state). */
export const INBOX_POLL_INTERVAL_MS = 60_000;

/** Cadence for every folder that is not the Inbox. */
export const OTHER_FOLDER_POLL_INTERVAL_MS = 15 * 60_000;

/** Flags move in bounded batches, like header windows. */
export const DEFAULT_FLAG_BATCH = 200;

/** What one poll did. */
export type PollOutcome =
  | {
      state: "polled";
      folderId: string;
      uidvalidity: number;
      /** `UIDNEXT - 1` captured by this poll. */
      bound: number;
      /** Server UIDs inside the arrival range. */
      found: number;
      imported: number;
      /** UIDs an occurrence already covered; a repeated poll replays safely. */
      skipped: number;
      /** Active occurrences whose flags the server answered. */
      flagsObserved: number;
      /** Occurrences whose observed flags changed; each bumps its revision. */
      flagsChanged: number;
      /** Active occurrences the server no longer holds. */
      expunged: number;
    }
  | { state: "generation_changed"; folderId: string; recorded: number; observed: number }
  | { state: "uninitialized"; folderId: string };

/** One flag observation for one occurrence. */
interface FlagChange {
  occurrenceId: string;
  unread: boolean;
  flagged: boolean;
}

export interface SteadyStateOptions {
  /** Maximum occurrences per flag fetch. */
  flagBatch?: number;
}

export class SteadyStateService {
  private readonly flagBatch: number;

  constructor(
    private readonly db: MailHubDatabase,
    options: SteadyStateOptions = {},
  ) {
    const flagBatch = options.flagBatch ?? DEFAULT_FLAG_BATCH;
    if (!Number.isSafeInteger(flagBatch) || flagBatch < 1) {
      throw new SyncError("invalid_request", "The flag batch size must be a positive integer.");
    }
    this.flagBatch = flagBatch;
  }

  /** The poll interval of one folder: the Inbox polls every minute. */
  pollIntervalMs(folder: Folder): number {
    return folder.role === "inbox" ? INBOX_POLL_INTERVAL_MS : OTHER_FOLDER_POLL_INTERVAL_MS;
  }

  /** When one folder was last polled, from the audit trail. */
  lastPolledAt(folderId: string): Promise<Date | null> {
    return lastFolderEventAt(this.db, folderId, FOLDER_POLLED_EVENT);
  }

  /** Whether one folder's poll interval has elapsed. A never-polled folder is due. */
  async pollDue(folder: Folder, now: Date = new Date()): Promise<boolean> {
    const last = await this.lastPolledAt(folder.id);
    if (last === null) {
      return true;
    }
    return now.getTime() - last.getTime() >= this.pollIntervalMs(folder);
  }

  /**
   * Poll one folder: arrivals, expunges, then flags. A generation change at
   * any point stops the poll with nothing further applied; reconciliation
   * owns the reset.
   */
  async pollFolder(
    session: MailboxSession,
    accountId: string,
    folderId: string,
  ): Promise<PollOutcome> {
    requireUuid("account id", accountId);
    requireUuid("folder id", folderId);
    const folder = await loadFolder(this.db, accountId, folderId);

    // Selection validates the generation before any fetch (SPEC F2).
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
      // First contact belongs to backfill; it initializes the checkpoints.
      return { state: "uninitialized", folderId };
    }
    const generation = folder.uidvalidity;

    const arrivals = await this.importArrivals(
      session,
      accountId,
      folder,
      mailbox.uidNext,
      generation,
    );
    if (arrivals.state === "generation_changed") {
      return arrivals;
    }

    const expunged = await this.markExpunges(session, accountId, folderId, generation);
    if (expunged.state === "generation_changed") {
      return { ...expunged, folderId };
    }

    const flags = await this.refreshFlags(session, accountId, folderId, generation);
    if (flags.state === "generation_changed") {
      return { ...flags, folderId };
    }

    const outcome: PollOutcome = {
      state: "polled",
      folderId,
      uidvalidity: generation,
      bound: arrivals.bound,
      found: arrivals.found,
      imported: arrivals.imported,
      skipped: arrivals.skipped,
      flagsObserved: flags.observed,
      flagsChanged: flags.changed,
      expunged: expunged.count,
    };
    await recordFolderEvent(this.db, accountId, folderId, FOLDER_POLLED_EVENT, {
      uidvalidity: generation,
      bound: outcome.bound,
      found: outcome.found,
      imported: outcome.imported,
      skipped: outcome.skipped,
      flagsObserved: outcome.flagsObserved,
      flagsChanged: outcome.flagsChanged,
      expunged: outcome.expunged,
    });
    return outcome;
  }

  /**
   * Import arrivals above `arrival_scanned_uid` through the captured bound.
   * The rows and the bound commit together, so a restart re-covers at most the
   * range it did not commit (SPEC F2 steady state).
   */
  private async importArrivals(
    session: MailboxSession,
    accountId: string,
    folder: Folder,
    uidNext: number,
    generation: number,
  ): Promise<
    | { state: "ok"; bound: number; found: number; imported: number; skipped: number }
    | { state: "generation_changed"; folderId: string; recorded: number; observed: number }
  > {
    const bound = Math.max(0, uidNext - 1);
    if (bound <= folder.arrivalScannedUid) {
      return { state: "ok", bound, found: 0, imported: 0, skipped: 0 };
    }

    const uids = await session.searchUids(folder.arrivalScannedUid + 1, bound);
    const ordered = [...uids].sort((a, b) => b - a);
    const records = ordered.length > 0 ? await session.fetchHeaders(ordered) : [];

    // Discard the fetch when the generation moved before its commit (SPEC F2).
    const recheck = await session.revalidate();
    if (recheck.uidValidity !== generation) {
      return { state: "generation_changed", folderId: folder.id, recorded: generation, observed: recheck.uidValidity };
    }

    const committed = await this.db.transaction(async (tx) => {
      const locked = await lockFolder(tx, accountId, folder.id);
      if (locked.uidvalidity !== generation) {
        return null;
      }
      let imported = 0;
      let skipped = 0;
      for (const record of records) {
        const wasImported = await importHeaderRecord(tx, accountId, folder.id, generation, record);
        if (wasImported) {
          imported += 1;
        } else {
          skipped += 1;
        }
      }
      // The bound is monotonic: only a higher bound moves the checkpoint.
      const scanned = Math.max(locked.arrivalScannedUid, bound);
      await tx
        .update(folders)
        .set({ arrivalScannedUid: scanned })
        .where(eq(folders.id, folder.id));
      return { imported, skipped, scanned };
    });
    if (committed === null) {
      const recorded = (await loadFolder(this.db, accountId, folder.id)).uidvalidity ?? generation;
      return { state: "generation_changed", folderId: folder.id, recorded, observed: generation };
    }
    return { state: "ok", bound, found: ordered.length, imported: committed.imported, skipped: committed.skipped };
  }

  /**
   * Compare the server's UID set with the active occurrences of this
   * generation and mark absent ones expunged. Originals and message rows stay
   * (SPEC section 8: expunged mail remains readable locally).
   */
  private async markExpunges(
    session: MailboxSession,
    accountId: string,
    folderId: string,
    generation: number,
  ): Promise<{ state: "ok"; count: number } | { state: "generation_changed"; recorded: number; observed: number }> {
    const bound = Math.max(0, (await session.revalidate()).uidNext - 1);
    const present = new Set(bound >= 1 ? await session.searchUids(1, bound) : []);

    const active = await this.db
      .select({ id: messageOccurrences.id, uid: messageOccurrences.uid })
      .from(messageOccurrences)
      .where(
        and(
          eq(messageOccurrences.accountId, accountId),
          eq(messageOccurrences.folderId, folderId),
          eq(messageOccurrences.uidvalidity, generation),
          isNull(messageOccurrences.expungedAt),
          isNull(messageOccurrences.invalidatedAt),
        ),
      );
    const absent = active.filter((row) => !present.has(row.uid));
    if (absent.length === 0) {
      return { state: "ok", count: 0 };
    }

    const recheck = await session.revalidate();
    if (recheck.uidValidity !== generation) {
      return { state: "generation_changed", recorded: generation, observed: recheck.uidValidity };
    }
    const marked = await this.db.transaction(async (tx) => {
      const locked = await lockFolder(tx, accountId, folderId);
      if (locked.uidvalidity !== generation) {
        return null;
      }
      const updated = await tx
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
      return updated.length;
    });
    if (marked === null) {
      return { state: "generation_changed", recorded: generation, observed: generation };
    }
    return { state: "ok", count: marked };
  }

  /**
   * Refresh observed flags in bounded batches. Only a changed observation
   * writes: the revision stays stable while the server state does, so a
   * queued action target does not go stale because a poll looked at it.
   */
  private async refreshFlags(
    session: MailboxSession,
    accountId: string,
    folderId: string,
    generation: number,
  ): Promise<{ state: "ok"; observed: number; changed: number } | { state: "generation_changed"; recorded: number; observed: number }> {
    const occurrences = await this.db
      .select({
        id: messageOccurrences.id,
        uid: messageOccurrences.uid,
        unread: messageOccurrences.unread,
        flagged: messageOccurrences.flagged,
      })
      .from(messageOccurrences)
      .where(
        and(
          eq(messageOccurrences.accountId, accountId),
          eq(messageOccurrences.folderId, folderId),
          eq(messageOccurrences.uidvalidity, generation),
          isNull(messageOccurrences.expungedAt),
          isNull(messageOccurrences.invalidatedAt),
        ),
      )
      .orderBy(messageOccurrences.uid);

    let observed = 0;
    const changes: FlagChange[] = [];
    for (let offset = 0; offset < occurrences.length; offset += this.flagBatch) {
      const batch = occurrences.slice(offset, offset + this.flagBatch);
      const answers = await session.fetchFlags(batch.map((row) => row.uid));
      const byUid = new Map(answers.map((answer) => [answer.uid, answer]));
      for (const occurrence of batch) {
        // A UID the server omitted from the answer no longer exists; expunge
        // detection owns that marking.
        const answer = byUid.get(occurrence.uid);
        if (answer === undefined) {
          continue;
        }
        observed += 1;
        if (answer.unread !== occurrence.unread || answer.flagged !== occurrence.flagged) {
          changes.push({
            occurrenceId: occurrence.id,
            unread: answer.unread,
            flagged: answer.flagged,
          });
        }
      }
    }
    if (changes.length === 0) {
      return { state: "ok", observed, changed: 0 };
    }

    const recheck = await session.revalidate();
    if (recheck.uidValidity !== generation) {
      return { state: "generation_changed", recorded: generation, observed: recheck.uidValidity };
    }
    const applied = await this.db.transaction(async (tx) => {
      const locked = await lockFolder(tx, accountId, folderId);
      if (locked.uidvalidity !== generation) {
        return null;
      }
      for (const change of changes) {
        await tx
          .update(messageOccurrences)
          .set({
            unread: change.unread,
            flagged: change.flagged,
            // Increment in the statement itself, so a revision another writer
            // committed between the read and this lock still counts.
            revision: sql`${messageOccurrences.revision} + 1`,
            observedAt: new Date(),
          })
          .where(eq(messageOccurrences.id, change.occurrenceId));
      }
      return changes.length;
    });
    if (applied === null) {
      return { state: "generation_changed", recorded: generation, observed: generation };
    }
    return { state: "ok", observed, changed: applied };
  }
}
