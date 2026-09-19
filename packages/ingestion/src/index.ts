/**
 * Durable MIME ingestion and parsing (SPEC F2 and section 8).
 *
 * Original bytes are records in durable storage; parsed headers, sanitized
 * bodies, index text, and verified attachment locators are derivatives that
 * one ingestion call persists in a single transaction.
 */
export { IngestionError } from "./errors.ts";
export {
  LOCATOR_VERSION,
  MAX_MESSAGE_BYTES,
  parseMime,
  type LocatedPart,
  type ParsedMessage,
} from "./parse.ts";
export { HtmlSanitizer, SANITIZER_VERSION } from "./sanitize.ts";
export {
  IngestionService,
  type ApplyStagedInput,
  type IngestOriginalInput,
  type IngestResult,
  type RegeneratedAttachment,
  type SanitizedBody,
  type StageOriginalInput,
  type StagedOriginal,
} from "./service.ts";
export {
  BODY_INDEX_MAX_CHARS,
  SNIPPET_MAX_CHARS,
  isValidAddress,
  makeSnippet,
  normalizeIndexText,
  parseDateHeader,
  recipientsIndexText,
  senderIndexText,
  toEmailAddress,
  toEmailAddresses,
  toRecipients,
} from "./text.ts";
export { markThreadJobsDirty, type ThreadJobMarking } from "./thread-jobs.ts";
