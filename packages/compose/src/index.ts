/**
 * Compose support: draft editing, durable uploads, and the client autosave
 * contract (SPEC F6 and F9).
 */

export { ComposeError } from "./errors.ts";
export {
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
  ComposeService,
  lockDraftForSend,
  unlockDraftAfterFailure,
  type CreateDraftInput,
  type CreateUploadInput,
  type DraftAttachmentRecord,
  type DraftRecord,
  type DraftUploadVerification,
  type MutationContext,
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
