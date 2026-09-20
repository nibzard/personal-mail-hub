import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  events,
  folders,
  messageOccurrences,
  messages,
  type Folder,
  type MailHubDatabase,
  type MessageOccurrence,
} from "@mail-hub/database";
import { IngestionError, MAX_MESSAGE_BYTES, type IngestResult, type StagedOriginal } from "@mail-hub/ingestion";
import { SyncError } from "./errors.ts";
import type { MailboxSession } from "./mailbox.ts";

/**
 * Background body fetching (SPEC F2 backfill step 6).
 *
 * One imported message row with `fetched_body = false` is one durable body
 * job: it was committed with the boundary that covers it, so a restart never
 * loses one. This service lists those jobs per account, newest first, and
 * resolves each through an open session: stream the complete bytes straight
 * into durable storage, confirm the folder generation held, then parse and
 * apply what was stored. An original above the maximum message size never
 * becomes a body job — header import already skipped it with an event — and
 * a size that drifted past the bound is skipped the same way here. A stream
 * that itself crosses the bound is routed to the same skip, and an original
 * that will not parse lands in a bounded failed state instead of retrying
 * every cycle.
 */

/** The ingestion surface the body fetch needs; tests stub exactly this. */
export interface BodyIngestion {
  stageOriginal(input: { messageId: string; source: AsyncIterable<Uint8Array>; expectedSize: number | null }): Promise<StagedOriginal>;
  applyStagedOriginal(input: { accountId: string; messageId: string; staged: StagedOriginal }): Promise<IngestResult>;
}

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
  | {
      /** The server now reports a size above the maximum; nothing was read. */
      state: "skipped_oversized";
      messageId: string;
      sizeBytes: number;
    }
  | {
      /** The stored original will not parse; the row carries a bounded failure. */
      state: "failed";
      messageId: string;
    }
  | { state: "generation_changed"; messageId: string; recorded: number; observed: number };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BodyFetchService {
  constructor(
    private readonly db: MailHubDatabase,
    private readonly ingestion: BodyIngestion,
  ) {}

  /**
   * How many body jobs remain for one account. Sync status reports this count
   * separately from header progress (SPEC F2 reconciliation).
   */
  async pendingBodyCount(accountId: string): Promise<number> {
    requireUuid("account id", accountId);
    const rows = await this.db
      .select({ count: sql<number>`count(distinct ${messages.id})::int` })
      .from(messages)
      .innerJoin(
        messageOccurrences,
        and(
          eq(messageOccurrences.messageId, messages.id),
          eq(messageOccurrences.accountId, messages.accountId),
        ),
      )
      .innerJoin(folders, eq(folders.id, messageOccurrences.folderId))
      .where(pendingBodyConditions(accountId));
    return rows[0]?.count ?? 0;
  }

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
   * read only after the folder generation matches the occurrence's, they are
   * streamed into durable storage without passing through a whole-message
   * buffer, and they are applied only after the generation is confirmed to
   * have held.
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
    const download = await session.streamOriginal(target.occurrence.uid);
    if (download === null) {
      // Expunged on the server. The row stays pending; reconciliation owns
      // expunge marking (SPEC F2 steady state).
      return { state: "missing", messageId: pending.messageId };
    }
    if (download.expectedSize !== null && download.expectedSize > MAX_MESSAGE_BYTES) {
      // The recorded size was inside the bound but the message grew, or the
      // server misreported it at import time. Record the observed size so
      // the row stops qualifying as a body job, the way import-time skipping
      // would have (SPEC section 10).
      download.discard();
      await this.skipOversized(accountId, target.message.id, download.expectedSize);
      return { state: "skipped_oversized", messageId: pending.messageId, sizeBytes: download.expectedSize };
    }
    let staged;
    try {
      staged = await this.ingestion.stageOriginal({
        messageId: target.message.id,
        source: download.chunks,
        expectedSize: download.expectedSize,
      });
    } catch (cause) {
      if (cause instanceof IngestionError && cause.code === "message_too_large") {
        // The server reported a size inside the bound but the stream itself
        // crossed it mid-download. The same size policy applies: record the
        // crossing point and stop qualifying, or every cycle re-downloads up
        // to the bound for a message that can never be parsed here.
        download.discard();
        const crossed = cause.sizeBytes ?? MAX_MESSAGE_BYTES + 1;
        await this.skipOversized(accountId, target.message.id, crossed);
        return { state: "skipped_oversized", messageId: pending.messageId, sizeBytes: crossed };
      }
      throw cause;
    }
    const recheck = await session.revalidate();
    if (recheck.uidValidity !== target.occurrence.uidvalidity) {
      // The staged object stays unreferenced and waits for garbage
      // collection; the next fetch of this job stages again.
      return {
        state: "generation_changed",
        messageId: pending.messageId,
        recorded: target.occurrence.uidvalidity,
        observed: recheck.uidValidity,
      };
    }

    let result;
    try {
      result = await this.ingestion.applyStagedOriginal({
        accountId,
        messageId: target.message.id,
        staged,
      });
    } catch (cause) {
      if (cause instanceof IngestionError && cause.code === "parse_failed") {
        // A parse failure is deterministic: the stored bytes parse the same
        // way every time, so an endless retry would only re-download what
        // storage already holds. The row carries the bounded failure and one
        // event names it; the headers stay imported and readable.
        await this.markBodyFailed(accountId, target.message.id, cause.code);
        return { state: "failed", messageId: pending.messageId };
      }
      throw cause;
    }
    return {
      state: "fetched",
      messageId: pending.messageId,
      survivorId: result.messageId,
      removedMessageId: result.removedMessageId,
      sha256: result.sha256,
    };
  }

  /**
   * Record one size-policy skip: the observed size moves onto the message
   * row, so it no longer qualifies as a body job, and one audit event names
   * the bound that applied. The headers stay imported and readable.
   */
  private async skipOversized(accountId: string, messageId: string, sizeBytes: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ sizeBytes })
        .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId)));
      await tx.insert(events).values({
        actor: "system",
        type: "message.body_skipped",
        entityType: "message",
        entityId: messageId,
        payload: { accountId, sizeBytes, maxBytes: MAX_MESSAGE_BYTES },
      });
    });
  }

  /**
   * Record one bounded body failure. The row stops qualifying as a body job
   * and one audit event names the failure kind — the code alone, never the
   * parser text, so no message content reaches the trail.
   */
  private async markBodyFailed(accountId: string, messageId: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({ bodyFailedAt: new Date() })
        .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId)));
      await tx.insert(events).values({
        actor: "system",
        type: "message.body_failed",
        entityType: "message",
        entityId: messageId,
        payload: { accountId, reason },
      });
    });
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
    // A deterministic failure is decided; the row is not a job anymore.
    isNull(messages.bodyFailedAt),
    isNull(messageOccurrences.expungedAt),
    isNull(messageOccurrences.invalidatedAt),
    // Only the current folder generation resolves UIDs.
    eq(folders.uidvalidity, messageOccurrences.uidvalidity),
    // Messages above the maximum size stay header-only: parsing one would
    // hold more than the deployment can spare (SPEC section 10). A size the
    // server never reported cannot be judged yet, so it stays fetchable and
    // the stream itself enforces the bound.
    or(isNull(messages.sizeBytes), lte(messages.sizeBytes, MAX_MESSAGE_BYTES)),
  );
}

function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new SyncError("invalid_request", `${kind} must be a UUID: ${id}`);
  }
}
