import { and, desc, eq, sql } from "drizzle-orm";
import {
  messages,
  threads,
  type EmailAddress,
  type MailHubDatabase,
  type Message,
  type Recipients,
  type ThreadLinkState,
} from "@mail-hub/database";
import { normalizeIndexText } from "@mail-hub/ingestion";
import type { MailHubTransaction } from "@mail-hub/recovery";
import { SyncError } from "./errors.ts";
import { recordAccountEvent, requireUuid } from "./store.ts";

/**
 * Logical-message threading (SPEC F2 "Message identity and threading").
 *
 * A message's parent comes only from its identifiers: the single valid
 * `In-Reply-To` identifier, or when that is absent the last valid identifier
 * in `References`. Subject and participant matches never create a link. One
 * holder of the identifier links; no holder leaves the message pending, and
 * multiple identifiers, self-links, duplicate holders, or a cycle leave it
 * unlinked and ambiguous. Threads belong to one account: holders in another
 * account never parent a message.
 *
 * The work is durable and repeatable. Rows carry the job (`thread_dirty`);
 * every transaction that changes identifiers marks what it touched, and one
 * bounded pass resolves each marked row in its own transaction — decide the
 * link, then move the row and its descendants to the thread of their chain
 * root — so a crash repeats the work instead of losing it.
 */

/** Thread jobs one pass resolves per account, newest first. */
export const DEFAULT_THREAD_BATCH = 100;

/** Chains longer than this are treated as a cycle rather than walked forever. */
const MAX_CHAIN_DEPTH = 1000;

/** Participants stored on one thread row; long recipient lists truncate. */
const MAX_PARTICIPANTS = 50;

/**
 * A bracketed message identifier: `<` then any run without whitespace or
 * brackets, then `>`. This matches the exact strings the header parse and the
 * full parse both store, including identifiers a strict grammar would reject,
 * so a child and its holder always compare the same text.
 */
const MESSAGE_ID_PATTERN = /<[^\s<>]+>/g;

/** What a message's reference headers resolve to, before holders are known. */
export type ParentReference =
  | { state: "root" }
  /** Exactly one candidate identifier; holder lookup decides the rest. */
  | { state: "candidate"; identifier: string }
  /** More than one parent identifier; no safe choice exists. */
  | { state: "conflicted" };

/** The identifiers of one raw header value, in order, deduplicated. */
export function extractMessageIds(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.length === 0) {
    return [];
  }
  const ids: string[] = [];
  for (const match of raw.matchAll(MESSAGE_ID_PATTERN)) {
    const id = match[0]!;
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Resolve the parent reference of one message (SPEC F2): the single valid
 * `In-Reply-To` identifier, otherwise the last valid identifier in
 * `References`, otherwise a root.
 */
export function resolveParentReference(
  inReplyTo: string | null,
  referenceIds: string[],
): ParentReference {
  const replies = extractMessageIds(inReplyTo);
  if (replies.length > 1) {
    return { state: "conflicted" };
  }
  if (replies.length === 1) {
    return { state: "candidate", identifier: replies[0]! };
  }
  const references = referenceIds.flatMap((id) => extractMessageIds(id));
  const last = references.at(-1);
  return last === undefined ? { state: "root" } : { state: "candidate", identifier: last };
}

/** What one reconciliation pass over an account did. */
export interface ThreadReconciliationSummary {
  accountId: string;
  /** Dirty rows this pass resolved. */
  examined: number;
  /** Rows left in each link state after the pass. */
  linked: number;
  roots: number;
  pending: number;
  ambiguous: number;
  /** Rows whose link state or parent changed. */
  linksChanged: number;
  /** Previously linked rows whose link was removed as unsafe. */
  unlinked: number;
  threadsCreated: number;
  /** Rows moved onto their chain root's thread, subtree propagation included. */
  reassigned: number;
  /** Dirty rows still waiting after this pass. */
  remaining: number;
  /** Thread rows deleted because nothing references them anymore. */
  threadsPruned: number;
}

/** What resolving one row did. */
interface RowOutcome {
  messageId: string;
  state: ThreadLinkState;
  parentId: string | null;
  changed: boolean;
  unlinked: boolean;
  threadsCreated: number;
  reassigned: number;
}

export interface ThreadOptions {
  /** Dirty rows one pass resolves. */
  batchLimit?: number;
}

export class ThreadService {
  private readonly batchLimit: number;

  constructor(
    private readonly db: MailHubDatabase,
    options: ThreadOptions = {},
  ) {
    const batchLimit = options.batchLimit ?? DEFAULT_THREAD_BATCH;
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1) {
      throw new SyncError("invalid_request", "The thread batch limit must be a positive integer.");
    }
    this.batchLimit = batchLimit;
  }

  /** How many thread jobs remain for one account. Sync status reports it. */
  async pendingCount(accountId: string): Promise<number> {
    requireUuid("account id", accountId);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.threadDirty, true)));
    return rows[0]?.count ?? 0;
  }

  /**
   * Resolve one bounded batch of thread jobs, newest first. Each row resolves
   * in its own transaction and clears its own mark, so a crash between rows
   * keeps the finished work and repeats only the rest.
   */
  async reconcileAccount(accountId: string, limit?: number): Promise<ThreadReconciliationSummary> {
    requireUuid("account id", accountId);
    const batch = limit === undefined ? this.batchLimit : limit;
    if (!Number.isSafeInteger(batch) || batch < 1) {
      throw new SyncError("invalid_request", "The thread batch limit must be a positive integer.");
    }

    const dirty = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.threadDirty, true)))
      .orderBy(desc(messages.sentAt))
      .limit(batch);

    const summary: ThreadReconciliationSummary = {
      accountId,
      examined: 0,
      linked: 0,
      roots: 0,
      pending: 0,
      ambiguous: 0,
      linksChanged: 0,
      unlinked: 0,
      threadsCreated: 0,
      reassigned: 0,
      remaining: 0,
      threadsPruned: 0,
    };
    for (const target of dirty) {
      const outcome = await this.reconcileRow(accountId, target.id);
      if (outcome === null) {
        continue;
      }
      summary.examined += 1;
      summary.linksChanged += outcome.changed ? 1 : 0;
      summary.unlinked += outcome.unlinked ? 1 : 0;
      summary.threadsCreated += outcome.threadsCreated;
      summary.reassigned += outcome.reassigned;
      if (outcome.state === "linked") {
        summary.linked += 1;
      } else if (outcome.state === "root") {
        summary.roots += 1;
      } else if (outcome.state === "pending") {
        summary.pending += 1;
      } else {
        summary.ambiguous += 1;
      }
    }

    summary.threadsPruned = await this.pruneDetachedThreads(accountId);
    summary.remaining = await this.pendingCount(accountId);
    if (summary.examined > 0 || summary.threadsPruned > 0) {
      await recordAccountEvent(this.db, accountId, "sync.thread_reconciliation", { ...summary });
    }
    return summary;
  }

  /**
   * Delete thread rows nothing references anymore. A row that loses its last
   * message — every member moved to another thread, or a detached row started
   * a fresh one — stays behind otherwise, because the drafts and snapshots of
   * SPEC section 8 may still point at the old thread when the link moves. A
   * referenced thread is never touched; the pass is bounded so one account's
   * history cannot hold the cycle.
   */
  async pruneDetachedThreads(accountId: string, limit = 500): Promise<number> {
    requireUuid("account id", accountId);
    const result = await this.db.execute(sql`
      with doomed as (
        select t.id from threads t
        where t.account_id = ${accountId}
          and not exists (select 1 from messages m where m.thread_id = t.id)
          and not exists (select 1 from drafts d where d.thread_id = t.id)
          and not exists (select 1 from outbound_messages o where o.thread_id = t.id)
        limit ${limit}
      )
      delete from threads t
      where t.id in (select id from doomed)
      returning t.id
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Resolve one dirty row. The row is locked for the whole decision, so a
   * concurrent pass cannot resolve it twice; a lock conflict between two
   * passes aborts one transaction and leaves its row dirty for the next pass.
   */
  private async reconcileRow(accountId: string, messageId: string): Promise<RowOutcome | null> {
    return this.db.transaction(async (tx) => {
      // Two passes that resolve the two directions of the same pair each read
      // one row with no parent yet — the other pass's link is uncommitted —
      // so both commit and the pair becomes a parent cycle nothing repairs.
      // Every decision for one account queues on this lock, so a later pass
      // reads the earlier pass's committed links. The lock is taken before
      // any row lock, so passes cannot deadlock on the pair of locks.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`threads.${accountId}`})::bigint)`,
      );
      const rows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.accountId, accountId)))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (row === undefined || !row.threadDirty) {
        // It merged away, or another pass already resolved it.
        return null;
      }

      const decision = await decideLink(tx, accountId, row);
      const changed = row.threadLinkState !== decision.state || row.parentMessageId !== decision.parentId;
      const unlinked = row.threadLinkState === "linked" && decision.state !== "linked";
      if (changed) {
        await tx
          .update(messages)
          .set({ parentMessageId: decision.parentId, threadLinkState: decision.state })
          .where(eq(messages.id, row.id));
      }

      // Links and membership commit together: the row joins the thread of its
      // chain root, and its descendants move with it (SPEC F2).
      const root = await chainRoot(tx, accountId, row.id);
      // A row that just lost its parent is its own chain root again, but the
      // thread it carries came from that parent. It starts a fresh thread so
      // membership matches the links; the old thread record stays behind for
      // the drafts and snapshots that still reference it (SPEC section 8).
      const detached = root.id === row.id && row.parentMessageId !== null && decision.parentId === null;
      let threadsCreated = 0;
      let threadId = detached ? null : root.threadId;
      // The re-read only applies to a root the row does not stand in for: a
      // detached row must not rejoin the thread it inherited from its parent.
      if (threadId === null && !detached) {
        const locked = await tx
          .select({ threadId: messages.threadId })
          .from(messages)
          .where(and(eq(messages.id, root.id), eq(messages.accountId, accountId)))
          .for("update")
          .limit(1);
        threadId = locked[0]?.threadId ?? null;
      }
      if (threadId === null) {
        const created = await tx
          .insert(threads)
          .values({
            accountId,
            subjectNorm: root.subject === null ? null : normalizeIndexText(root.subject),
            participants: threadParticipants(root.sender, root.recipients),
          })
          .returning({ id: threads.id });
        threadId = created[0]!.id;
        await tx.update(messages).set({ threadId }).where(eq(messages.id, root.id));
        threadsCreated = 1;
      }

      const reassigned = await propagateThread(tx, accountId, row.id, threadId);
      if (reassigned > 0) {
        await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
      }

      await tx.update(messages).set({ threadDirty: false }).where(eq(messages.id, row.id));
      return {
        messageId: row.id,
        state: decision.state,
        parentId: decision.parentId,
        changed,
        unlinked,
        threadsCreated,
        reassigned,
      };
    });
  }
}

/** The link decision for one row, from its references and the current holders. */
type LinkDecision =
  | { state: "root"; parentId: null }
  | { state: "pending"; parentId: null }
  | { state: "ambiguous"; parentId: null }
  | { state: "linked"; parentId: string };

/**
 * Decide one row's parent link. Subject and participants play no part. The
 * decision reads holders without locking them; an identifier change commits
 * its own marks with the change, so a decision taken against a moving holder
 * set is re-decided on the next pass.
 */
async function decideLink(
  tx: MailHubTransaction,
  accountId: string,
  row: Pick<Message, "id" | "messageId" | "inReplyTo" | "referenceIds">,
): Promise<LinkDecision> {
  const reference = resolveParentReference(row.inReplyTo, row.referenceIds);
  if (reference.state === "root") {
    return { state: "root", parentId: null };
  }
  if (reference.state === "conflicted") {
    return { state: "ambiguous", parentId: null };
  }
  const identifier = reference.identifier;
  if (row.messageId === identifier) {
    // The row names itself: a self-link stays unlinked and flagged.
    return { state: "ambiguous", parentId: null };
  }

  const holders = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.messageId, identifier)))
    .orderBy(messages.id);
  if (holders.length === 0) {
    // A missing parent is pending, never permanently unlinked (SPEC F2).
    return { state: "pending", parentId: null };
  }
  if (holders.length > 1) {
    return { state: "ambiguous", parentId: null };
  }

  const parentId = holders[0]!.id;
  if (parentId === row.id || (await chainReaches(tx, accountId, parentId, row.id))) {
    // Linking would close a cycle; cycles stay unlinked and flagged.
    return { state: "ambiguous", parentId: null };
  }
  return { state: "linked", parentId };
}

/** Whether walking parents from `startId` reaches `targetId`. */
async function chainReaches(
  tx: MailHubTransaction,
  accountId: string,
  startId: string,
  targetId: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let current: string | null = startId;
  while (current !== null && seen.size < MAX_CHAIN_DEPTH) {
    if (current === targetId) {
      return true;
    }
    seen.add(current);
    const rows = await tx
      .select({ parentId: messages.parentMessageId })
      .from(messages)
      .where(and(eq(messages.id, current), eq(messages.accountId, accountId)))
      .limit(1);
    current = rows[0]?.parentId ?? null;
  }
  return false;
}

/** One row of a parent chain, with the fields thread creation needs. */
interface ChainRow {
  id: string;
  parentId: string | null;
  threadId: string | null;
  subject: string | null;
  sender: EmailAddress | null;
  recipients: Recipients | null;
}

/**
 * The chain root of one row: follow parents until one has none. Depth and a
 * visited set bound the walk; a chain that exceeds them treats its newest
 * reached row as the root, which keeps membership assignable even though no
 * validated link can ever form a cycle.
 */
async function chainRoot(tx: MailHubTransaction, accountId: string, startId: string): Promise<ChainRow> {
  const columns = {
    id: messages.id,
    parentId: messages.parentMessageId,
    threadId: messages.threadId,
    subject: messages.subject,
    sender: messages.sender,
    recipients: messages.recipients,
  };
  const seen = new Set<string>();
  let currentId = startId;
  let last: ChainRow | null = null;
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth += 1) {
    if (seen.has(currentId)) {
      break;
    }
    seen.add(currentId);
    const rows = await tx
      .select(columns)
      .from(messages)
      .where(and(eq(messages.id, currentId), eq(messages.accountId, accountId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      break;
    }
    last = row;
    if (row.parentId === null) {
      return row;
    }
    currentId = row.parentId;
  }
  // The chain ran past the depth bound or met itself: the newest row reached
  // stands in as the root so the walk always answers.
  return last ?? { id: startId, parentId: null, threadId: null, subject: null, sender: null, recipients: null };
}

/**
 * Move one row and every descendant onto their chain root's thread. The
 * recursive walk deduplicates, so it terminates even if a corrupted chain
 * loops, and rows already on the target thread are left untouched.
 */
async function propagateThread(
  tx: MailHubTransaction,
  accountId: string,
  rowId: string,
  threadId: string,
): Promise<number> {
  const result = await tx.execute(sql`
    with recursive subtree as (
      select m.id from messages m where m.id = ${rowId} and m.account_id = ${accountId}
      union
      select c.id from messages c join subtree s on c.parent_message_id = s.id
    )
    update messages m
    set thread_id = ${threadId}
    where m.account_id = ${accountId}
      and m.id in (select id from subtree)
      and m.thread_id is distinct from ${threadId}
    returning m.id
  `);
  return result.rowCount ?? 0;
}

/** The participants of one thread, seeded from its root: sender, then visible recipients. */
function threadParticipants(sender: EmailAddress | null, recipients: Recipients | null): EmailAddress[] {
  const participants: EmailAddress[] = [];
  const seen = new Set<string>();
  const add = (address: EmailAddress | null): void => {
    if (address === null || seen.has(address.address)) {
      return;
    }
    seen.add(address.address);
    participants.push(address);
  };
  add(sender);
  if (recipients !== null) {
    for (const address of [...recipients.to, ...(recipients.cc ?? [])]) {
      add(address);
    }
  }
  return participants.slice(0, MAX_PARTICIPANTS);
}
