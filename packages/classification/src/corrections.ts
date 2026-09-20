import { and, eq, sql } from "drizzle-orm";
import {
  CORRECTION_SCOPES,
  MESSAGE_CLASSES,
  type CorrectionScope,
  type MessageClass,
  type SuggestionSource,
} from "@mail-hub/contracts";
import { events, messages, senderOverrides, type MailHubDatabase } from "@mail-hub/database";
import type { MutationGate } from "@mail-hub/recovery";
import { ClassificationError } from "./errors.ts";
import { senderAddressOf } from "./service.ts";

/**
 * Classification corrections (SPEC F8).
 *
 * A correction names its scope before anything changes — this message only,
 * this sender, or the deterministic rule that answered — because the scope
 * is the owner's decision, never a guess. Every correction is one event in
 * the audit trail, written in the same transaction as its effect:
 *
 * - `message` sets the owner's own answer for that message. It is precedence
 *   level 1, so no later level re-answers it and no call is spent.
 * - `sender` records a sender override and re-applies it to the sender's
 *   mail in that account, except mail the owner placed by hand. New mail
 *   from the sender answers at level 2 from then on.
 * - `rule` records which deterministic rule misfired and the class it should
 *   have proved. The rules are pinned code, so the edit itself is a reviewed
 *   change; the event is what asks for it, and the labeled set re-measures
 *   it before routing may turn on.
 */

/** The audit event one correction records (the name `SPEC.md` section 8 lists). */
export const CLASS_CORRECTED_EVENT = "class.corrected";

/** The longest note one correction may carry. */
const MAX_NOTE_CHARS = 2_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUGGESTION_SOURCES: readonly SuggestionSource[] = ["manual", "override", "rule", "jev"];

/** One correction the owner submitted, before validation. */
export interface CorrectionRequest {
  /** The message the owner corrected. */
  messageId: string;
  /** What the correction applies to. */
  scope: CorrectionScope;
  /** The corrected class; `null` records "no class for this scope". */
  classHint: MessageClass | null;
  /** Why, in the owner's words. */
  note?: string | null;
}

/** Context for one durable mutation: the generation the client captured. */
export interface CorrectionContext {
  requestGeneration?: string | null;
}

/** What one correction did. */
export interface CorrectionResult {
  scope: CorrectionScope;
  classHint: MessageClass | null;
  /** The sender address the correction named, when one did. */
  sender: string | null;
  /** The rule that answered the corrected message, for rule scope. */
  rule: string | null;
  /** The answer that stood before the correction, when one did. */
  previous: { source: SuggestionSource | null; classHint: MessageClass | null } | null;
  /** Messages that now carry the corrected answer. */
  reapplied: number;
}

/** One loaded message a correction acts on. */
interface CorrectedRow {
  id: string;
  account_id: string;
  sender: unknown;
  class_hint: string | null;
  metadata: Record<string, unknown> | null;
}

export class CorrectionService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly gate: MutationGate,
  ) {}

  /**
   * Apply one correction. The recovery gate runs before anything is read or
   * written (SPEC section 7, step 1); the effect and its event commit
   * together, so the trail can never disagree with the messages.
   */
  async correct(context: CorrectionContext, request: CorrectionRequest): Promise<CorrectionResult> {
    await this.gate.gateMutation(context.requestGeneration);

    const scope = request.scope;
    if (!CORRECTION_SCOPES.includes(scope)) {
      throw new ClassificationError(
        "invalid_request",
        "Scope must be message, sender, or rule.",
      );
    }
    if (!UUID_PATTERN.test(request.messageId)) {
      throw new ClassificationError("invalid_request", "The message id must be a UUID.");
    }
    if (request.classHint !== null && !MESSAGE_CLASSES.includes(request.classHint)) {
      throw new ClassificationError(
        "invalid_request",
        "The corrected class must be one of the message classes, or null.",
      );
    }
    const note = normalizeNote(request.note);

    const rows = await this.db
      .select({
        id: messages.id,
        account_id: messages.accountId,
        sender: messages.sender,
        class_hint: messages.classHint,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(eq(messages.id, request.messageId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new ClassificationError("not_found", "No message exists with that id.");
    }
    const corrected: CorrectedRow = {
      id: row.id,
      account_id: row.account_id,
      sender: row.sender,
      class_hint: row.class_hint,
      metadata: row.metadata,
    };

    const sender = senderAddressOf(corrected.sender);
    const previous = previousAnswerOf(corrected);
    const rule = ruleNameOf(corrected);
    if (scope === "rule" && rule === null) {
      throw new ClassificationError(
        "invalid_request",
        "The deterministic rules did not answer this message, so there is no rule to edit.",
      );
    }
    if (scope === "sender" && sender === null) {
      throw new ClassificationError(
        "invalid_request",
        "This message carries no usable sender address, so no sender can be corrected.",
      );
    }

    const result: CorrectionResult = {
      scope,
      classHint: request.classHint,
      sender,
      rule,
      previous,
      reapplied: 0,
    };

    await this.db.transaction(async (tx) => {
      if (scope === "message") {
        // The owner's own answer is precedence level 1. A null class is an
        // explicit "no class for this message"; either way the sweep stops
        // offering the message and no call is spent on it again.
        await tx
          .update(messages)
          .set({
            classHint: request.classHint,
            metadata: mergeMetadata(corrected.metadata, { classSource: "manual" }),
          })
          .where(eq(messages.id, corrected.id));
        result.reapplied = 1;
      }

      if (scope === "sender" && sender !== null) {
        // The override is the durable record; the sweep re-applies it to the
        // sender's mail in this account so the correction takes effect now,
        // not only on the next arrival. Mail the owner placed by hand keeps
        // its level 1 answer. The sender is keyed lowercase, so two case
        // variants of one address share a row instead of splitting the
        // owner's record; the audit event keeps the address as it stood on
        // the corrected message.
        await tx
          .insert(senderOverrides)
          .values({
            accountId: corrected.account_id,
            sender: sender.toLowerCase(),
            classHint: request.classHint,
            ...(note === null ? {} : { note }),
          })
          .onConflictDoUpdate({
            target: [senderOverrides.accountId, senderOverrides.sender],
            set: {
              classHint: request.classHint,
              ...(note === null ? {} : { note }),
            },
          });
        const swept = await tx
          .update(messages)
          .set({
            classHint: request.classHint,
            metadata: sql`${messages.metadata} || ${JSON.stringify({
              classSource: "override",
            })}::jsonb`,
          })
          .where(
            and(
              eq(messages.accountId, corrected.account_id),
              sql`lower(${messages.sender} ->> 'address') = ${sender.toLowerCase()}`,
              sql`coalesce(${messages.metadata} ->> 'classSource', '') <> 'manual'`,
            ),
          )
          .returning({ id: messages.id });
        result.reapplied = swept.length;
      }

      await tx.insert(events).values({
        actor: "user",
        type: CLASS_CORRECTED_EVENT,
        entityType: "message",
        entityId: corrected.id,
        payload: {
          scope,
          accountId: corrected.account_id,
          ...(sender === null ? {} : { sender }),
          ...(rule === null ? {} : { rule }),
          from: { source: previous?.source ?? null, classHint: previous?.classHint ?? null },
          to: request.classHint,
          ...(note === null ? {} : { note }),
        },
      });
    });

    return result;
  }
}

/** The answer that stood on one row before the correction, when one did. */
function previousAnswerOf(row: CorrectedRow): {
  source: SuggestionSource | null;
  classHint: MessageClass | null;
} | null {
  const source = row.metadata?.classSource;
  const sourceValid =
    typeof source === "string" && (SUGGESTION_SOURCES as readonly string[]).includes(source);
  const classHint =
    row.class_hint !== null && (MESSAGE_CLASSES as readonly string[]).includes(row.class_hint)
      ? (row.class_hint as MessageClass)
      : null;
  if (!sourceValid && classHint === null) {
    return null;
  }
  return { source: sourceValid ? (source as SuggestionSource) : null, classHint };
}

/** The rule that answered one row, when the deterministic rules did. */
function ruleNameOf(row: CorrectedRow): string | null {
  const rule = row.metadata?.rule;
  return typeof rule === "string" && rule.length > 0 ? rule : null;
}

/** One optional note: absent and blank both store nothing. */
function normalizeNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) {
    return null;
  }
  if (typeof note !== "string") {
    throw new ClassificationError("invalid_request", "The note must be text.");
  }
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_NOTE_CHARS) {
    throw new ClassificationError(
      "invalid_request",
      `The note must hold ${MAX_NOTE_CHARS} characters or fewer.`,
    );
  }
  return trimmed;
}

/** Merge one metadata patch without touching keys it does not name. */
function mergeMetadata(
  current: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(current ?? {}), ...patch };
}
