import nodemailer from "nodemailer";
import type { SmtpSubmitReport, SmtpSubmitRequest } from "@mail-hub/contracts";
import { resolveTimeouts, verifiedTlsOptions } from "./tls.ts";

/**
 * The SMTP submission transport (SPEC F7 step 3 and section 9).
 *
 * One call submits the exact, durably stored MIME bytes of one outbound
 * snapshot over a verified encrypted channel and returns a classified report.
 * The report is the only output: this function never throws, so callers store
 * a result rather than an exception.
 *
 * Security mirrors the connection test (SPEC section 9): required STARTTLS on
 * 587 or implicit TLS on 465, hostname-checked certificates, and credentials
 * only after the encrypted channel is verified. Plaintext and optional
 * upgrades do not exist.
 *
 * Outcome classification (SPEC F7 steps 4 and 6):
 *
 * - `accepted`: the server returned one positive final response. Individual
 *   recipients may still be rejected; the report separates them.
 * - `rejected`: a definitive refusal the server stated — failed
 *   authentication, a refused STARTTLS upgrade, an envelope refusal, or a
 *   non-positive final response. Nothing was accepted, so a fresh attempt is
 *   safe after review.
 * - `unknown`: every outcome the client cannot classify, including a lost
 *   final response, a dropped connection, a timeout, and a failed
 *   certificate check (`ESOCKET` covers both a failed handshake and a socket
 *   that died after the data flowed). No automatic resend follows an
 *   uncertain attempt.
 */

/** The envelope and message of one submission, in nodemailer's shape. */
interface SubmissionPayload {
  from: string;
  to: string[];
  raw: Buffer;
}

/**
 * Submit one message. The return never rejects; read `state` for the outcome.
 */
export async function submitSmtpMessage(request: SmtpSubmitRequest): Promise<SmtpSubmitReport> {
  const starttlsRequired = request.security === "starttls_required";
  const timeouts = resolveTimeouts(request.timeouts);
  const transporter = nodemailer.createTransport({
    host: request.host,
    port: request.port,
    // SPEC section 9: implicit TLS wraps the socket from the start; required
    // STARTTLS begins in cleartext, upgrades before authentication, and never
    // continues without the upgrade.
    secure: !starttlsRequired,
    requireTLS: starttlsRequired,
    ignoreTLS: false,
    opportunisticTLS: false,
    auth: { user: request.username, pass: request.password },
    tls: verifiedTlsOptions(request.trustedCaPem),
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.greetingMs,
    socketTimeout: timeouts.socketMs,
    // The bytes are pregenerated; no attachment or image may be fetched.
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });

  try {
    const payload: SubmissionPayload = {
      from: request.envelope.from,
      to: [...request.envelope.to],
      raw: Buffer.isBuffer(request.raw) ? request.raw : Buffer.from(request.raw),
    };
    const info = await transporter.sendMail({
      raw: payload.raw,
      // The envelope is explicit: the stored bytes carry no Bcc header, so the
      // blind-copy recipients live only in this envelope (SPEC F7 step 2).
      envelope: { from: payload.from, to: payload.to },
    });
    return acceptedReport(String(info.response ?? ""), request.envelope.to, info);
  } catch (cause) {
    return rejectedOrUnknown(cause, request.envelope.to);
  } finally {
    transporter.close();
  }
}

/** The report of one submission whose final response was positive. */
function acceptedReport(
  response: string,
  envelopeTo: string[],
  info: {
    accepted?: unknown;
    rejected?: unknown;
    rejectedErrors?: unknown;
  },
): SmtpSubmitReport {
  const accepted = new Set(readAddresses(info.accepted));
  const rejections = rejectionResponses(info.rejectedErrors);
  return {
    state: "accepted",
    response,
    responseCode: readResponseCode(response),
    recipients: envelopeTo.map((address) => ({
      address,
      accepted: accepted.has(address),
      response: accepted.has(address)
        ? response
        : (rejections.get(address) ?? response),
    })),
    error: null,
  };
}

/**
 * Classify one thrown submission. The codes below are the definitive refusals
 * nodemailer reports; everything else may have reached the server and stays
 * `unknown` (SPEC F7 step 6).
 */
function rejectedOrUnknown(cause: unknown, envelopeTo: string[]): SmtpSubmitReport {
  const code = readErrorCode(cause);
  const response = readStringProperty(cause, "response");
  const rejectedFromError = readAddresses(readProperty(cause, "rejected"));
  const rejections = rejectionResponses(readProperty(cause, "rejectedErrors"));

  const recipients = envelopeTo.map((address) => ({
    address,
    accepted: false,
    response: rejections.get(address) ?? response,
  }));
  // When the error carries no per-recipient detail but the session reached the
  // envelope, every addressed recipient is accounted for; otherwise the list
  // stays empty rather than inventing outcomes.
  const detailed = rejectedFromError.length > 0 || rejections.size > 0 ? recipients : [];

  const definitive =
    code === "EAUTH" ||
    code === "ETLS" ||
    code === "EENVELOPE" ||
    code === "EMESSAGE";
  return {
    state: definitive ? "rejected" : "unknown",
    response,
    responseCode: readResponseCode(response),
    recipients: detailed,
    error: {
      code,
      message: cause instanceof Error ? cause.message.split(": ")[0]! : String(cause),
    },
  };
}

/** Addresses from one nodemailer array property, when it holds any. */
function readAddresses(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readProperty(cause: unknown, property: string): unknown {
  return typeof cause === "object" && cause !== null
    ? (cause as Record<string, unknown>)[property]
    : undefined;
}

function readStringProperty(cause: unknown, property: string): string | null {
  const value = readProperty(cause, property);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The nodemailer error code, or `internal_error` when none exists. */
function readErrorCode(cause: unknown): string {
  const code = readProperty(cause, "code");
  return typeof code === "string" && code.length > 0 ? code : "internal_error";
}

/** Per-recipient response lines from nodemailer's rejection errors. */
function rejectionResponses(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(value)) {
    return map;
  }
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as { recipient?: unknown; response?: unknown };
    if (typeof record.recipient === "string" && typeof record.response === "string") {
      map.set(record.recipient, record.response);
    }
  }
  return map;
}

function readResponseCode(response: string | null): number | null {
  if (response === null) {
    return null;
  }
  const match = /^(\d{3})/.exec(response);
  return match === null ? null : Number(match[1]);
}
