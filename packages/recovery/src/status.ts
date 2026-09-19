import type { RecoveryErrorCode } from "@mail-hub/contracts";
import type { RecoveryMode } from "@mail-hub/database";

/**
 * Recovery control state, from `SPEC.md` sections 8 and 10.
 *
 * Deployment configuration carries `RECOVERY_GENERATION`. The
 * `service_state` row carries the database generation. Workers and mail
 * mutations run only when both agree and the mode is `ready`.
 */

/** Matches the UUID format that PostgreSQL accepts for the `uuid` type. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The parts of the `service_state` row that control decisions read. */
export interface ServiceStateRow {
  recoveryGeneration: string;
  recoveryMode: RecoveryMode;
}

/** How deployment and database recovery state relate right now. */
export type ControlStatus =
  | { state: "config_missing" }
  | { state: "uninitialized"; deploymentGeneration: string }
  | {
      state: "generation_mismatch";
      deploymentGeneration: string;
      databaseGeneration: string;
      mode: RecoveryMode;
    }
  | { state: "reconciling"; generation: string }
  | { state: "ready"; generation: string };

/**
 * Read the deployment generation from raw configuration. Return `null` when
 * the value is absent or not a UUID. Missing configuration keeps workers and
 * mail mutations blocked (SPEC section 10, step 2).
 */
export function parseDeploymentGeneration(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (UUID_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

/** Compare the database row with deployment configuration. */
export function classifyControlState(
  row: ServiceStateRow | null,
  deploymentGeneration: string | null,
): ControlStatus {
  if (deploymentGeneration === null) {
    return { state: "config_missing" };
  }
  if (row === null) {
    return { state: "uninitialized", deploymentGeneration };
  }
  if (row.recoveryGeneration.toLowerCase() !== deploymentGeneration) {
    return {
      state: "generation_mismatch",
      deploymentGeneration,
      databaseGeneration: row.recoveryGeneration,
      mode: row.recoveryMode,
    };
  }
  return row.recoveryMode === "ready"
    ? { state: "ready", generation: deploymentGeneration }
    : { state: "reconciling", generation: deploymentGeneration };
}

export type MutationGateDecision =
  | { decision: "allow"; generation: string }
  | { decision: "recovery_required"; currentGeneration: string }
  | { decision: "recovery_in_progress" }
  | { decision: "invalid_generation" };

/**
 * The generation an authenticated session exposes for new client work
 * (SPEC section 10). It is the deployed generation whatever the database
 * row says, because that is the value the gate compares requests against.
 * `null` means deployment configuration carries no generation, so no value
 * can be trusted yet.
 */
export function clientGeneration(status: ControlStatus): string | null {
  switch (status.state) {
    case "config_missing":
      return null;
    case "uninitialized":
    case "generation_mismatch":
      return status.deploymentGeneration;
    case "ready":
    case "reconciling":
      return status.generation;
  }
}

/**
 * Apply the recovery gate to one durable client mutation (SPEC sections 7
 * and 10). Call this before the idempotency lookup, even when the key is
 * absent from the database.
 */
export function decideMutationGate(
  status: ControlStatus,
  requestGeneration: string | null | undefined,
): MutationGateDecision {
  const normalized =
    requestGeneration === null || requestGeneration === undefined
      ? null
      : requestGeneration.trim().toLowerCase();
  if (normalized === null || !UUID_PATTERN.test(normalized)) {
    return { decision: "invalid_generation" };
  }
  if (status.state === "config_missing") {
    // Without deployment configuration no generation can be trusted. Keep the
    // request blocked and retryable instead of rejecting the client history.
    return { decision: "recovery_in_progress" };
  }
  const deploymentGeneration =
    status.state === "ready" || status.state === "reconciling"
      ? status.generation
      : status.deploymentGeneration;
  if (normalized !== deploymentGeneration) {
    return { decision: "recovery_required", currentGeneration: deploymentGeneration };
  }
  if (status.state !== "ready") {
    return { decision: "recovery_in_progress" };
  }
  return { decision: "allow", generation: status.generation };
}

export type JobAssessment = "execute" | "stale" | "blocked";

/**
 * Assess one queued job against the control state. A job keeps the generation
 * it was created with; a lease renewal or queue retry never upgrades it
 * (SPEC section 7). A `stale` job must never execute its payload.
 */
export function assessJob(status: ControlStatus, jobGeneration: string): JobAssessment {
  if (status.state !== "ready") {
    return "blocked";
  }
  return status.generation === jobGeneration.trim().toLowerCase() ? "execute" : "stale";
}

const HTTP_STATUS_BY_CODE = {
  recovery_required: 409,
  recovery_in_progress: 503,
  invalid_recovery_generation: 400,
} as const;

const MESSAGE_BY_CODE = {
  recovery_required:
    "The server was restored from an earlier history. Review the pending change, then retry under the current recovery generation.",
  recovery_in_progress: "Recovery is in progress. Retry the request after recovery completes.",
  invalid_recovery_generation:
    "Mail mutations must carry the recovery generation issued when the client state was created.",
} satisfies Record<RecoveryErrorCode, string>;

/** A recovery gate rejection, with the HTTP status it maps to. */
export class RecoveryBlockedError extends Error {
  readonly code: RecoveryErrorCode;
  readonly httpStatus: 400 | 409 | 503;
  readonly currentGeneration?: string;

  constructor(code: RecoveryErrorCode, currentGeneration?: string) {
    super(MESSAGE_BY_CODE[code]);
    this.name = "RecoveryBlockedError";
    this.code = code;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
    this.currentGeneration = currentGeneration;
  }
}

/** Turn a blocking gate decision into its error. */
export function mutationGateError(decision: MutationGateDecision): RecoveryBlockedError {
  if (decision.decision === "recovery_required") {
    return new RecoveryBlockedError("recovery_required", decision.currentGeneration);
  }
  if (decision.decision === "recovery_in_progress") {
    return new RecoveryBlockedError("recovery_in_progress");
  }
  return new RecoveryBlockedError("invalid_recovery_generation");
}

/** Render a status for operators and logs. Never includes secrets. */
export function describeControlStatus(status: ControlStatus): string {
  switch (status.state) {
    case "ready":
      return `ready (generation ${status.generation})`;
    case "reconciling":
      return `reconciling (generation ${status.generation})`;
    case "generation_mismatch":
      return `generation mismatch (deployment ${status.deploymentGeneration}, database ${status.databaseGeneration}, mode ${status.mode})`;
    case "uninitialized":
      return `uninitialized control state (deployment generation ${status.deploymentGeneration})`;
    case "config_missing":
      return "missing RECOVERY_GENERATION configuration";
  }
}
