import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  accounts,
  actionItems,
  actions,
  events,
  folders,
  messageOccurrences,
  type ActionItemStatus,
  type ActionItemTarget,
  type MailHubDatabase,
} from "@mail-hub/database";
import { assessJob, type ControlStatus, type MailHubTransaction, type MutationGate } from "@mail-hub/recovery";

import { ActionError } from "./errors.ts";
import type { ActionExecutor, DesiredActionState, ExecutorOutcome, PreparedActionItem } from "./executor.ts";
import {
  canonicalScope,
  flagDesireOf,
  frozenTarget,
  hashScope,
  isReplayableKind,
  requiresDestination,
  validateSubmission,
  type ActionKind,
  type ActionScope,
  type MailActionSubmission,
} from "./kinds.ts";
import type { ActionMailbox, ActionMailboxFlags } from "./mailbox.ts";

/**
 * The recovery-aware mail action service (SPEC section 7).
 *
 * One internal module owns every mail mutation. Each action commits its
 * immutable record and per-target work items before any remote execution, so
 * the gap between a database transaction and an IMAP side effect is bridged by
 * receipts and reconciliation instead of being ignored:
 *
 * 1. The recovery generation is checked before the idempotency lookup, then
 *    the account, request, key, and scope are validated.
 * 2. The action record and its items commit first. A repeated key returns the
 *    existing receipts; a changed payload under the same key conflicts.
 * 3. Target state is refreshed from IMAP before execution. Stale targets,
 *    moved generations, and missing occurrences return conflicts; a target
 *    that already holds the desired flag value confirms as a no-op (SPEC F2).
 * 4. The recovery generation is rechecked before every remote mutation, and
 *    each item shows `executing` before its executor call, so a partial bulk
 *    failure never replays a finished item. The receipt of that claim replaces
 *    the interrupted hold a concurrent run may have recorded, so the live
 *    worker's answer wins.
 * 5. Observed state, per-item receipts, and events commit together.
 * 6. Restart reconciliation replays a flag assignment only after refreshing
 *    its target. An interrupted move or a restored action is never replayed
 *    blindly; it stays held as `unknown` or conflicted.
 */

/** Event recorded when an action and its work items commit (SPEC section 11). */
export const ACTION_QUEUED_EVENT = "action.queued";

/** Event recorded for every item whose mutation the mailbox confirmed. */
export const ACTION_APPLIED_EVENT = "action.applied";

/** Event recorded when the last item of an action holds a disposition. */
export const ACTION_COMPLETED_EVENT = "action.completed";

/** Event recorded for each restored action held during recovery (SPEC section 10, step 5). */
export const ACTION_RESTORED_HELD_EVENT = "action.restored_held";

/** The statuses an action itself moves through. Items hold the fine detail. */
export type ActionStatus = "queued" | "executing" | "complete";

export const PENDING_ACTION_STATUSES: readonly ActionStatus[] = ["queued", "executing"];

export const PENDING_ITEM_STATUSES: readonly ActionItemStatus[] = ["queued", "executing"];

/** Actions restarted per reconciliation pass, bounded like every batch. */
export const DEFAULT_RECONCILIATION_LIMIT = 25;

/** Control-state access the action service needs. `RecoveryControls` satisfies this. */
export interface ActionControlState extends MutationGate {
  readStatus(): Promise<ControlStatus>;
}

/** One per-target receipt of an action. */
export interface ActionItemReceipt {
  itemKey: string;
  status: ActionItemStatus;
  outcome: Record<string, unknown> | null;
}

/** The durable answer of one action: its state and every target receipt. */
export interface ActionReceipt {
  actionId: string;
  kind: ActionKind;
  status: ActionStatus;
  idempotencyKey: string;
  items: ActionItemReceipt[];
}

/** What `submit` returns: the receipts, and whether this call created them. */
export interface SubmitResult {
  created: boolean;
  receipt: ActionReceipt;
}

export type ActionExecutionResult =
  | { state: "executed"; receipt: ActionReceipt }
  | { state: "held"; reason: "recovery_blocked"; receipt: ActionReceipt }
  | { state: "generation_mismatch"; currentGeneration: string | null; receipt: ActionReceipt };

/** What one restart reconciliation pass over an account did. */
export interface RestartReconciliationSummary {
  scanned: number;
  executed: number;
  held: number;
  generationMismatch: number;
}

/** What dispositioning restored actions did (SPEC section 10, step 5). */
export interface RestoredDispositionSummary {
  actions: number;
  /** Items that never started; a restored scope cannot run (conflicted). */
  conflicted: number;
  /** Items whose remote outcome the backup lost (unknown). */
  unknown: number;
}

type ActionRow = typeof actions.$inferSelect;
type ItemRow = typeof actionItems.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The action service. One instance wraps one database, one control-state
 * source, and one executor for the remote writes.
 */
export class ActionService<M extends ActionMailbox = ActionMailbox> {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly controls: ActionControlState,
    private readonly executor: ActionExecutor<M>,
  ) {}

  /**
   * Queue one mail mutation. The recovery gate runs before the idempotency
   * lookup (SPEC section 7, step 1), then the immutable record, its frozen
   * items, and one event commit together before any remote work (step 2).
   */
  async submit(submission: MailActionSubmission): Promise<SubmitResult> {
    const { generation } = await this.controls.gateMutation(submission.recoveryGeneration);
    validateSubmission(submission);

    const scope = canonicalScope(submission);
    const requestHash = hashScope(scope);
    const existing = await this.findByIdempotencyKey(submission.idempotencyKey);
    if (existing !== null) {
      return { created: false, receipt: await this.existingReceipt(existing, requestHash) };
    }

    const targets = await this.freezeTargets(scope);

    let actionId: string;
    try {
      actionId = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(actions)
          .values({
            accountId: scope.accountId,
            recoveryGeneration: generation,
            idempotencyKey: submission.idempotencyKey,
            requestHash,
            kind: scope.kind,
            request: { ...scope },
            status: "queued",
          })
          .returning({ id: actions.id });
        const action = inserted[0]!;
        await tx.insert(actionItems).values(
          targets.map((target) => ({
            actionId: action.id,
            itemKey: target.occurrenceId,
            target,
            status: "queued" as const,
          })),
        );
        await tx.insert(events).values({
          actor: "user",
          type: ACTION_QUEUED_EVENT,
          entityType: "action",
          entityId: action.id,
          payload: {
            accountId: scope.accountId,
            kind: scope.kind,
            targets: targets.length,
            destinationFolderId: scope.destinationFolderId,
          },
        });
        return action.id;
      });
    } catch (cause) {
      // A concurrent submit with the same key inserted first. Fall back to the
      // shared idempotency rules instead of surfacing the race.
      if (isUniqueViolation(cause)) {
        const raced = await this.findByIdempotencyKey(submission.idempotencyKey);
        if (raced !== null) {
          return { created: false, receipt: await this.existingReceipt(raced, requestHash) };
        }
      }
      throw cause;
    }
    return { created: true, receipt: await this.receipt(actionId) };
  }

  /** The durable receipts of one action, by idempotent lookup or after execution. */
  async receipt(actionId: string): Promise<ActionReceipt> {
    const action = await this.loadAction(actionId);
    return this.receiptOf(action);
  }

  /**
   * Drive one action through the procedure (SPEC section 7, steps 3 to 6).
   * Every database commit stays clear of remote calls; each item commits its
   * own receipt, so a later failure never replays an earlier success. An
   * already complete action returns its receipts unchanged.
   */
  async execute(actionId: string, mailbox: M): Promise<ActionExecutionResult> {
    const action = await this.loadAction(actionId);
    if (action.status === "complete") {
      return { state: "executed", receipt: await this.receiptOf(action) };
    }

    // Recovery recheck before execution (SPEC section 7, step 4).
    let stop = await this.assessmentOf(action);
    if (stop !== null) {
      return this.blockedResult(action.id, stop);
    }

    // An interrupted item of a non-replayable kind never replays: hold it
    // unknown until reconciliation proves the outcome (SPEC F4). The hold is
    // a guess about an in-flight claim, so the receipt of the claim that
    // actually ran the remote write replaces it afterwards.
    for (const item of await this.loadItems(action.id)) {
      if (item.status === "executing" && !isReplayableKind(action.kind)) {
        await this.commitDisposition(action, item, {
          status: "unknown",
          outcome: { reason: "interrupted" },
        });
      }
    }

    // A move needs its destination resolved before the writes; the immutable
    // request froze the identifier, and the name is read now.
    let destination: { id: string; name: string } | null = null;
    const scope = scopeOf(action);
    if (requiresDestination(action.kind as ActionKind)) {
      const row = await this.loadFolder(action.accountId, scope.destinationFolderId ?? "");
      if (row === null) {
        await this.conflictAll(action, "destination_removed");
      } else {
        destination = { id: row.id, name: row.name };
      }
    }

    if (destination !== null || !requiresDestination(action.kind as ActionKind)) {
      const pending = (await this.loadItems(action.id)).filter((item) =>
        PENDING_ITEM_STATUSES.includes(item.status),
      );
      const folderIds = [...new Set(pending.map((item) => item.target.folderId))];
      for (const folderId of folderIds) {
        const group = pending.filter((item) => item.target.folderId === folderId);
        stop = await this.executeFolderGroup(action, group, destination, mailbox);
        if (stop !== null) {
          return this.blockedResult(action.id, stop);
        }
      }
    }

    await this.refreshActionStatus(action.id);
    return { state: "executed", receipt: await this.receipt(action.id) };
  }

  /**
   * Restart reconciliation for one account (SPEC section 7, step 6). Finds
   * bounded pending actions in creation order and re-drives them through
   * `execute`, which refreshes every target before any replay. Actions of
   * another generation are left for the restore disposition.
   */
  async reconcileIncomplete(
    accountId: string,
    mailbox: M,
    options: { limit?: number } = {},
  ): Promise<RestartReconciliationSummary> {
    const limit = options.limit ?? DEFAULT_RECONCILIATION_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ActionError("invalid_request", "The reconciliation limit must be a positive integer.");
    }
    const rows = await this.db
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.accountId, accountId), inArray(actions.status, [...PENDING_ACTION_STATUSES])))
      .orderBy(actions.createdAt)
      .limit(limit);
    const summary: RestartReconciliationSummary = {
      scanned: rows.length,
      executed: 0,
      held: 0,
      generationMismatch: 0,
    };
    for (const row of rows) {
      const result = await this.execute(row.id, mailbox);
      if (result.state === "executed") {
        summary.executed += 1;
      } else if (result.state === "held") {
        summary.held += 1;
      } else {
        summary.generationMismatch += 1;
      }
    }
    return summary;
  }

  /**
   * Disposition the actions a restore left behind (SPEC section 10, step 5).
   * Old queued items become conflicted: their frozen scope belongs to a
   * history the database no longer holds. Old executing items become unknown:
   * the backup lost their remote outcome and nothing replays to find it. Both
   * hold explicitly, which lets `recovery complete` verify a disposition.
   */
  async dispositionRestoredActions(currentGeneration: string): Promise<RestoredDispositionSummary> {
    if (!UUID_PATTERN.test(currentGeneration)) {
      throw new ActionError("invalid_request", "The current recovery generation must be a UUID.");
    }
    const restored = await this.db
      .select()
      .from(actions)
      .where(and(ne(actions.recoveryGeneration, currentGeneration), inArray(actions.status, [...PENDING_ACTION_STATUSES])));
    const summary: RestoredDispositionSummary = { actions: 0, conflicted: 0, unknown: 0 };
    for (const action of restored) {
      await this.db.transaction(async (tx) => {
        const queued = await tx
          .update(actionItems)
          .set({ status: "conflicted", outcome: { reason: "restored_generation" }, updatedAt: new Date() })
          .where(and(eq(actionItems.actionId, action.id), eq(actionItems.status, "queued")))
          .returning({ itemKey: actionItems.itemKey });
        const executing = await tx
          .update(actionItems)
          .set({ status: "unknown", outcome: { reason: "restored_generation" }, updatedAt: new Date() })
          .where(and(eq(actionItems.actionId, action.id), eq(actionItems.status, "executing")))
          .returning({ itemKey: actionItems.itemKey });
        const completed = await tx
          .update(actions)
          .set({ status: "complete", updatedAt: new Date() })
          .where(and(eq(actions.id, action.id), inArray(actions.status, [...PENDING_ACTION_STATUSES])))
          .returning({ id: actions.id });
        if (completed.length === 0) {
          return;
        }
        await tx.insert(events).values({
          actor: "user",
          type: ACTION_RESTORED_HELD_EVENT,
          entityType: "action",
          entityId: action.id,
          payload: {
            accountId: action.accountId,
            kind: action.kind,
            recoveryGeneration: action.recoveryGeneration,
            conflicted: queued.length,
            unknown: executing.length,
          },
        });
        summary.actions += 1;
        summary.conflicted += queued.length;
        summary.unknown += executing.length;
      });
    }
    return summary;
  }

  /**
   * Run one folder group: select, validate the generation, refresh the remote
   * flags, then disposition each item. Returns why the run stopped early, or
   * `null` when the group finished (SPEC section 7, steps 3 and 4).
   */
  private async executeFolderGroup(
    action: ActionRow,
    items: ItemRow[],
    destination: { id: string; name: string } | null,
    mailbox: M,
  ): Promise<"blocked" | "stale" | null> {
    const folder = await this.loadFolder(action.accountId, items[0]!.target.folderId);
    if (folder === null) {
      await this.conflictItems(action, items, "folder_removed");
      return null;
    }
    if (folder.uidvalidity === null) {
      // A folder without a recorded generation was never synchronized; a UID
      // from it cannot be applied (SPEC F2).
      await this.conflictItems(action, items, "folder_uninitialized");
      return null;
    }

    // Selection validates the generation before any fetch or mutation
    // (SPEC F2).
    const selected = await mailbox.select(folder.name);
    if (selected.uidValidity !== folder.uidvalidity) {
      await this.conflictItems(action, items, "generation_changed", { observed: selected.uidValidity });
      return null;
    }

    // Remote-state refresh (SPEC section 7, step 3): the flags decide the
    // no-op and prove the targets still exist.
    const remoteFlags = await mailbox.fetchFlags(items.map((item) => item.target.uid));
    const remoteByUid = new Map(remoteFlags.map((flags) => [flags.uid, flags]));

    for (const item of items) {
      const remote = remoteByUid.get(item.target.uid);
      if (remote === undefined) {
        await this.commitDisposition(action, item, this.conflict("absent_remote"));
        continue;
      }
      const occurrence = await this.loadOccurrence(item.target.occurrenceId);
      if (occurrence === null) {
        await this.commitDisposition(action, item, this.conflict("occurrence_missing"));
        continue;
      }
      if (occurrence.expungedAt !== null) {
        await this.commitDisposition(action, item, this.conflict("expunged"));
        continue;
      }
      if (occurrence.invalidatedAt !== null) {
        await this.commitDisposition(action, item, this.conflict("invalidated"));
        continue;
      }
      if (
        occurrence.uidvalidity !== item.target.uidvalidity ||
        occurrence.uidvalidity !== folder.uidvalidity
      ) {
        // The item was frozen against a generation the rows no longer hold.
        // A UID from the old space can name any message in the new one, so
        // the write refuses instead of guessing (SPEC F2).
        await this.commitDisposition(
          action,
          item,
          this.conflict("generation_changed", {
            currentUidvalidity: occurrence.uidvalidity,
            folderUidvalidity: folder.uidvalidity,
          }),
        );
        continue;
      }

      const desire = flagDesireOf(action.kind as ActionKind);
      if (desire !== null && remote[desire.flag] === desire.value) {
        // The target already holds the desired value: success, without a
        // write, whatever happened to the revision (SPEC F2).
        await this.commitDisposition(action, item, {
          status: "confirmed",
          outcome: { noop: true, observed: observedFlags(remote) },
          observed: remote,
          applied: true,
        });
        continue;
      }
      if (occurrence.revision !== item.target.revision) {
        await this.commitDisposition(action, item, this.conflict("stale_revision", { currentRevision: occurrence.revision }));
        continue;
      }
      if ((occurrence.modseq ?? null) !== (item.target.modseq ?? null)) {
        await this.commitDisposition(action, item, this.conflict("modseq_changed", { currentModseq: occurrence.modseq ?? null }));
        continue;
      }

      // Claim the item before the remote call, so a crash between the write
      // and the receipt is visible as `executing` (SPEC section 7, step 4).
      const claimed = await this.markExecuting(action.id, item.itemKey);
      if (!claimed && item.status !== "executing") {
        continue;
      }
      const reassess = await this.assessmentOf(action);
      if (reassess !== null) {
        return reassess;
      }

      const prepared: PreparedActionItem = {
        actionId: action.id,
        itemKey: item.itemKey,
        kind: action.kind as ActionKind,
        accountId: action.accountId,
        folder: { id: folder.id, name: folder.name, uidvalidity: folder.uidvalidity },
        target: item.target,
        remote,
        desired: this.desiredState(action, desire, destination),
      };
      const outcome = await this.applyPrepared(mailbox, prepared);
      // Each receipt below belongs to the claim that ran the remote write, so
      // it supersedes the interrupted hold a concurrent run may have recorded
      // while the write was in flight.
      if (outcome.outcome === "confirmed") {
        await this.commitDisposition(action, item, {
          status: "confirmed",
          outcome: {
            observed: observedFlags(outcome.observed),
            ...(outcome.movedTo === undefined ? {} : { movedTo: outcome.movedTo }),
          },
          observed: outcome.observed,
          applied: true,
          // A confirmed move emptied the source occurrence; the destination
          // copy arrives through synchronization (SPEC F4).
          expunge: outcome.movedTo !== undefined,
          supersedesHold: true,
        });
      } else if (outcome.outcome === "conflicted") {
        await this.commitDisposition(action, item, {
          status: "conflicted",
          outcome: { reason: outcome.reason, observed: observedFlags(outcome.observed) },
          observed: outcome.observed,
          supersedesHold: true,
        });
      } else if (outcome.outcome === "unknown") {
        await this.commitDisposition(action, item, {
          status: "unknown",
          // A lost answer keeps the last observed state in its receipt; the
          // local observation stays untouched, because the write may or may
          // not have applied (SPEC F2).
          outcome: {
            reason: outcome.reason,
            ...(outcome.observed === undefined ? {} : { observed: observedFlags(outcome.observed) }),
          },
          supersedesHold: true,
        });
      } else {
        await this.commitDisposition(action, item, {
          status: "failed",
          outcome: { code: outcome.code, message: outcome.message },
          supersedesHold: true,
        });
      }
    }
    return null;
  }

  /** Run the executor and map anything it throws to a failed receipt. */
  private async applyPrepared(mailbox: M, prepared: PreparedActionItem): Promise<ExecutorOutcome> {
    try {
      return await this.executor.apply(mailbox, prepared);
    } catch (cause) {
      return {
        outcome: "failed",
        code: "executor_error",
        message: cause instanceof Error && cause.message ? cause.message : "The executor failed without a message.",
      };
    }
  }

  private desiredState(
    action: ActionRow,
    desire: ReturnType<typeof flagDesireOf>,
    destination: { id: string; name: string } | null,
  ): DesiredActionState {
    if (desire !== null) {
      return { type: "flags", desire };
    }
    const scope = scopeOf(action);
    return {
      type: "move",
      destinationFolderId: destination?.id ?? scope.destinationFolderId ?? "",
      destinationFolderName: destination?.name ?? "",
    };
  }

  /**
   * The disposition write of one item, committed with its observed state and
   * event (step 5). A confirmed move also expunges the source occurrence, and
   * an observation that carried a server modification sequence records it, so
   * the next queued action captures a fresher condition (SPEC F2).
   *
   * A receipt flagged `supersedesHold` comes from the claim that ran the
   * remote write. It also replaces the `unknown` interrupted hold a
   * concurrent run recorded while that write was in flight: the live worker
   * holds the real outcome, and a confirmed move must still expunge its
   * source occurrence locally. Every other hold — a lost answer, a restored
   * generation — stays final.
   */
  private async commitDisposition(
    action: ActionRow,
    item: ItemRow,
    write: {
      status: ActionItemStatus;
      outcome: Record<string, unknown> | null;
      observed?: ActionMailboxFlags;
      applied?: boolean;
      expunge?: boolean;
      /** Replace the interrupted hold a concurrent run recorded. */
      supersedesHold?: boolean;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Only a still-pending item accepts a disposition, so a concurrent run
      // of the same action cannot overwrite a finished receipt — except the
      // interrupted hold, which exists only until the claim's own receipt
      // arrives.
      const interruptedHold = and(
        eq(actionItems.status, "unknown"),
        sql`(${actionItems.outcome} ->> 'reason') = 'interrupted'`,
      );
      const eligible = write.supersedesHold
        ? or(inArray(actionItems.status, [...PENDING_ITEM_STATUSES]), interruptedHold)
        : inArray(actionItems.status, [...PENDING_ITEM_STATUSES]);
      const updated = await tx
        .update(actionItems)
        .set({ status: write.status, outcome: write.outcome, updatedAt: new Date() })
        .where(and(eq(actionItems.actionId, action.id), eq(actionItems.itemKey, item.itemKey), eligible))
        .returning({ itemKey: actionItems.itemKey });
      if (updated.length === 0) {
        return;
      }

      if (write.observed !== undefined || write.expunge === true) {
        // Commit what the mailbox answered with the receipt. The revision
        // only moves when the flags changed, so a stable target stays fresh
        // for other queued actions; a modseq-only observation refreshes the
        // captured condition without inventing a change (SPEC F2).
        const rows = await tx
          .select({ unread: messageOccurrences.unread, flagged: messageOccurrences.flagged })
          .from(messageOccurrences)
          .where(eq(messageOccurrences.id, item.target.occurrenceId))
          .limit(1);
        const current = rows[0];
        const observed = write.observed;
        const flagsChanged =
          current !== undefined &&
          observed !== undefined &&
          (current.unread !== observed.unread || current.flagged !== observed.flagged);
        const modseq = observed?.modseq ?? null;
        const modseqFresh = modseq !== null;
        if (current !== undefined && (flagsChanged || modseqFresh || write.expunge === true)) {
          await tx
            .update(messageOccurrences)
            .set({
              ...(observed !== undefined ? { unread: observed.unread, flagged: observed.flagged } : {}),
              ...(modseqFresh ? { modseq } : {}),
              ...(flagsChanged ? { revision: sql`${messageOccurrences.revision} + 1` } : {}),
              ...(write.expunge === true ? { expungedAt: new Date() } : {}),
              observedAt: new Date(),
            })
            .where(
              and(
                eq(messageOccurrences.id, item.target.occurrenceId),
                isNull(messageOccurrences.expungedAt),
              ),
            );
        }
      }

      if (write.applied === true) {
        await tx.insert(events).values({
          actor: "user",
          type: ACTION_APPLIED_EVENT,
          entityType: "occurrence",
          entityId: item.target.occurrenceId,
          payload: {
            accountId: action.accountId,
            actionId: action.id,
            kind: action.kind,
            folderId: item.target.folderId,
            uid: item.target.uid,
          },
        });
      }

      await this.finalizeActionStatus(tx, action.id);
    });
  }

  /** Move one item from `queued` to `executing` before its remote call. */
  private async markExecuting(actionId: string, itemKey: string): Promise<boolean> {
    const updated = await this.db
      .update(actionItems)
      .set({ status: "executing", updatedAt: new Date() })
      .where(
        and(
          eq(actionItems.actionId, actionId),
          eq(actionItems.itemKey, itemKey),
          eq(actionItems.status, "queued"),
        ),
      )
      .returning({ itemKey: actionItems.itemKey });
    return updated.length > 0;
  }

  /** Complete an action whose items all hold dispositions, or mark it executing. */
  private async finalizeActionStatus(tx: MailHubTransaction, actionId: string): Promise<void> {
    const pendingRows = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(actionItems)
      .where(and(eq(actionItems.actionId, actionId), inArray(actionItems.status, [...PENDING_ITEM_STATUSES])));
    const pending = pendingRows[0]?.value ?? 0;
    if (pending > 0) {
      await tx
        .update(actions)
        .set({ status: "executing", updatedAt: new Date() })
        .where(and(eq(actions.id, actionId), eq(actions.status, "queued")));
      return;
    }
    const completed = await tx
      .update(actions)
      .set({ status: "complete", updatedAt: new Date() })
      .where(and(eq(actions.id, actionId), inArray(actions.status, [...PENDING_ACTION_STATUSES])))
      .returning({ id: actions.id });
    if (completed.length === 0) {
      return;
    }
    const counts = await tx
      .select({ status: actionItems.status, value: sql<number>`count(*)::int` })
      .from(actionItems)
      .where(eq(actionItems.actionId, actionId))
      .groupBy(actionItems.status);
    await tx.insert(events).values({
      actor: "user",
      type: ACTION_COMPLETED_EVENT,
      entityType: "action",
      entityId: actionId,
      payload: { counts: Object.fromEntries(counts.map((row) => [row.status, row.value])) },
    });
  }

  /** Self-heal the action status after a run (step 5). */
  private async refreshActionStatus(actionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.finalizeActionStatus(tx, actionId);
    });
  }

  private conflict(reason: string, extra: Record<string, unknown> = {}): {
    status: ActionItemStatus;
    outcome: Record<string, unknown>;
  } {
    return { status: "conflicted", outcome: { reason, ...extra } };
  }

  private async conflictItems(
    action: ActionRow,
    items: ItemRow[],
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    for (const item of items) {
      await this.commitDisposition(action, item, this.conflict(reason, { ...extra, folderId: item.target.folderId, uid: item.target.uid }));
    }
  }

  private async conflictAll(action: ActionRow, reason: string): Promise<void> {
    const pending = (await this.loadItems(action.id)).filter((item) =>
      PENDING_ITEM_STATUSES.includes(item.status),
    );
    await this.conflictItems(action, pending, reason);
  }

  /** Validate the scope against current rows and freeze every target (SPEC F2). */
  private async freezeTargets(scope: ActionScope): Promise<ActionItemTarget[]> {
    const accountRows = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, scope.accountId))
      .limit(1);
    if (accountRows.length === 0) {
      throw new ActionError("not_found", "No account exists with that identifier.");
    }

    const occurrences = await this.db
      .select({
        id: messageOccurrences.id,
        accountId: messageOccurrences.accountId,
        folderId: messageOccurrences.folderId,
        uidvalidity: messageOccurrences.uidvalidity,
        uid: messageOccurrences.uid,
        revision: messageOccurrences.revision,
        unread: messageOccurrences.unread,
        flagged: messageOccurrences.flagged,
        modseq: messageOccurrences.modseq,
        expungedAt: messageOccurrences.expungedAt,
        invalidatedAt: messageOccurrences.invalidatedAt,
      })
      .from(messageOccurrences)
      .where(
        and(eq(messageOccurrences.accountId, scope.accountId), inArray(messageOccurrences.id, scope.occurrenceIds)),
      );
    if (occurrences.length !== scope.occurrenceIds.length || occurrences.some((row) => row.expungedAt !== null || row.invalidatedAt !== null)) {
      throw new ActionError(
        "invalid_request",
        "Every target must be an active occurrence of this account.",
      );
    }

    if (requiresDestination(scope.kind)) {
      const destinationRows = await this.db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, scope.destinationFolderId!), eq(folders.accountId, scope.accountId)))
        .limit(1);
      if (destinationRows.length === 0) {
        throw new ActionError("not_found", "No destination folder of this account exists with that identifier.");
      }
      // Account boundaries apply to action targets (SPEC section 8); a move
      // onto its own source folder is not a mutation this version defines.
      if (occurrences.some((row) => row.folderId === destinationRows[0]!.id)) {
        throw new ActionError("invalid_request", "The destination folder must differ from every source folder.");
      }
    }

    return occurrences.map((row) => frozenTarget(row));
  }

  private async assessmentOf(action: ActionRow): Promise<"blocked" | "stale" | null> {
    const status = await this.controls.readStatus();
    const assessment = assessJob(status, action.recoveryGeneration);
    if (assessment === "execute") {
      return null;
    }
    return assessment;
  }

  private async blockedResult(
    actionId: string,
    assessment: "blocked" | "stale",
  ): Promise<ActionExecutionResult> {
    const receipt = await this.receipt(actionId);
    if (assessment === "blocked") {
      return { state: "held", reason: "recovery_blocked", receipt };
    }
    const status = await this.controls.readStatus();
    return {
      state: "generation_mismatch",
      currentGeneration: status.state === "ready" ? status.generation : null,
      receipt,
    };
  }

  private async findByIdempotencyKey(idempotencyKey: string): Promise<ActionRow | null> {
    const rows = await this.db.select().from(actions).where(eq(actions.idempotencyKey, idempotencyKey)).limit(1);
    return rows[0] ?? null;
  }

  private async existingReceipt(existing: ActionRow, requestHash: string): Promise<ActionReceipt> {
    if (existing.requestHash !== requestHash) {
      throw new ActionError(
        "idempotency_conflict",
        "An action with this idempotency key exists with a different request.",
      );
    }
    return this.receiptOf(existing);
  }

  private async loadAction(actionId: string): Promise<ActionRow> {
    if (!UUID_PATTERN.test(actionId)) {
      throw new ActionError("invalid_request", "The action identifier must be a UUID.");
    }
    const rows = await this.db.select().from(actions).where(eq(actions.id, actionId)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ActionError("not_found", "No action exists with that identifier.");
    }
    return row;
  }

  private async loadItems(actionId: string): Promise<ItemRow[]> {
    // UID order keeps execution and receipts deterministic within a folder.
    return this.db
      .select()
      .from(actionItems)
      .where(eq(actionItems.actionId, actionId))
      .orderBy(sql`(${actionItems.target} ->> 'uid')::bigint`, actionItems.itemKey);
  }

  private async loadFolder(accountId: string, folderId: string): Promise<typeof folders.$inferSelect | null> {
    if (!UUID_PATTERN.test(folderId)) {
      return null;
    }
    const rows = await this.db
      .select()
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.accountId, accountId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async loadOccurrence(occurrenceId: string): Promise<typeof messageOccurrences.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(messageOccurrences)
      .where(eq(messageOccurrences.id, occurrenceId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async receiptOf(action: ActionRow): Promise<ActionReceipt> {
    const items = await this.loadItems(action.id);
    return {
      actionId: action.id,
      kind: action.kind as ActionKind,
      status: action.status as ActionStatus,
      idempotencyKey: action.idempotencyKey,
      items: items.map((item) => ({ itemKey: item.itemKey, status: item.status, outcome: item.outcome ?? null })),
    };
  }
}

/** The observed flags of one remote answer, as receipts record them. */
function observedFlags(flags: ActionMailboxFlags): { unread: boolean; flagged: boolean; modseq?: string | null } {
  return {
    unread: flags.unread,
    flagged: flags.flagged,
    ...(flags.modseq === undefined ? {} : { modseq: flags.modseq }),
  };
}

/** The immutable scope one action row froze at queue time. */
function scopeOf(action: ActionRow): ActionScope {
  return action.request as unknown as ActionScope;
}

/** PostgreSQL's unique-violation code, raised by a racing idempotency insert. */
function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "23505"
  );
}
