import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  accounts,
  actions,
  events,
  messages,
  outboundMessages,
  serviceState,
  type MailHubDatabase,
} from "@mail-hub/database";

import {
  classifyControlState,
  decideMutationGate,
  mutationGateError,
  parseDeploymentGeneration,
  type ControlStatus,
  type ServiceStateRow,
} from "./status.ts";

/** Transaction handle of the mail hub database client. */
export type MailHubTransaction = Parameters<Parameters<MailHubDatabase["transaction"]>[0]>[0];

/**
 * Authentication extension points. Passkey support (SPEC section 9) wires
 * these once owner, session, and grant tables exist. Until then no
 * authentication state exists to revoke or verify.
 */
export interface RecoveryHooks {
  /**
   * Revoke restored sessions, grants, challenges, and credentials. Runs once
   * per recovery, inside the transaction that records the new generation
   * (SPEC section 10, step 3).
   */
  revokeRestoredAuth?(tx: MailHubTransaction): Promise<void>;

  /**
   * Confirm that an owner credential is registered. `recovery complete`
   * requires it (SPEC section 10, step 7).
   */
  hasRegisteredOwner?(tx: MailHubTransaction): Promise<boolean>;
}

export interface RecoveryControlsOptions {
  /** Raw `RECOVERY_GENERATION` deployment value. Invalid values block service. */
  deploymentGeneration?: string | null;
  hooks?: RecoveryHooks;
}

/** Restored operations that still lack a disposition. */
export interface PendingOperationCounts {
  actions: number;
  outboundMessages: number;
}

export type InitializeOutcome =
  | { result: "initialized"; generation: string }
  | {
      result: "rejected";
      reason: "deployment_config_missing" | "already_initialized" | "database_not_empty";
    };

export type BeginOutcome =
  | { result: "started"; generation: string }
  | { result: "resumed"; generation: string }
  | { result: "rejected"; reason: "deployment_config_missing" | "already_ready" };

export type CompleteOutcome =
  | { result: "completed"; generation: string; ownerCheck: "verified" | "unavailable" }
  | {
      result: "rejected";
      reason:
        | "deployment_config_missing"
        | "no_active_recovery"
        | "generation_mismatch"
        | "owner_missing"
        | "pending_operations";
      pendingOperations?: PendingOperationCounts;
    };

/** Anything able to gate a mutation. `RecoveryControls` satisfies this. */
export interface MutationGate {
  gateMutation(requestGeneration?: string | null): Promise<{ generation: string }>;
}

/** Mail mutations that a restore leaves without a disposition. */
const PENDING_ACTION_STATUSES = ["queued", "executing"] as const;

/** An `outcome_unknown` send is an explicit hold, so it counts as dispositioned. */
const PENDING_OUTBOUND_STATUSES = ["queued", "sending"] as const;

/**
 * The recovery-generation controls for startup and mutations (SPEC sections
 * 7, 8, and 10). One instance wraps one database and one deployment
 * configuration.
 */
export class RecoveryControls implements MutationGate {
  private readonly deployment: string | null;
  private readonly hooks: RecoveryHooks | undefined;

  constructor(
    private readonly db: MailHubDatabase,
    options: RecoveryControlsOptions = {},
  ) {
    this.deployment = parseDeploymentGeneration(options.deploymentGeneration ?? undefined);
    this.hooks = options.hooks;
  }

  /** The configured deployment generation, or `null` when missing or invalid. */
  get deploymentGeneration(): string | null {
    return this.deployment;
  }

  /** Read and classify the current control state. */
  async readStatus(): Promise<ControlStatus> {
    if (this.deployment === null) {
      return { state: "config_missing" };
    }
    const rows = await this.db.select().from(serviceState).limit(1);
    return classifyControlState(toServiceStateRow(rows[0] ?? null), this.deployment);
  }

  /**
   * Enforce the recovery gate for one durable client mutation. Runs before
   * the idempotency lookup (SPEC section 7, step 1). Throws
   * `RecoveryBlockedError` when the request must not proceed.
   */
  async gateMutation(requestGeneration?: string | null): Promise<{ generation: string }> {
    const status = await this.readStatus();
    const decision = decideMutationGate(status, requestGeneration);
    if (decision.decision === "allow") {
      return { generation: decision.generation };
    }
    throw mutationGateError(decision);
  }

  /**
   * Initialize control state on a fresh installation (SPEC section 8). Only
   * an empty database qualifies: no owner, no mail, no queued work. A
   * populated database requires `beginRecovery` instead.
   */
  async initialize(): Promise<InitializeOutcome> {
    if (this.deployment === null) {
      return { result: "rejected", reason: "deployment_config_missing" };
    }
    const deployment = this.deployment;
    return this.db.transaction(async (tx) => {
      if (!(await databaseIsEmpty(tx))) {
        return { result: "rejected", reason: "database_not_empty" } as const;
      }
      const inserted = await tx
        .insert(serviceState)
        .values({ singleton: true, recoveryGeneration: deployment, recoveryMode: "ready" })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        return { result: "rejected", reason: "already_initialized" } as const;
      }
      await recordEvent(tx, "recovery.init", { recoveryGeneration: deployment });
      return { result: "initialized", generation: deployment } as const;
    });
  }

  /**
   * Begin restore recovery (SPEC section 10, step 3). Records the deployment
   * generation and mode `reconciling`, and revokes restored authentication
   * state once. Repeating the command for the same active recovery resumes it
   * without repeating revocation. It rejects the current generation when the
   * service is already `ready`.
   */
  async beginRecovery(): Promise<BeginOutcome> {
    if (this.deployment === null) {
      return { result: "rejected", reason: "deployment_config_missing" };
    }
    const deployment = this.deployment;
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(serviceState)
        .values({ singleton: true, recoveryGeneration: deployment, recoveryMode: "reconciling" })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) {
        await this.revokeRestoredAuth(tx);
        await recordEvent(tx, "recovery.begin", { recoveryGeneration: deployment, resumed: false });
        return { result: "started", generation: deployment } as const;
      }

      const rows = await tx
        .select()
        .from(serviceState)
        .where(eq(serviceState.singleton, true))
        .for("update");
      const row = rows[0];
      if (row === undefined) {
        throw new Error("The service_state row disappeared inside the recovery transaction.");
      }
      if (row.recoveryGeneration.toLowerCase() === deployment) {
        if (row.recoveryMode === "ready") {
          return { result: "rejected", reason: "already_ready" } as const;
        }
        // Resume the active recovery without repeating revocation.
        await recordEvent(tx, "recovery.begin", { recoveryGeneration: deployment, resumed: true });
        return { result: "resumed", generation: deployment } as const;
      }

      await tx
        .update(serviceState)
        .set({ recoveryGeneration: deployment, recoveryMode: "reconciling", updatedAt: new Date() })
        .where(eq(serviceState.singleton, true));
      await this.revokeRestoredAuth(tx);
      await recordEvent(tx, "recovery.begin", {
        recoveryGeneration: deployment,
        previousGeneration: row.recoveryGeneration,
        resumed: false,
      });
      return { result: "started", generation: deployment } as const;
    });
  }

  /**
   * Complete restore recovery (SPEC section 10, step 7). Requires the
   * matching deployment generation, a registered owner, and a disposition for
   * every restored pending operation. Sets mode `ready` for new work. Old
   * jobs remain disabled: they keep their original generation and fail the
   * job gate.
   */
  async completeRecovery(): Promise<CompleteOutcome> {
    if (this.deployment === null) {
      return { result: "rejected", reason: "deployment_config_missing" };
    }
    const deployment = this.deployment;
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(serviceState)
        .where(eq(serviceState.singleton, true))
        .for("update");
      const row = rows[0];
      if (row === undefined || row.recoveryMode !== "reconciling") {
        return { result: "rejected", reason: "no_active_recovery" } as const;
      }
      if (row.recoveryGeneration.toLowerCase() !== deployment) {
        return { result: "rejected", reason: "generation_mismatch" } as const;
      }

      const pendingOperations = await countUndispositionedOperations(tx, deployment);
      if (pendingOperations.actions > 0 || pendingOperations.outboundMessages > 0) {
        return { result: "rejected", reason: "pending_operations", pendingOperations } as const;
      }

      const checkOwner = this.hooks?.hasRegisteredOwner;
      if (checkOwner !== undefined && !(await checkOwner(tx))) {
        return { result: "rejected", reason: "owner_missing" } as const;
      }

      await tx
        .update(serviceState)
        .set({ recoveryMode: "ready", updatedAt: new Date() })
        .where(eq(serviceState.singleton, true));
      await recordEvent(tx, "recovery.complete", {
        recoveryGeneration: deployment,
        ownerCheck: checkOwner !== undefined ? "verified" : "unavailable",
      });
      return {
        result: "completed",
        generation: deployment,
        ownerCheck: checkOwner !== undefined ? "verified" : "unavailable",
      } as const;
    });
  }

  private async revokeRestoredAuth(tx: MailHubTransaction): Promise<void> {
    await this.hooks?.revokeRestoredAuth?.(tx);
  }
}

function toServiceStateRow(row: typeof serviceState.$inferSelect | null): ServiceStateRow | null {
  if (row === null) {
    return null;
  }
  return { recoveryGeneration: row.recoveryGeneration, recoveryMode: row.recoveryMode };
}

/**
 * A database is empty for initialization when it holds no account, no mail,
 * and no queued work. The passkey bootstrap uses the same boundary (SPEC
 * section 9).
 */
async function databaseIsEmpty(tx: MailHubTransaction): Promise<boolean> {
  for (const table of [accounts, messages, actions, outboundMessages]) {
    const rows = await tx.select({ value: sql<number>`count(*)::int` }).from(table);
    if ((rows[0]?.value ?? 0) > 0) {
      return false;
    }
  }
  return true;
}

/** Count restored operations that still hold a pending status. */
async function countUndispositionedOperations(
  tx: MailHubTransaction,
  deployment: string,
): Promise<PendingOperationCounts> {
  const actionRows = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(actions)
    .where(
      and(
        ne(actions.recoveryGeneration, deployment),
        inArray(actions.status, [...PENDING_ACTION_STATUSES]),
      ),
    );
  const outboundRows = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(outboundMessages)
    .where(
      and(
        ne(outboundMessages.recoveryGeneration, deployment),
        inArray(outboundMessages.status, [...PENDING_OUTBOUND_STATUSES]),
      ),
    );
  return {
    actions: actionRows[0]?.value ?? 0,
    outboundMessages: outboundRows[0]?.value ?? 0,
  };
}

/** Record one recovery audit event. Payloads never contain secrets. */
async function recordEvent(
  tx: MailHubTransaction,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(events).values({ actor: "user", type, entityType: "service_state", payload });
}
