import type { ActionItemTarget } from "@mail-hub/database";

import type { ActionKind, FlagDesire } from "./kinds.ts";
import type { ActionMailbox, ActionMailboxFlags } from "./mailbox.ts";

/**
 * The executor port: the remote write half of one action item (SPEC section 7,
 * step 4). The service calls `apply` only after every pre-flight check passed
 * and the item row shows `executing`, so a lost response can be told apart
 * from a write that never started.
 *
 * A database transaction can never include an IMAP side effect. The executor
 * performs the remote operation only; the service commits the observed state,
 * the receipt, and the event together afterwards (SPEC section 7).
 */

/** The desired state one prepared item carries to the executor. */
export type DesiredActionState =
  | { type: "flags"; desire: FlagDesire }
  | { type: "move"; destinationFolderId: string; destinationFolderName: string };

/** One item prepared for its remote mutation, after every check passed. */
export interface PreparedActionItem {
  actionId: string;
  itemKey: string;
  kind: ActionKind;
  accountId: string;
  folder: { id: string; name: string; uidvalidity: number };
  /** The frozen target from the queueing transaction. */
  target: ActionItemTarget;
  /** The remote flags the pre-flight refresh observed. */
  remote: ActionMailboxFlags;
  desired: DesiredActionState;
}

/** The result of one remote mutation, as the executor reports it. */
export type ExecutorOutcome =
  | { outcome: "confirmed"; observed: ActionMailboxFlags }
  | { outcome: "unknown"; reason: string }
  | { outcome: "failed"; code: string; message: string };

/**
 * Applies prepared items to one mailbox session. An implementation that
 * cannot serve a kind returns `failed` with `unsupported_kind` rather than
 * throwing.
 */
export interface ActionExecutor<M extends ActionMailbox = ActionMailbox> {
  apply(mailbox: M, item: PreparedActionItem): Promise<ExecutorOutcome>;
}
