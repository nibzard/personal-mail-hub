import { ImapFlow } from "imapflow";
import type { ImapConnectionReport, ImapFolderReport } from "@mail-hub/contracts";
import { classifyTransportError } from "./classify.ts";
import { resolveTimeouts, verifiedTlsOptions, type ConnectionTimeouts } from "./tls.ts";

/**
 * The verified IMAP connection test (SPEC F1 and section 9).
 *
 * IMAP is implicit TLS only: the TLS handshake, with certificate-chain and
 * hostname validation, completes before the greeting is read, and the login
 * command goes out only after that. A server that cannot prove its
 * certificate never sees the username or password. After login the test
 * discovers the advertised capabilities and lists folders with message
 * counts, then logs out. It moves and reads no mail.
 */

/** Connection settings for the IMAP half of one test. */
export interface ImapTestSettings {
  host: string;
  port: number;
}

/** Credentials and tuning one test needs beyond the host settings. */
export interface TransportTestContext {
  username: string;
  password: string;
  /**
   * PEM certificate authorities the connection trusts instead of the system
   * root store: Node's `ca` option replaces the defaults, it does not extend
   * them. Tests inject their trusted test authority here; nothing in
   * production may use it to weaken validation (SPEC section 12).
   */
  trustedCaPem?: string[];
  timeouts?: Partial<ConnectionTimeouts>;
}

/**
 * Test one IMAP endpoint. Never rejects: every failure comes back as a
 * report, so one protocol's result never hides the other's.
 */
export async function testImapConnection(
  settings: ImapTestSettings,
  context: TransportTestContext,
): Promise<ImapConnectionReport> {
  const timeouts = resolveTimeouts(context.timeouts);
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    // Implicit TLS only. There is no plaintext or upgrade path (SPEC F1).
    secure: true,
    auth: { user: context.username, pass: context.password },
    tls: verifiedTlsOptions(context.trustedCaPem),
    // A connection test changes no session state: no extension enablement,
    // no compression, and no automatic IDLE while the folder list is read.
    disableAutoEnable: true,
    disableCompression: true,
    disableAutoIdle: true,
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    logger: false,
  });

  try {
    // connect() covers the TLS handshake, the greeting, and the login.
    // Because `secure` is true, a rejected certificate fails the handshake
    // before any command — including the login — is written to the socket.
    await client.connect();
  } catch (error) {
    client.close();
    const stage = isAuthenticationFailure(error) ? "authenticate" : "tls";
    return {
      protocol: "imap",
      ok: false,
      stage,
      capabilities: advertisedCapabilities(client),
      folders: [],
      error: classifyTransportError(error, context.password),
    };
  }

  try {
    // One LIST round trip plus per-folder STATUS values give the folder
    // paths, their special-use attributes, and their counts (SPEC F1).
    const listed = await client.list({ statusQuery: { messages: true, unseen: true } });
    await client.logout();
    return {
      protocol: "imap",
      ok: true,
      stage: "inspect",
      capabilities: advertisedCapabilities(client),
      folders: listed.map(toFolderReport),
      error: null,
    };
  } catch (error) {
    client.close();
    return {
      protocol: "imap",
      ok: false,
      stage: "inspect",
      capabilities: advertisedCapabilities(client),
      folders: [],
      error: classifyTransportError(error, context.password),
    };
  }
}

/** The per-folder STATUS values the report keeps, when they were available. */
interface FolderCounts {
  messages?: number;
  unseen?: number;
}

/** Map one ImapFlow list entry to its report form. */
function toFolderReport(folder: {
  path: string;
  specialUse?: string | false;
  status?: FolderCounts | { error?: unknown };
}): ImapFolderReport {
  const status = folder.status !== undefined && isCountStatus(folder.status) ? folder.status : undefined;
  return {
    name: folder.path,
    specialUse: typeof folder.specialUse === "string" && folder.specialUse !== "" ? [folder.specialUse] : [],
    messages: status?.messages ?? null,
    unread: status?.unseen ?? null,
  };
}

/** True when a STATUS payload carries counts rather than a capture error. */
function isCountStatus(status: FolderCounts | { error?: unknown }): status is FolderCounts {
  return typeof (status as FolderCounts).messages === "number" || typeof (status as FolderCounts).unseen === "number";
}

/** The capability names the server advertised, in a stable order. */
function advertisedCapabilities(client: ImapFlow): string[] {
  return [...client.capabilities.keys()].sort();
}

/** True when the library flagged the failure as an authentication rejection. */
function isAuthenticationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { authenticationFailed?: unknown }).authenticationFailed === true;
}
