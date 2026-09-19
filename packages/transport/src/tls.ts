import type { ConnectionOptions } from "node:tls";

/**
 * TLS options shared by the IMAP and SMTP testers (SPEC section 9).
 *
 * Every connection this package opens must validate the certificate chain
 * and the configured hostname. Nothing here may disable validation: missing
 * encryption, expired certificates, and hostname mismatches must fail before
 * any credential is sent. Tests add a trusted test authority through
 * `trustedCaPem`; production passes nothing and uses the system trust store.
 */

/** Default time budget for one connection attempt, covering DNS and handshake. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Default time budget for a greeting after the transport is established. */
export const DEFAULT_GREETING_TIMEOUT_MS = 10_000;

/** Default inactivity limit while a test session is open. */
export const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;

/** Timeouts one connection test may override, with their defaults. */
export interface ConnectionTimeouts {
  connectMs: number;
  greetingMs: number;
  socketMs: number;
}

/** Fill a partial timeout override with the defaults. */
export function resolveTimeouts(partial?: Partial<ConnectionTimeouts>): ConnectionTimeouts {
  return {
    connectMs: partial?.connectMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    greetingMs: partial?.greetingMs ?? DEFAULT_GREETING_TIMEOUT_MS,
    socketMs: partial?.socketMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
  };
}

/**
 * Build the TLS options both protocols share. Certificate validation is
 * always on and the server name is always the configured host, so a
 * certificate for any other name fails the handshake.
 */
export function verifiedTlsOptions(trustedCaPem?: string[]): ConnectionOptions {
  return {
    // Explicit, so no library default can silently relax validation. Node
    // already defaults to true; this pins the intent (SPEC section 9).
    rejectUnauthorized: true,
    ...(trustedCaPem === undefined || trustedCaPem.length === 0 ? {} : { ca: trustedCaPem }),
  };
}
