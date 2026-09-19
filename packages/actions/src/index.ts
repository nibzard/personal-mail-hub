/**
 * The recovery-aware mail action service (SPEC section 7).
 *
 * One internal module owns every mail mutation. An action commits its
 * immutable record and frozen per-target work items before any remote
 * execution; repeated keys return existing receipts and changed payloads
 * conflict. Execution refreshes target state from the mailbox first, rejects
 * stale generations and revisions, confirms a desired value that already
 * holds, rechecks the recovery generation before every remote mutation, and
 * commits observed state, receipts, and events together per item. Restart
 * reconciliation replays flag assignments after refreshing their targets and
 * never replays an interrupted move or a restored action blindly.
 */
export { ActionError, type ActionErrorCode } from "./errors.ts";
export {
  ACTION_KINDS,
  FLAG_KINDS,
  MAX_ACTION_TARGETS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  canonicalScope,
  flagDesireOf,
  frozenTarget,
  hashScope,
  isReplayableKind,
  requiresDestination,
  validateSubmission,
  type ActionKind,
  type ActionScope,
  type FlagActionKind,
  type FlagDesire,
  type MailActionSubmission,
  type MoveActionKind,
} from "./kinds.ts";
export type { ActionMailbox, ActionMailboxFlags, ActionMailboxState } from "./mailbox.ts";
export type {
  ActionExecutor,
  DesiredActionState,
  ExecutorOutcome,
  PreparedActionItem,
} from "./executor.ts";
export {
  ACTION_APPLIED_EVENT,
  ACTION_COMPLETED_EVENT,
  ACTION_QUEUED_EVENT,
  ACTION_RESTORED_HELD_EVENT,
  DEFAULT_RECONCILIATION_LIMIT,
  PENDING_ACTION_STATUSES,
  PENDING_ITEM_STATUSES,
  ActionService,
  type ActionControlState,
  type ActionExecutionResult,
  type ActionItemReceipt,
  type ActionReceipt,
  type ActionStatus,
  type RestartReconciliationSummary,
  type RestoredDispositionSummary,
  type SubmitResult,
} from "./service.ts";
