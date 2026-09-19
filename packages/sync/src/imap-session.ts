import { ImapFlow } from "imapflow";
import { resolveTimeouts, verifiedTlsOptions } from "@mail-hub/transport";
import { SyncError } from "./errors.ts";
import {
  IMPORTED_HEADER_FIELDS,
  type MailboxConnection,
  type MailboxHeaders,
  type MailboxSession,
  type MailboxSessionFactory,
  type MailboxState,
} from "./mailbox.ts";

/**
 * The ImapFlow-backed mailbox session (SPEC F2 and section 9).
 *
 * IMAP is implicit TLS only. The handshake, with certificate-chain and
 * hostname validation, completes before the login is written, so a server
 * that cannot prove its certificate never sees the username or password.
 * Every fetch uses `BODY.PEEK`, so importing a mailbox never sets `\Seen`.
 * Failures surface as `SyncError` messages without credentials or content.
 */

/** Opens one ImapFlow connection per call. */
export class ImapMailboxSessionFactory implements MailboxSessionFactory {
  async open(connection: MailboxConnection): Promise<MailboxSession> {
    const timeouts = resolveTimeouts(connection.timeouts);
    const client = new ImapFlow({
      host: connection.host,
      port: connection.port,
      // Implicit TLS only. There is no plaintext or upgrade path (SPEC F1).
      secure: true,
      auth: { user: connection.username, pass: connection.password },
      tls: verifiedTlsOptions(connection.trustedCaPem),
      // Sync drives its own command cadence; no automatic IDLE and no
      // transparent extension enablement between batches.
      disableAutoIdle: true,
      disableAutoEnable: true,
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
export class ImapMailboxSession implements MailboxSession {
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
