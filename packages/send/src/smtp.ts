import type { SmtpSubmitReport, SmtpSubmitRequest } from "@mail-hub/contracts";

/**
 * The SMTP submission port (SPEC F7 step 3). One implementation opens one
 * verified connection and submits the exact stored bytes; tests script the
 * outcomes. The report is the only output: a submitter never throws, so the
 * send service always records a durable result for its claim.
 */
export type SmtpSubmitter = (request: SmtpSubmitRequest) => Promise<SmtpSubmitReport>;

/** The SMTP settings and credentials one submission needs. */
export interface SmtpCredentials {
  host: string;
  port: number;
  security: "starttls_required" | "implicit_tls";
  username: string;
  password: string;
}

/** Resolves the submission settings of one account. */
export type SmtpCredentialsResolver = (accountId: string) => Promise<SmtpCredentials>;
