/**
 * Compose support: draft editing, durable uploads, reply addressing with
 * frozen reply headers, and the client autosave contract (SPEC F6 and F9).
 */

export { ComposeError } from "./errors.ts";
export {
  ATTACHMENTS_TOTAL_MAX_BYTES,
  DRAFT_BODY_MAX_BYTES,
  MARKDOWN_MAX,
  normalizeContentType,
  normalizeFilename,
  normalizeMarkdown,
  normalizeRecipients,
  normalizeSubject,
  normalizeEmailAddress,
  resolveIdentity,
  UPLOAD_MAX_BYTES,
  validateUploadBytes,
} from "./validation.ts";
export {
  deriveReplyRecipients,
  extractValidMessageIds,
  freezeReplyReferences,
  preselectReplyIdentity,
  replySubject,
  type FrozenReplyReferences,
  type ReplyParentHeaders,
} from "./reply.ts";
export {
  ComposeService,
  lockDraftForSend,
  unlockDraftAfterFailure,
  unlockDraftAfterSend,
  type CreateDraftInput,
  type CreateReplyDraftInput,
  type CreateUploadInput,
  type DraftAttachmentRecord,
  type DraftRecord,
  type DraftUploadVerification,
  type MutationContext,
  type ReplyQuoteExtractor,
  type UpdateDraftInput,
  type UploadRecord,
} from "./service.ts";
export {
  DraftAutosaver,
  type AutosaveOutcome,
  type AutosavePatch,
  type AutosaveState,
  type DraftAutosaverOptions,
} from "./autosave.ts";
