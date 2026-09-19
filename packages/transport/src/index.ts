/**
 * Verified IMAP and SMTP transports (SPEC F1, F7, and section 9).
 *
 * One connection test exercises both protocols of one mailbox, each on its
 * own connection and with its own report. Validated TLS is a precondition:
 * certificates are chain- and hostname-checked, and credentials are sent
 * only after the encrypted channel is verified. The SMTP half authenticates
 * without submitting mail; the IMAP half authenticates, lists folders with
 * counts, and discovers the advertised capabilities. A connection test
 * verifies no send identities.
 *
 * Submission shares the same TLS rules: `submitSmtpMessage` sends the exact
 * stored MIME bytes of one outbound snapshot and returns one classified
 * report instead of throwing.
 */
export { classifyTransportError } from "./classify.ts";
export { testImapConnection, type ImapTestSettings, type TransportTestContext } from "./imap.ts";
export { testSmtpConnection, type SmtpTestSettings } from "./smtp.ts";
export { submitSmtpMessage } from "./submit.ts";
export {
  verifiedTlsOptions,
  resolveTimeouts,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_GREETING_TIMEOUT_MS,
  DEFAULT_SOCKET_TIMEOUT_MS,
  type ConnectionTimeouts,
} from "./tls.ts";
export { runConnectionTest, type ConnectionTestRequest, type ConnectionTestOutcome } from "./service.ts";
