import { StorageError } from "@mail-hub/database";
import { IngestionError } from "@mail-hub/ingestion";
import { SyncError } from "./errors.ts";

/**
 * Safe failure classification for contained sync failures (SPEC section 9:
 * no message content, addresses, or credentials in logs).
 *
 * Nothing an error object carries is trusted wholesale. A database error
 * repeats its query parameters, an IMAP error repeats server text, and a
 * thrown value can be anything at all, so messages, stacks, and detail
 * strings never reach a log line or audit event. Each failure becomes one
 * approved kind instead: a code from this package's own error families, or a
 * fixed prefix plus a code that fits a strict shape. Everything else answers
 * `unknown`, which is still diagnosable — it says the failure came from no
 * vocabulary the deployment controls.
 */

/** The kind for a failure no approved vocabulary describes. */
export const UNKNOWN_FAILURE_KIND = "unknown";

/** Every emitted kind fits this shape; anything wider is dropped. */
const KIND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * PostgreSQL SQLSTATE codes: five characters of digits and uppercase
 * letters. Every SQLSTATE class carries a digit, so requiring one keeps
 * five-letter errno codes (EPIPE, EPERM, EBUSY) in the system family.
 */
const SQLSTATE_PATTERN = /^(?=.*[0-9])[0-9A-Z]{5}$/;

/** Errno-style codes the runtime raises: ECONNRESET, ETIMEDOUT. */
const ERRNO_PATTERN = /^[A-Z][A-Z0-9]{1,23}$/;

/** Error constructor names: TypeError, AbortError, TimeoutError. */
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** How many levels of nested causes are searched for a recognized code. */
const MAX_CAUSE_DEPTH = 4;

/** How many members of one aggregate error are searched per level. */
const MAX_AGGREGATE_ERRORS = 4;

/**
 * Classify one thrown value into an approved failure kind. The value's text
 * is never serialized: only codes from known error families and codes that
 * fit a fixed shape survive; everything else answers `unknown`. Nested
 * causes are searched before error names, so a query wrapper around a
 * database fault reports the database code, not the wrapper's class.
 */
export function classifyFailure(cause: unknown): string {
  const queue: unknown[] = [cause];
  const seen = new Set<unknown>();
  let outermostError: Error | null = null;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && queue.length > 0; depth += 1) {
    const level = queue.splice(0, queue.length);
    for (const entry of level) {
      if (entry === null || entry === undefined || seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      if (outermostError === null && entry instanceof Error) {
        outermostError = entry;
      }
      if (entry instanceof SyncError) {
        return approved(entry.code);
      }
      if (entry instanceof StorageError) {
        return approved(`storage_${entry.code}`);
      }
      if (entry instanceof IngestionError) {
        return approved(`ingestion_${entry.code}`);
      }
      if (entry instanceof Error) {
        const coded = kindFromCode(entry);
        if (coded !== null) {
          return coded;
        }
        queue.push((entry as { cause?: unknown }).cause);
        const aggregate = (entry as { errors?: unknown }).errors;
        if (Array.isArray(aggregate)) {
          queue.push(...aggregate.slice(0, MAX_AGGREGATE_ERRORS));
        }
      }
    }
  }
  // The weakest signal comes last: a constructor name from the outermost
  // error, which names the failure's family (a TypeError, an AbortError)
  // without carrying any of its text.
  if (outermostError !== null && outermostError.name !== "Error" && ERROR_NAME_PATTERN.test(outermostError.name)) {
    return approved(`error_${outermostError.name.toLowerCase()}`);
  }
  return UNKNOWN_FAILURE_KIND;
}

/** One kind from an error's own `code`, when that code fits a known shape. */
function kindFromCode(entry: Error): string | null {
  const code = (entry as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) {
    return null;
  }
  if (SQLSTATE_PATTERN.test(code)) {
    return approved(`database_${code.toLowerCase()}`);
  }
  if (ERRNO_PATTERN.test(code)) {
    return approved(`system_${code.toLowerCase()}`);
  }
  return null;
}

/** Pass a composed kind through the shape check; anything wider is dropped. */
function approved(kind: string): string {
  return KIND_PATTERN.test(kind) ? kind : UNKNOWN_FAILURE_KIND;
}
