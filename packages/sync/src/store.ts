import { and, eq, sql } from "drizzle-orm";
import {
  events,
  folders,
  messageOccurrences,
  messages,
  type Folder,
  type MailHubDatabase,
} from "@mail-hub/database";
import { MAX_MESSAGE_BYTES } from "@mail-hub/ingestion";
import type { MailHubTransaction } from "@mail-hub/recovery";
import { SyncError } from "./errors.ts";
import { parseHeaderBlock } from "./headers.ts";
import type { MailboxHeaders } from "./mailbox.ts";

/**
 * Folder and occurrence access shared by every synchronization service.
 *
 * Backfill, steady-state polling, and reconciliation all move the same rows
 * under the same rules: lock the folder row inside the commit, and import one
 * header record exactly the way the first import did, so a replayed window, a
 * repeated poll, and a repaired inventory row are one code path.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One folder of one account, or `SyncError` when it does not exist. */
export async function loadFolder(
  db: MailHubDatabase,
  accountId: string,
  folderId: string,
): Promise<Folder> {
  const rows = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.accountId, accountId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new SyncError("not_found", "No folder of this account exists with that identifier.");
  }
  return row;
}

/** Lock one folder row for a checkpoint write. */
export async function lockFolder(
  tx: MailHubTransaction,
  accountId: string,
  folderId: string,
): Promise<Folder> {
  const rows = await tx
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.accountId, accountId)))
    .for("update")
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new SyncError("not_found", "No folder of this account exists with that identifier.");
  }
  return row;
}

/** Record one folder synchronization milestone. Payloads never contain message content. */
export async function recordFolderEvent(
  handle: MailHubDatabase | MailHubTransaction,
  accountId: string,
  folderId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await handle.insert(events).values({
    actor: "system",
    type,
    entityType: "folder",
    entityId: folderId,
    payload: { accountId, ...payload },
  });
}

/** Record one account synchronization milestone, one per cycle (SPEC F2). */
export async function recordAccountEvent(
  db: MailHubDatabase,
  accountId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    actor: "system",
    type,
    entityType: "account",
    entityId: accountId,
    payload: { accountId, ...payload },
  });
}

/** The newest time one event type was recorded for one folder, or `null`. */
export async function lastFolderEventAt(
  db: MailHubDatabase,
  folderId: string,
  type: string,
): Promise<Date | null> {
  const rows = await db
    .select({ at: sql<Date | string | null>`max(${events.at})` })
    .from(events)
    .where(and(eq(events.type, type), eq(events.entityId, folderId)));
  const at = rows[0]?.at ?? null;
  if (at === null) {
    return null;
  }
  // The aggregate returns whatever the driver chose to give; a raw string is
  // as likely as a Date.
  return at instanceof Date ? at : new Date(at);
}

/**
 * Import one header record into one folder generation. The result names
 * whether the record imported and the `Message-ID` it carried, so the caller
 * marks thread jobs for a whole window with one call instead of one per
 * record. A replayed range imports nothing and reports `null`.
 */
export async function importHeaderRecord(
  tx: MailHubTransaction,
  accountId: string,
  folderId: string,
  uidvalidity: number,
  record: MailboxHeaders,
): Promise<{ imported: boolean; identifier: string | null }> {
  const existing = await tx
    .select({ id: messageOccurrences.id })
    .from(messageOccurrences)
    .where(
      and(
        eq(messageOccurrences.folderId, folderId),
        eq(messageOccurrences.uidvalidity, uidvalidity),
        eq(messageOccurrences.uid, record.uid),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { imported: false, identifier: null };
  }

  const header = await parseHeaderBlock(record.rawHeaders);
  const inserted = await tx
    .insert(messages)
    .values({
      accountId,
      messageId: header.messageId,
      inReplyTo: header.inReplyTo,
      referenceIds: header.referenceIds,
      // Provisional until thread reconciliation links it (SPEC F2).
      threadLinkState: "pending",
      sender: header.sender,
      replyTo: header.replyTo,
      recipients: header.recipients,
      subject: header.subject,
      sentAt: header.sentAt ?? record.internalDate,
      sizeBytes: record.sizeBytes,
      senderText: header.senderText,
      recipientsText: header.recipientsText,
      addressesText: header.addressesText,
      subjectText: header.subjectText,
    })
    .returning({ id: messages.id });
  await tx.insert(messageOccurrences).values({
    accountId,
    messageId: inserted[0]!.id,
    folderId,
    uidvalidity,
    uid: record.uid,
    internalDate: record.internalDate,
    unread: record.unread,
    flagged: record.flagged,
  });

  // A message the server already reports above the maximum size keeps its
  // headers and occurrence, but its body is never fetched: parsing it would
  // hold more memory than the deployment shares (SPEC section 10). The event
  // is the audit record of that decision, taken once at import.
  if (record.sizeBytes > MAX_MESSAGE_BYTES) {
    await tx.insert(events).values({
      actor: "system",
      type: "message.body_skipped",
      entityType: "message",
      entityId: inserted[0]!.id,
      payload: { accountId, folderId, uid: record.uid, sizeBytes: record.sizeBytes, maxBytes: MAX_MESSAGE_BYTES },
    });
  }

  return { imported: true, identifier: header.messageId };
}

/** Reject an identifier that is not a UUID before it reaches the database. */
export function requireUuid(kind: string, id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new SyncError("invalid_request", `${kind} must be a UUID: ${id}`);
  }
}
