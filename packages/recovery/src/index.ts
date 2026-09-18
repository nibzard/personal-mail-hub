/**
 * Recovery-generation controls for the mail hub (SPEC sections 7, 8, and 10).
 *
 * One control state gates every worker and mail mutation: deployment
 * configuration carries `RECOVERY_GENERATION`, the `service_state` row
 * carries the database generation, and both must agree with mode `ready`
 * before remote mail work runs.
 *
 * Mutation services call `gateMutation` before their idempotency lookup,
 * even when the key is absent from the database. Queue handlers wrap each job
 * with `assessJob`; a job keeps the generation it was created with, and a
 * lease renewal or queue retry never upgrades it.
 */
export {
  RecoveryBlockedError,
  assessJob,
  classifyControlState,
  decideMutationGate,
  describeControlStatus,
  mutationGateError,
  parseDeploymentGeneration,
  type ControlStatus,
  type JobAssessment,
  type MutationGateDecision,
  type ServiceStateRow,
} from "./status.ts";
export {
  RecoveryControls,
  type BeginOutcome,
  type CompleteOutcome,
  type InitializeOutcome,
  type MailHubTransaction,
  type MutationGate,
  type PendingOperationCounts,
  type RecoveryControlsOptions,
  type RecoveryHooks,
} from "./controls.ts";
export { waitForReadyService, type ReadyStatus, type WaitForReadyOptions } from "./wait.ts";
