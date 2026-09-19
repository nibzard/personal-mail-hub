import { ImapFlow } from "imapflow";
import type {
  ActionMailboxCapabilities,
  FlagWriteRequest,
  FlagWriteResult,
  MoveWriteRequest,
  MoveWriteResult,
  WritableActionMailbox,
} from "@mail-hub/actions";
import { resolveTimeouts, verifiedTlsOptions } from "@mail-hub/transport";
import { SyncError } from "./errors.ts";
import {
  IMPORTED_HEADER_FIELDS,
  type AppendMessageResult,
  type MailboxConnection,
  type MailboxFlags,
  type MailboxHeaders,
  type MailboxSession,
  type MailboxSessionFactory,
  type MailboxState,
  type SentCopyMailboxSession,
} from "./mailbox.ts";

/**
 * The ImapFlow-backed mailbox session (SPEC F2 and section 9).
 *
 * IMAP is implicit TLS only. The handshake, with certificate-chain and
 * hostname validation, completes before the login is written, so a server
 * that cannot prove its certificate never sees the username or password.
 * Every fetch uses `BODY.PEEK`, so importing a mailbox never sets `\Seen`.
 * Failures surface as `SyncError` messages without credentials or content.
 *
 * The session also carries the two-way writes of the action path (SPEC F2
 * and F4). They run only through the action executor, on a session opened
 * with `condstoreWrites` so conditional `UNCHANGEDSINCE` stores are possible;
 * synchronization itself keeps reading and never writes. The Sent-copy
 * operations of the outbound pipeline (SPEC F7 step 5) ride the same
 * connection: an append of exact stored bytes, and the header search that
 * locates a copy for verification.
 */

/** Options that shape the session one `open` call returns. */
export interface MailboxSessionOptions {
  /**
   * Let ImapFlow enable advertised extensions after login. The action path
   * needs this so the server turns CONDSTORE on for the session, which every
   * conditional write and modseq-bearing fetch depends on. Synchronization
   * sessions keep it off; their reads never consult modification sequences.
   */
  condstoreWrites?: boolean;
}

/** Opens one ImapFlow connection per call. */
export class ImapMailboxSessionFactory implements MailboxSessionFactory {
  async open(connection: MailboxConnection, options: MailboxSessionOptions = {}): Promise<ImapMailboxSession> {
    const timeouts = resolveTimeouts(connection.timeouts);
    const client = new ImapFlow({
      host: connection.host,
      port: connection.port,
      // Implicit TLS only. There is no plaintext or upgrade path (SPEC F1).
      secure: true,
      auth: { user: connection.username, pass: connection.password },
      tls: verifiedTlsOptions(connection.trustedCaPem),
      // Sync drives its own command cadence; no automatic IDLE and no
      // transparent extension enablement between batches. A write session
      // lets the one post-login ENABLE through, and nothing else changes.
      disableAutoIdle: true,
      disableAutoEnable: options.condstoreWrites !== true,
      connectionTimeout: timeouts.connectMs,
      greetingTimeout: timeouts.greetingMs,
      socketTimeout: timeouts.socketMs,
      logger: false,
    });

    try {
      // connect() covers the TLS handshake, the greeting, and the login.
      // With `secure` set, a rejected certificate fails before any command,
      // including the login, reaches the socket.
      await client.connect();
    } catch (cause) {
      client.close();
      throw new SyncError(
        "mailbox_error",
        `The IMAP connection could not be opened: ${describe(cause)}`,
      );
    }
    return new ImapMailboxSession(client);
  }
}

/** One mailbox session over one open ImapFlow connection. */
export class ImapMailboxSession implements MailboxSession, WritableActionMailbox, SentCopyMailboxSession {
  private currentPath: string | null = null;

  constructor(private readonly client: ImapFlow) {}

  async select(folder: string): Promise<MailboxState> {
    const mailbox = await this.guard("select", (client) => client.mailboxOpen(folder));
    this.currentPath = mailbox.path;
    return { uidValidity: Number(mailbox.uidValidity), uidNext: mailbox.uidNext };
  }

  async searchUids(low: number, high: number): Promise<number[]> {
    const found = await this.guard("search", (client) =>
      client.search({ uid: `${low}:${high}` }, { uid: true }),
    );
    // ImapFlow answers `false` when the connection carries no selected
    // mailbox; the session always has one, but an empty list is the safe read.
    return (Array.isArray(found) ? found : []).slice().sort((a, b) => a - b);
  }

  async fetchHeaders(uids: number[]): Promise<MailboxHeaders[]> {
    if (uids.length === 0) {
      return [];
    }
    const records: MailboxHeaders[] = [];
    // The async generator resolves once the response stream ends; collection
    // here keeps the caller free of ImapFlow types.
    for await (const message of this.client.fetch(
      uids,
      {
        uid: true,
        flags: true,
        internalDate: true,
        size: true,
        headers: [...IMPORTED_HEADER_FIELDS],
      },
      { uid: true },
    )) {
      records.push({
        uid: message.uid,
        unread: !(message.flags ?? new Set()).has("\\Seen"),
        flagged: (message.flags ?? new Set()).has("\\Flagged"),
        internalDate: toDate(message.internalDate),
        sizeBytes: message.size ?? 0,
        rawHeaders: message.headers ?? new Uint8Array(0),
      });
    }
    return records;
  }

  async fetchFlags(uids: number[]): Promise<MailboxFlags[]> {
    if (uids.length === 0) {
      return [];
    }
    const records: MailboxFlags[] = [];
    for await (const message of this.client.fetch(
      uids,
      { uid: true, flags: true },
      { uid: true },
    )) {
      records.push({
        uid: message.uid,
        unread: !(message.flags ?? new Set()).has("\\Seen"),
        flagged: (message.flags ?? new Set()).has("\\Flagged"),
        // A CONDSTORE session answers every fetch with a modification
        // sequence; without one the field stays absent (SPEC F2).
        ...(message.modseq === undefined ? {} : { modseq: message.modseq.toString() }),
      });
    }
    return records;
  }

  async fetchOriginal(uid: number): Promise<Uint8Array | null> {
    const message = await this.guard("fetch", (client) =>
      client.fetchOne(String(uid), { source: true }, { uid: true }),
    );
    if (message === false || message === undefined) {
      return null;
    }
    // A message that exists always has bytes; a zero-length answer means the
    // server answered with nothing usable.
    if (message.source === undefined || message.source.byteLength === 0) {
      return null;
    }
    return message.source;
  }

  async revalidate(): Promise<MailboxState> {
    if (this.currentPath === null) {
      throw new SyncError("mailbox_error", "No mailbox is selected to revalidate.");
    }
    return this.select(this.currentPath);
  }

  async capabilities(): Promise<ActionMailboxCapabilities> {
    const mailbox = this.client.mailbox;
    return {
      // Conditional stores need the extension enabled on the session and a
      // selected folder that reports modification sequences at all.
      condstore:
        this.client.enabled.has("CONDSTORE") &&
        mailbox !== false &&
        mailbox.noModseq !== true,
      move: this.client.capabilities.has("MOVE"),
    };
  }

  async writeFlag(request: FlagWriteRequest): Promise<FlagWriteResult> {
    if (this.currentPath === null) {
      throw new SyncError("mailbox_error", "No mailbox is selected to write flags to.");
    }
    const keyword = IMAP_FLAGS[request.flag];
    const range = String(request.uid);
    const options = {
      uid: true,
      ...(request.unchangedSince === null ? {} : { unchangedSince: BigInt(request.unchangedSince) }),
    };
    try {
      const ok = request.value
        ? await this.client.messageFlagsAdd(range, [keyword], options)
        : await this.client.messageFlagsRemove(range, [keyword], options);
      if (ok === true) {
        return { result: "accepted" };
      }
      // ImapFlow folds a failed command into `false` without saying whether
      // the tagged response arrived, so a dead connection reads as a lost
      // response and everything else as a definitive rejection.
      return this.unusable() ? uncertain("The flag write response was lost.") : { result: "rejected" };
    } catch (cause) {
      return uncertain(describe(cause));
    }
  }

  async moveMessage(request: MoveWriteRequest): Promise<MoveWriteResult> {
    if (this.currentPath === null) {
      throw new SyncError("mailbox_error", "No mailbox is selected to move from.");
    }
    if (!this.client.capabilities.has("MOVE")) {
      // This version defines no copy-and-expunge fallback (SPEC F4).
      return { result: "rejected" };
    }
    try {
      const moved = await this.client.messageMove(String(request.uid), request.destinationFolder, {
        uid: true,
      });
      if (!moved) {
        return this.unusable() ? uncertain("The move response was lost.") : { result: "rejected" };
      }
      return {
        result: "moved",
        destination: {
          folder: moved.destination,
          uidvalidity: moved.uidValidity === undefined ? null : Number(moved.uidValidity),
          // UIDPLUS servers map the source UID to its destination UID.
          uid: moved.uidMap?.get(request.uid) ?? null,
        },
      };
    } catch (cause) {
      return uncertain(describe(cause));
    }
  }

  async searchByMessageId(rfcMessageId: string): Promise<number[]> {
    // A header search locates candidates for the Sent-copy reconciliation
    // (SPEC F7 step 5). The match is a substring one, so the caller verifies
    // candidate bytes before trusting any hit.
    const found = await this.guard("search", (client) =>
      client.search({ header: { "message-id": rfcMessageId } }, { uid: true }),
    );
    return (Array.isArray(found) ? found : []).slice().sort((a, b) => a - b);
  }

  async appendMessage(folder: string, bytes: Uint8Array): Promise<AppendMessageResult> {
    try {
      // A stored copy is mail its author already read (SPEC F7 step 5).
      const appended = await this.client.append(folder, toBuffer(bytes), ["\\Seen"]);
      if (appended === false) {
        // ImapFlow folds a failed command into `false` without saying whether
        // the tagged response arrived; a dead connection reads as a lost
        // response and everything else as a definitive rejection.
        return this.unusable() ? uncertain("The append response was lost.") : { result: "rejected" };
      }
      return {
        result: "appended",
        // Destination coordinates need the UIDPLUS extension; without them the
        // caller reconciles the location with a header search.
        uidvalidity: appended.uidValidity === undefined ? null : Number(appended.uidValidity),
        uid: appended.uid ?? null,
      };
    } catch (cause) {
      if (taggedNo(cause)) {
        // A tagged `NO` is the server stating it stored nothing: a definitive
        // refusal, not a lost response (SPEC F7 step 5).
        return { result: "rejected" };
      }
      return uncertain(describe(cause));
    }
  }

  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch (cause) {
      // A logout that fails still ended the session; drop the connection.
      this.client.close();
      throw new SyncError("mailbox_error", `The IMAP logout failed: ${describe(cause)}`);
    }
  }

  /** Run one client call and map its failure to a `SyncError`. */
  private async guard<T>(
    step: string,
    call: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(this.client);
    } catch (cause) {
      throw new SyncError("mailbox_error", `The IMAP ${step} failed: ${describe(cause)}`);
    }
  }

  private unusable(): boolean {
    return this.client.usable !== true;
  }
}

/** The wire keyword each tracked flag maps to. */
const IMAP_FLAGS = { unread: "\\Seen", flagged: "\\Flagged" } as const;

/** Message content as the append API wants it, without a copy when possible. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function uncertain(reason: string): { result: "uncertain"; reason: string } {
  return { result: "uncertain", reason };
}

/**
 * Whether one thrown ImapFlow error carries a tagged `NO`, the server's own
 * definitive refusal of the command. Everything else — timeouts, resets, lost
 * connections — stays uncertain.
 */
function taggedNo(cause: unknown): boolean {
  return (cause as { responseStatus?: unknown } | null | undefined)?.responseStatus === "NO";
}

/** An internal date the server reported as a string instead of a Date. */
function toDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

/** One failure line without credentials, message content, or stack noise. */
function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message ? cause.message : cause.name;
  }
  return String(cause);
}
