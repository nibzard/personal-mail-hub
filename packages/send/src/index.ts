/**
 * The outbound pipeline (SPEC F7): immutable send snapshots, SMTP submission,
 * and Sent-copy recovery. `OutboundService` freezes a draft into exact MIME
 * bytes, stores them durably, claims each queued row once, preserves
 * recipient-level SMTP results, and creates the local sent record after
 * acceptance. The separate Sent append job stores the copy from the same
 * bytes, reconciles lost responses against durable evidence, holds unknown
 * outcomes open, and never resubmits an uncertain attempt.
 */
export {
  OutboundService,
  ATTEMPT_LEASE_MS,
  DEFAULT_SEND_SWEEP_LIMIT,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  SEND_FAILED_EVENT,
  SEND_QUEUED_EVENT,
  SEND_RECONCILE_HALTED_EVENT,
  SEND_SENT_COPY_FAILED_EVENT,
  SEND_SENT_COPY_HALTED_EVENT,
  SEND_SENT_COPY_STORED_EVENT,
  SEND_SENT_COPY_UNKNOWN_EVENT,
  SEND_SENT_EVENT,
  SEND_UNKNOWN_EVENT,
  SEND_SWEEP_ATTEMPT_CAP,
  type AbandonedAttemptSummary,
  type OutboundExecutionDeps,
  type OutboundRecord,
  type QueueSendInput,
  type QueueSendResult,
  type SendControlState,
  type SendSweepSummary,
  type SentCopySweepSummary,
  type UnknownSweepSummary,
} from "./service.ts";
export { SendError } from "./errors.ts";
export { composeOutboundMime, type OutboundAttachment, type OutboundMimeInput } from "./mime.ts";
export { renderMarkdownHtml } from "./render.ts";
export type { SmtpCredentials, SmtpCredentialsResolver, SmtpSubmitter } from "./smtp.ts";
export type {
  SentCopyDestination,
  SentCopyMailbox,
  SentCopySessionFactory,
  SentCopyWriteResult,
} from "./sent-copy.ts";
export { toOutboundView } from "./view.ts";
