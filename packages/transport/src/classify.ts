import type { ConnectionTestError, TransportErrorCode } from "@mail-hub/contracts";

/**
 * Error classification for connection tests (SPEC F1 and section 12).
 *
 * ImapFlow and Nodemailer surface failures with different shapes: ImapFlow
 * stamps flags such as `authenticationFailed` and `tlsFailed`, Nodemailer
 * sets `code` values such as `EAUTH` and `ETLS`, and Node's TLS layer puts
 * its verdict in `code` or `errno`. This module folds all of them into one
 * code per outcome so the interface can name what went wrong without
 * leaking library internals. Reported messages never contain credentials.
 */

/**
 * System error codes that mean the TLS layer itself refused the connection:
 * the chain did not verify, the certificate is expired or not yet valid, the
 * hostname does not match, or the handshake could not complete at all.
 */
const TLS_ERROR_CODES = [
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_CHAIN_TOO_LONG",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_INVALID_PROTOCOL_VERSION",
  "ERR_TLS_PROTOCOL_VERSION_ALERT",
  "ERR_TLS_DECRYPTION_FAILED",
  "ERR_TLS_UNEXPECTED_MESSAGE",
  "ERR_SSL_TLSV1_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "EPROTO",
];

/** System error codes that mean the endpoint could not be reached at all. */
const NETWORK_ERROR_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ETIMEOUT",
  "ECONNABORTED",
  "EPIPE",
  "ECONNRESET_TIMEOUT",
];

/** Phrases in Node's TLS rejection messages, for errors that carry no code. */
const TLS_MESSAGE_PATTERN =
  /(certificate|self[- ]signed|issuer|hostname| ip address|not yet valid|has expired|ERR_TLS|ERR_SSL)/i;

/**
 * Network codes that appear inside a message. Nodemailer wraps connect
 * failures as `ESOCKET` with the real code only in the message text, for
 * example "connect ECONNREFUSED 127.0.0.1:9".
 */
const NETWORK_MESSAGE_PATTERN =
  /\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE)\b/;

/**
 * Classify one failure from either protocol.
 *
 * @param error What the client library threw.
 * @param secret A value to redact from the reported message, if it appears.
 */
export function classifyTransportError(error: unknown, secret?: string): ConnectionTestError {
  return {
    code: codeOf(error),
    message: messageOf(error, secret),
  };
}

/** Pick the transport error code for one thrown value. */
function codeOf(error: unknown): TransportErrorCode {
  if (!isRecord(error)) {
    return "protocol_error";
  }

  // Authentication failures are flagged explicitly by both libraries and are
  // checked first: they can only happen after verified encryption, so they
  // must never be mistaken for a TLS problem.
  if (error.authenticationFailed === true) {
    return "authentication_failed";
  }
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "EAUTH") {
    return "authentication_failed";
  }

  // Nodemailer reports both a missing STARTTLS offer and a failed upgrade as
  // ETLS. A server that answered the STARTTLS command with an error refused
  // the upgrade; every other ETLS failure is a failed negotiation.
  if (code === "ETLS") {
    return typeof error.message === "string" && error.message.includes("upgrading connection with STARTTLS")
      ? "tls_unavailable"
      : "tls_invalid";
  }

  // ImapFlow stamps tlsFailed when a STARTTLS upgrade fails. The testers
  // only use implicit TLS for IMAP, where a handshake rejection surfaces as
  // one of the TLS codes below, but the flag is honored wherever it appears.
  if (error.tlsFailed === true) {
    return "tls_invalid";
  }

  if (code !== "" && (TLS_ERROR_CODES.includes(code) || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL"))) {
    return "tls_invalid";
  }
  if (code === "ECONNECTION" || code === "CONNECT_TIMEOUT" || code === "GREETING_TIMEOUT") {
    return "network_error";
  }
  if (code !== "" && NETWORK_ERROR_CODES.includes(code)) {
    return "network_error";
  }

  const message = typeof error.message === "string" ? error.message : "";
  if (TLS_MESSAGE_PATTERN.test(message)) {
    return "tls_invalid";
  }
  if (NETWORK_MESSAGE_PATTERN.test(message)) {
    return "network_error";
  }
  return "protocol_error";
}

/** Build a credential-free message from one thrown value. */
function messageOf(error: unknown, secret?: string): string {
  let text: string;
  if (isRecord(error)) {
    const parts = [error.message, error.responseText, error.response];
    text = parts
      .filter((part): part is string => typeof part === "string" && part !== "")
      .join(": ");
    if (text === "" && error.code !== undefined) {
      text = String(error.code);
    }
  } else if (error instanceof Error) {
    text = error.message;
  } else {
    text = String(error);
  }
  text = text.trim() === "" ? "The connection test failed without a reason." : text.trim();
  // The libraries build messages from server responses, which are untrusted
  // text. Bound the length and remove the password if one ever leaks in.
  const bounded = text.length > 300 ? `${text.slice(0, 297)}...` : text;
  return secret === undefined || secret === "" ? bounded : bounded.split(secret).join("[redacted]");
}

/** True when the value is a non-null object we can read fields from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
