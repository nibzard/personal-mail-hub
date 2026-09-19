/**
 * The safe message reader (SPEC F3 and sections 8 and 9).
 *
 * Detail reads serve sanitized derivatives only: a derivative stamped with
 * an old sanitizer rebuilds from the verified original first. Attachment
 * downloads serve decoded bytes verified against the recorded hash, from the
 * disposable cache or from a regeneration over the verified original.
 */
export { ReadingError } from "./errors.ts";
export {
  ReadingService,
  type AttachmentRegenerator,
  type CleanViewDetail,
  type CleanViewExtractor,
  type MessageAttachment,
  type MessageDetail,
  type OpenedAttachment,
  type SanitizedBodyRefresher,
} from "./service.ts";
