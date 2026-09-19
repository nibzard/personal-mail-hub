import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  folders,
  messageOccurrences,
  messages,
  type Folder,
  type MailHubDatabase,
  type MessageOccurrence,
} from "@mail-hub/database";
import type { IngestionService } from "@mail-hub/ingestion";
import { SyncError } from "./errors.ts";
import type { MailboxSession } from "./mailbox.ts";

/**
 * Background body fetching (SPEC F2 backfill step 6).
 *
 * One imported message row with `fetched_body = false` is one durable body
 * job: it was committed with the boundary that covers it, so a restart never
 * loses one. This service lists those jobs per account, newest first, and
 * resolves each through an open session: fetch the complete bytes, confirm
 * the folder generation held, then hand the bytes to ingestion, which stores
 * the original durably before any derived row changes.
 */

/** One durable body job: a message and one active occurrence to fetch it by. */
export interface PendingBody {
  messageId: string;
  folderId: string;
  folderName: string;
  uid: number;
  uidvalidity: number;
}

/** What one body fetch did. */
export type BodyFetchOutcome =
  | {
      state: "fetched";
      /** The provisional row that was fetched. */
      messageId: string;
      /** The surviving logical row; different when byte-identical copies merged. */
      survivorId: string;
      removedMessageId: string | null;
      sha256: string;
    }
  | { state: "already_fetched"; messageId: string }
  | { state: "missing"; messageId: string }
  | { state: "generation_changed"; messageId: string; recorded: number; observed: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BodyFetchService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly ingestion: IngestionService,
  ) {}

  /**
   * The pending body jobs of one account, newest first, bounded by `limit`.
   * Only occurrences of the current folder generation qualify: a UID from an
   * older generation is never fetched (SPEC F2 reconciliation).
   */
  async pendingBodies(accountId: string, limit: number): Promise<PendingBody[]> {
    requireUuid("account id", accountId);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new SyncError("invalid_request", "The body-fetch limit must be a positive integer.");
    }

    // Two steps keep the newest-first order: rank the pending messages by
    // their newest matching occurrence, then pick one occurrence per message.
    const ranked = await this.db
      .select({ messageId: messages.id, internalDate: sql<Date>`max(${messageOccurrences.internalDate})` })
      .from(messages)
      .innerJoin(
        messageOccurrences,
        and(
          eq(messageOccurrences.messageId, messages.id),
          eq(messageOccurrences.accountId, messages.accountId),
        ),
      )
      .innerJoin(folders, eq(folders.id, messageOccurrences.folderId))
      .where(pendingBodyConditions(accountId))
      .groupBy(messages.id)
      .orderBy(desc(sql`max(${messageOccurrences.internalDate})`))
      .limit(limit);
    if (ranked.length === 0) {
      return [];
    }

    const occurrences = await this.db
      .select({
        messageId: messageOccurrences.messageId,
        occurrence: messageOccurrences,
        folderName: folders.name,
      })
      .from(messageOccurrences)
      .innerJoin(folders, eq(folders.id, messageOccurrences.folderId))
      .innerJoin(
        messages,
        and(
          eq(messages.id, messageOccurrences.messageId),
          eq(messages.accountId, messageOccurrences.accountId),
        ),
      )
      .where(
        and(
          inArray(
            messageOccurrences.messageId,
            ranked.map((row) => row.messageId),
          ),
          pendingBodyConditions(accountId),
        ),
      );

    const byMessage = new Map<string, { occurrence: MessageOccurrence; folderName: string }>();
    for (const row of occurrences) {
      if (!byMessage.has(row.messageId)) {
        byMessage.set(row.messageId, { occurrence: row.occurrence, folderName: row.folderName });
      }
    }
    return ranked.flatMap((row) => {
      const match = byMessage.get(row.messageId);
      return match === undefined
        ? []
        : [
            {
              messageId: row.messageId,
              folderId: match.occurrence.folderId,
              folderName: match.folderName,
              uid: match.occurrence.uid,
              uidvalidity: match.occurrence.uidvalidity,
            },
          ];
    });
  }

  /**
   * Fetch and ingest one pending body through an open session. The bytes are
   * read only after the folder generation matches the occurrence's, and they
   * are ingested only after the generation is confirmed to have held.
   */
  async fetchBody(
    session: MailboxSession,
    accountId: string,
    pending: PendingBody,
  ): Promise<BodyFetchOutcome> {
    requireUuid("account id", accountId);
    const target = await this.loadTarget(accountId, pending);
    if (target.message.fetchedBody) {
      return { state: "already_fetched", messageId: pending.messageId };
    }

    const mailbox = await session.select(target.folder.name);
    if (mailbox.uidValidity !== target.occurrence.uidvalidity) {
      return {
        state: "generation_changed",
        messageId: pending.messageId,
        recorded: target.occurrence.uidvalidity,
        observed: mailbox.uidValidity,
      };
    }
    const bytes = await session.fetchOriginal(target.occurrence.uid);
    if (bytes === null) {
      // Expunged on the server. The row stays pending; reconciliation owns
      // expunge marking (SPEC F2 steady state).
      return { state: "missing", messageId: pending.messageId };
    }
    const recheck = await session.revalidate();
    if (recheck.uidValidity !== target.occurrence.uidvalidity) {
      return {
        state: "generation_changed",
        messageId: pending.messageId,
        recorded: target.occurrence.uidvalidity,
        observed: recheck.uidValidity,
      };
    }

    const result = await this.ingestion.ingestOriginal({
      accountId,
      messageId: target.message.id,
      bytes,
    });
    return {
      state: "fetched",
      messageId: pending.messageId,
      survivorId: result.messageId,
      removedMessageId: result.removedMessageId,
      sha256: result.sha256,
    };
  }

  /** The occurrence, its folder, and its logical message, verified to belong together. */
  private async loadTarget(
    accountId: string,
    pending: PendingBody,
  ): Promise<{ folder: Folder; occurrence: MessageOccurrence; message: typeof messages.$inferSelect }> {
    const rows = await this.db
      .select({ folder: folders, occurrence: messageOccurrences, message: messages })
      .from(messageOccurrences)
      .innerJoin(folders, eq(folders.id, messageOccurrences.folderId))
      .innerJoin(messages, eq(messages.id, messageOccurrences.messageId))
      .where(
        and(
          eq(messageOccurrences.accountId, accountId),
          eq(messageOccurrences.messageId, pending.messageId),
          eq(messageOccurrences.folderId, pending.folderId),
          eq(messageOccurrences.uid, pending.uid),
          eq(messageOccurrences.uidvalidity, pending.uidvalidity),
          isNull(messageOccurrences.expungedAt),
          isNull(messageOccurrences.invalidatedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new SyncError("not_found", "No active occurrence of that message exists for fetching.");
    }
    return row;
  }
}

/** Conditions that make one occurrence a fetchable body target right now. */
function pendingBodyConditions(accountId: string) {
  return and(
    eq(messages.accountId, accountId),
    eq(messages.fetchedBody, false),
    isNull(messageOccurrences.expungedAt),
    isNull(messageOccurrences.invalidatedAt),
    // Only the current folder generation resolves UIDs.
    eq(folders.uidvalidity, messageOccurrences.uidvalidity),
  );
}

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new SyncError("invalid_request", `${kind} must be a UUID: ${id}`);
  }
}
