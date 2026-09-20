import { and, eq, inArray, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { messages } from "@mail-hub/database";
import type { MailHubTransaction } from "@mail-hub/recovery";

/**
 * Durable thread-reconciliation jobs (SPEC F2 "Message identity and
 * threading").
 *
 * A message's parent link depends on exactly two things: its own reference
 * headers, and the set of rows that hold each referenced identifier. Every
 * transaction that imports, reparses, merges, or removes a row therefore marks
 * the affected rows inside that same transaction, exactly the way a committed
 * header window carries its body jobs. A marked row is the job: the
 * reconciliation pass clears the mark as it resolves the row, so a crash
 * repeats the work instead of losing it.
 */

/** What one transaction changed about an account's identifiers. */
export interface ThreadJobMarking {
  /** Rows whose own parent link must be recomputed. */
  messageIds?: readonly string[];
  /**
   * Header identifiers whose holder set changed: an import, a reparse that
   * rewrote `Message-ID`, or a merge that removed a duplicate holder. Rows
   * that reference one of these — linked, pending, or ambiguous — re-decide.
   * Absent identifiers are ignored, so callers pass parsed values as they are.
   */
  identifiers?: readonly (string | null | undefined)[];
}

/**
 * Mark thread-reconciliation jobs for one account. Call this inside the
 * transaction that changed the identifiers, never after it: the mark and the
 * change commit or roll back together.
 */
export async function markThreadJobsDirty(
  tx: MailHubTransaction,
  accountId: string,
  marking: ThreadJobMarking,
): Promise<void> {
  const messageIds = [...new Set(marking.messageIds ?? [])];
  if (messageIds.length > 0) {
    await tx
      .update(messages)
      .set({ threadDirty: true })
      .where(and(eq(messages.accountId, accountId), inArray(messages.id, messageIds)));
  }

  const identifiers = [
    ...new Set(
      (marking.identifiers ?? []).filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (identifiers.length === 0) {
    return;
  }
  // Reference extraction reads the raw stored text, so an identifier stays
  // referenced even when a comment folds around it: `<(note) <a@example.com>>`
  // names `<a@example.com>` (`resolveParentReference` in sync). An extracted
  // identifier holds no whitespace or brackets, which makes "extraction finds
  // it here" plain substring containment over the raw value. The exact
  // lookups stay index-supported — `in_reply_to` by btree and
  // `reference_ids` by its GIN index — while the containment arms sweep the
  // raw values beside them. Marking is a superset of "its candidate
  // changed"; re-deciding an unaffected row is idempotent.
  const identifierArray = sql.join(
    identifiers.map((identifier) => sql`${identifier}`),
    sql`, `,
  );
  await tx
    .update(messages)
    .set({ threadDirty: true })
    .where(
      and(
        eq(messages.accountId, accountId),
        or(
          inArray(messages.inReplyTo, identifiers),
          rawContainsIdentifier(messages.inReplyTo, identifiers),
          sql`${messages.referenceIds} ?| array[${identifierArray}]::text[]`,
          sql`exists (
            select 1
            from jsonb_array_elements_text(${messages.referenceIds}) as element(value)
            where ${rawContainsIdentifier(sql`element.value`, identifiers)}
          )`,
        ),
      ),
    );
}

/** Whether one operand's raw reference text holds any changed identifier. */
function rawContainsIdentifier(operand: SQLWrapper, identifiers: string[]): SQL {
  return sql`${operand} like any (array[${likePatterns(identifiers)}]::text[])`;
}

/** One `%identifier%` pattern per changed identifier. */
function likePatterns(identifiers: string[]): SQL {
  return sql.join(
    identifiers.map((identifier) => sql`'%' || ${escapeLikeWildcards(identifier)} || '%'`),
    sql`, `,
  );
}

/** Keep a legal `%`, `_`, or `\` inside an identifier literal for LIKE. */
function escapeLikeWildcards(identifier: string): string {
  return identifier.replaceAll(/[\\%_]/g, (wildcard) => `\\${wildcard}`);
}
