/**
 * The safe message reader (SPEC F3 and sections 8 and 9).
 *
 * Detail reads serve sanitized derivatives only. Attachment downloads serve
 * decoded bytes verified against the recorded hash, from the disposable cache
 * or from a regeneration over the verified original.
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
} from "./service.ts";
