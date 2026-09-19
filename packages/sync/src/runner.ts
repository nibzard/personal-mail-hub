import { and, eq, isNull, or, sql } from "drizzle-orm";
import { folders, type Folder, type MailHubDatabase } from "@mail-hub/database";
import { SyncError } from "./errors.ts";
import type { BackfillService } from "./backfill.ts";
import type { BodyFetchOutcome, BodyFetchService } from "./bodies.ts";
import type { MailboxSession } from "./mailbox.ts";
import type { ReconciliationService } from "./reconcile.ts";
import type { SteadyStateService } from "./steady.ts";
import { loadFolder, recordAccountEvent } from "./store.ts";

/**
 * One account's bounded synchronization cycle (SPEC F2).
 *
 * Backfill holds one IMAP connection per account and yields between batches,
 * so polls and user actions keep their turn. A cycle runs a bounded number of
 * windows per folder that still needs them, polls the folders whose interval
 * is due, runs a nightly inventory when that interval is due, resolves a
 * bounded number of body jobs, and emits one sync-status event for the
 * account. A folder generation change resets that folder's checkpoints and
 * occurrences, then backfill resumes with the cycle's remaining budget.
 */

/** Windows one cycle fetches per folder before it moves on. */
export const DEFAULT_BATCHES_PER_FOLDER = 10;

/** Body jobs one cycle resolves per account. */
export const DEFAULT_BODIES_PER_CYCLE = 25;

export interface SyncRunnerOptions {
  /** Windows one cycle fetches per folder. */
  batchesPerFolder?: number;
  /** Body jobs one cycle resolves. */
  bodiesPerCycle?: number;
}

/** What one cycle changed. */
export interface AccountCycleSummary {
  accountId: string;
  /** Folders that ran backfill windows. */
  folders: number;
  batches: number;
  imported: number;
  bodiesFetched: number;
  generationChanges: number;
  /** Generation resets applied; each restarts that folder's backfill. */
  resets: number;
  /** Folders polled for arrivals, flags, and expunges. */
  polled: number;
  arrivalsImported: number;
  flagsRefreshed: number;
  expungesMarked: number;
  /** Nightly inventories run. */
  inventories: number;
}

export interface CycleControl {
  /** Abort between batches; an aborted cycle ends without error. */
  signal?: AbortSignal;
}

export class SyncRunner {
  private readonly batchesPerFolder: number;
  private readonly bodiesPerCycle: number;

  constructor(
    private readonly db: MailHubDatabase,
    private readonly backfill: BackfillService,
    private readonly bodies: BodyFetchService,
    private readonly steady: SteadyStateService,
    private readonly reconcile: ReconciliationService,
    options: SyncRunnerOptions = {},
  ) {
    this.batchesPerFolder = positiveInteger(options.batchesPerFolder, DEFAULT_BATCHES_PER_FOLDER, "batches per folder");
    this.bodiesPerCycle = positiveInteger(options.bodiesPerCycle, DEFAULT_BODIES_PER_CYCLE, "bodies per cycle");
  }

  /**
   * Run one bounded cycle for one account through one open session. Each
   * folder runs backfill while it needs windows, one poll when its interval
   * is due, and one inventory when the nightly interval is due. The cycle
   * always ends with one sync-status event for the account.
   */
  async runAccountCycle(
    session: MailboxSession,
    accountId: string,
    control: CycleControl = {},
  ): Promise<AccountCycleSummary> {
    const summary: AccountCycleSummary = {
      accountId,
      folders: 0,
      batches: 0,
      imported: 0,
      bodiesFetched: 0,
      generationChanges: 0,
      resets: 0,
      polled: 0,
      arrivalsImported: 0,
      flagsRefreshed: 0,
      expungesMarked: 0,
      inventories: 0,
    };

    const accountFolders = await this.db
      .select()
      .from(folders)
      .where(eq(folders.accountId, accountId))
      .orderBy(folders.name);

    for (const folder of accountFolders) {
      if (aborted(control)) {
        break;
      }
      await this.synchronizeFolder(session, accountId, folder, control, summary);
      await yieldControl();
    }

    const pending = await this.bodies.pendingBodies(accountId, this.bodiesPerCycle);
    for (const job of pending) {
      if (aborted(control)) {
        break;
      }
      const outcome: BodyFetchOutcome = await this.bodies.fetchBody(session, accountId, job);
      if (outcome.state === "fetched") {
        summary.bodiesFetched += 1;
      }
      await yieldControl();
    }

    await this.recordStatus(accountId, summary);
    return summary;
  }

  /**
   * Drive one folder through backfill, poll, and inventory with a shared
   * window budget. A detected generation change resets the folder, and the
   * remaining budget backfills the new generation right away.
   */
  private async synchronizeFolder(
    session: MailboxSession,
    accountId: string,
    folder: Folder,
    control: CycleControl,
    summary: AccountCycleSummary,
  ): Promise<void> {
    let budget = this.batchesPerFolder;

    // Backfill while the folder needs windows.
    if (needsBackfill(folder)) {
      summary.folders += 1;
    }
    let current = folder;
    while (needsBackfill(current) && budget > 0 && !aborted(control)) {
      const outcome = await this.backfill.runBatch(session, accountId, current.id);
      summary.batches += 1;
      budget -= 1;
      if (outcome.state === "generation_changed") {
        await this.applyReset(accountId, current.id, outcome.observed, summary);
        current = await loadFolder(this.db, accountId, current.id);
        continue;
      }
      if (outcome.state === "imported") {
        summary.imported += outcome.imported;
      }
      // Covers a completed folder and a folder initialized empty.
      if ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete) {
        break;
      }
      // Yield between batches so polls and user actions can run.
      await yieldControl();
    }

    // Poll an initialized folder whose interval is due, even mid-backfill:
    // arrival progress is independent of the historical scan (SPEC F2).
    current = await loadFolder(this.db, accountId, current.id);
    if (!aborted(control) && current.uidvalidity !== null && (await this.steady.pollDue(current))) {
      summary.polled += 1;
      const poll = await this.steady.pollFolder(session, accountId, current.id);
      if (poll.state === "polled") {
        summary.arrivalsImported += poll.imported;
        summary.flagsRefreshed += poll.flagsChanged;
        summary.expungesMarked += poll.expunged;
      }
      if (poll.state === "generation_changed") {
        await this.applyReset(accountId, current.id, poll.observed, summary);
        current = await this.runResetBackfill(session, accountId, current.id, budget, control, summary);
      }
    }

    // The nightly inventory runs once the folder's history is imported.
    if (
      !aborted(control) &&
      current.backfillComplete &&
      (await this.reconcile.inventoryDue(current.id))
    ) {
      summary.inventories += 1;
      const inventory = await this.reconcile.inventoryFolder(session, accountId, current.id);
      if (inventory.state === "inventoried") {
        summary.expungesMarked += inventory.expunged;
      }
      if (inventory.state === "generation_changed") {
        await this.applyReset(accountId, current.id, inventory.observed, summary);
        await this.runResetBackfill(session, accountId, current.id, budget, control, summary);
      }
    }
  }

  /** Backfill a just-reset folder with the budget the cycle has left. */
  private async runResetBackfill(
    session: MailboxSession,
    accountId: string,
    folderId: string,
    budget: number,
    control: CycleControl,
    summary: AccountCycleSummary,
  ): Promise<Folder> {
    let current = await loadFolder(this.db, accountId, folderId);
    while (needsBackfill(current) && budget > 0 && !aborted(control)) {
      const outcome = await this.backfill.runBatch(session, accountId, folderId);
      summary.batches += 1;
      budget -= 1;
      if (outcome.state === "generation_changed") {
        await this.applyReset(accountId, folderId, outcome.observed, summary);
        current = await loadFolder(this.db, accountId, folderId);
        continue;
      }
      if (outcome.state === "imported") {
        summary.imported += outcome.imported;
      }
      if ((outcome.state === "initialized" || outcome.state === "imported") && outcome.complete) {
        break;
      }
      await yieldControl();
    }
    return loadFolder(this.db, accountId, folderId);
  }

  /** Count and apply one folder generation reset (SPEC F2 reconciliation). */
  private async applyReset(
    accountId: string,
    folderId: string,
    observed: number,
    summary: AccountCycleSummary,
  ): Promise<void> {
    summary.generationChanges += 1;
    const reset = await this.reconcile.resetFolderGeneration(accountId, folderId, observed);
    if (reset.state === "reset") {
      summary.resets += 1;
    }
  }

  /**
   * One sync-status event per account per cycle. Pending body counts are
   * recorded separately from header sync progress (SPEC F2).
   */
  private async recordStatus(accountId: string, summary: AccountCycleSummary): Promise<void> {
    const pending = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(folders)
      .where(
        and(
          eq(folders.accountId, accountId),
          or(isNull(folders.uidvalidity), eq(folders.backfillComplete, false)),
        ),
      );
    await recordAccountEvent(this.db, accountId, "sync.status", {
      folders: summary.folders,
      batches: summary.batches,
      imported: summary.imported,
      bodiesFetched: summary.bodiesFetched,
      generationChanges: summary.generationChanges,
      resets: summary.resets,
      polled: summary.polled,
      arrivalsImported: summary.arrivalsImported,
      flagsRefreshed: summary.flagsRefreshed,
      expungesMarked: summary.expungesMarked,
      inventories: summary.inventories,
      // Header sync progress: how many folders still owe historical windows.
      backfillPendingFolders: pending[0]?.count ?? 0,
      // Body sync progress, independent of headers.
      pendingBodies: await this.bodies.pendingBodyCount(accountId),
    });
  }
}

/** Whether one folder still owes backfill windows. */
function needsBackfill(folder: Folder): boolean {
  return folder.uidvalidity === null || !folder.backfillComplete;
}

function aborted(control: CycleControl): boolean {
  return control.signal?.aborted === true;
}

/** One turn of the event loop between remote batches. */
function yieldControl(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function positiveInteger(value: number | undefined, fallback: number, kind: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SyncError("invalid_request", `${kind} must be a positive integer.`);
  }
  return value;
}
