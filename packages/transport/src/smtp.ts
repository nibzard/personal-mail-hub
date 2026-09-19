import nodemailer from "nodemailer";
import type { SmtpSecurityMode, SmtpConnectionReport } from "@mail-hub/contracts";
import { classifyTransportError } from "./classify.ts";
import { resolveTimeouts, verifiedTlsOptions } from "./tls.ts";
import type { TransportTestContext } from "./imap.ts";

/**
 * The verified SMTP connection test (SPEC F1 and section 9).
 *
 * SMTP has two permitted modes: required STARTTLS on port 587 and implicit
 * TLS on port 465. Plaintext and optional upgrades do not exist: the
 * transport refuses to authenticate unless STARTTLS succeeded, and with
 * `requireTLS` a server that offers no upgrade fails the test before any
 * credential leaves. `verify()` opens the connection, performs the upgrade
 * and the authentication, and quits. No mail is ever submitted.
 */

/** Connection settings for the SMTP half of one test. */
export interface SmtpTestSettings {
  host: string;
  port: number;
  security: SmtpSecurityMode;
}

/**
 * Test one SMTP endpoint. Never rejects: every failure comes back as a
 * report, so one protocol's result never hides the other's.
 */
export async function testSmtpConnection(
  settings: SmtpTestSettings,
  context: TransportTestContext,
): Promise<SmtpConnectionReport> {
  const timeouts = resolveTimeouts(context.timeouts);
  const starttlsRequired = settings.security === "starttls_required";
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    // SPEC section 9: implicit TLS wraps the socket from the start; required
    // STARTTLS begins in cleartext, upgrades before authentication, and
    // never continues without the upgrade.
    secure: !starttlsRequired,
    requireTLS: starttlsRequired,
    ignoreTLS: false,
    opportunisticTLS: false,
    // Authentication is part of the test: fail when the server refuses it
    // instead of reporting an unauthenticated connection as verified.
    forceAuth: true,
    auth: { user: context.username, pass: context.password },
    tls: verifiedTlsOptions(context.trustedCaPem),
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    logger: false,
  });

  try {
    // verify() connects, upgrades, authenticates, and quits. It submits no
    // envelope and no message content of any kind.
    await transporter.verify();
    return {
      protocol: "smtp",
      ok: true,
      stage: "inspect",
      security: settings.security,
      error: null,
    };
  } catch (error) {
    const stage = isAuthenticationFailure(error) ? "authenticate" : "tls";
    return {
      protocol: "smtp",
      ok: false,
      stage,
      security: settings.security,
      error: classifyTransportError(error, context.password),
    };
  } finally {
    transporter.close();
  }
}

/** True when the library flagged the failure as an authentication rejection. */
function isAuthenticationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { authenticationFailed?: unknown }).authenticationFailed === true ||
      (error as { code?: unknown }).code === "EAUTH")
  );
}
