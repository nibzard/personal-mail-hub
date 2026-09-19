import type { ConnectionTestResponse, SmtpSecurityMode } from "@mail-hub/contracts";
import { testImapConnection, type ImapTestSettings, type TransportTestContext } from "./imap.ts";
import { testSmtpConnection, type SmtpTestSettings } from "./smtp.ts";
import type { ConnectionTimeouts } from "./tls.ts";

/**
 * Runs the two protocol tests of one connection test together (SPEC F1).
 *
 * Each protocol is tested separately: the halves run on independent
 * connections and neither can cancel the other, so the report always says
 * what IMAP did and what SMTP did. Both testers resolve instead of
 * rejecting, so a failure in one half is data, not an exception.
 */

/** Everything one connection test needs, mirroring one account's settings. */
export interface ConnectionTestRequest extends TransportTestContext {
  imap: ImapTestSettings;
  smtp: SmtpTestSettings;
}

/** The combined result of one connection test. */
export type ConnectionTestOutcome = ConnectionTestResponse;

/**
 * Test one mailbox's IMAP and SMTP endpoints and report each half
 * separately. The caller supplies settings exactly as stored on the
 * account; the SMTP security mode decides which encrypted mode is tested.
 */
export async function runConnectionTest(request: ConnectionTestRequest): Promise<ConnectionTestOutcome> {
  const { imap, smtp, ...context } = request;
  const [imapReport, smtpReport] = await Promise.all([
    testImapConnection(imap, context),
    testSmtpConnection(smtp, context),
  ]);
  return { imap: imapReport, smtp: smtpReport };
}

/** Re-exported for callers that build requests field by field. */
export type { SmtpSecurityMode, ConnectionTimeouts };
