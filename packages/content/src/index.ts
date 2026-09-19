/**
 * Derived content extraction (SPEC F3 and F6).
 *
 * One pinned Defuddle pass behind safe wrappers: the clean view the reader
 * renders, the Markdown blockquote a reply draft starts from, redacted
 * diagnostics, and no implicit remote extraction.
 */
export {
  ContentExtractor,
  EXTRACTION_VERSION,
  type CleanView,
  type CleanViewSource,
  type ExtractionDiagnostics,
  type ParentBody,
  type RemovalTally,
  type ReplyQuote,
  type ReplyQuoteSource,
} from "./extract.ts";
