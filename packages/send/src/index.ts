/**
 * The outbound pipeline (SPEC F7): immutable send snapshots and SMTP
 * submission. `OutboundService` freezes a draft into exact MIME bytes, stores
 * them durably, claims each queued row once, preserves recipient-level SMTP
 * results, and creates the local sent record after acceptance.
 */
export {
  OutboundService,
  DEFAULT_SEND_SWEEP_LIMIT,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  SEND_FAILED_EVENT,
  SEND_QUEUED_EVENT,
  SEND_SENT_EVENT,
  SEND_UNKNOWN_EVENT,
  type OutboundExecutionDeps,
  type OutboundRecord,
  type QueueSendInput,
  type QueueSendResult,
  type SendControlState,
  type SendSweepSummary,
} from "./service.ts";
export { SendError } from "./errors.ts";
export { composeOutboundMime, type OutboundAttachment, type OutboundMimeInput } from "./mime.ts";
export { renderMarkdownHtml } from "./render.ts";
export type { SmtpCredentials, SmtpCredentialsResolver, SmtpSubmitter } from "./smtp.ts";
export { toOutboundView } from "./view.ts";
