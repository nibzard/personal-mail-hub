import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ImapConnectionReport, SmtpConnectionReport } from "@mail-hub/contracts";
import { classifyTransportError, runConnectionTest, testImapConnection, testSmtpConnection } from "../src/index.ts";
import { FakeImapServer, type FakeImapFolder } from "./fake-imap-server.ts";
import { FakeSmtpServer } from "./fake-smtp-server.ts";
import { createTestAuthority, type TestAuthority, type TestCertificate } from "./test-certificates.ts";

/**
 * Transport acceptance for the connection tests (SPEC F1, section 9, and
 * section 12). Every case runs with certificate validation on: the tester
 * trusts the test authority through `trustedCaPem` and must refuse every
 * other certificate. The fake servers record their command lines per phase,
 * so the suite proves the strongest property directly: neither protocol
 * sends credentials before a verified encrypted connection exists.
 */

const USER = "user@example.com";
const PASSWORD = "mailbox-secret";
const HOST = "localhost";

/** Fast timeouts keep the negative cases from stalling the suite. */
const TIMEOUTS = { connectMs: 4_000, greetingMs: 4_000, socketMs: 8_000 };

const FOLDERS: FakeImapFolder[] = [
  { name: "INBOX", flags: ["\\HasNoChildren"], messages: 12, unseen: 3 },
  { name: "Sent", flags: ["\\HasNoChildren", "\\Sent"], messages: 210, unseen: 0 },
  { name: "Archive", flags: ["\\HasNoChildren", "\\Archive"], messages: 7, unseen: 7 },
];

let authority: TestAuthority;
let valid: TestCertificate;
let expired: TestCertificate;
let wrongHost: TestCertificate;
let selfSigned: TestCertificate;

const servers: { stop(): Promise<void> }[] = [];

/** One free loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Start a fake IMAP server that this suite stops afterwards. */
async function startImap(certificate: TestCertificate, auth: { user: string; pass: string } | null) {
  const server = await FakeImapServer.start({ certificate, auth, folders: FOLDERS });
  servers.push(server);
  return server;
}

/** Start a fake SMTP server that this suite stops afterwards. */
async function startSmtp(mode: "starttls" | "starttls-missing" | "implicit", certificate: TestCertificate, auth: { user: string; pass: string } | null) {
  const server = await FakeSmtpServer.start({ mode, certificate, auth });
  servers.push(server);
  return server;
}

/** Shared context: trust only the test authority. */
const trusted = () => ({ username: USER, password: PASSWORD, trustedCaPem: [authority.certPem], timeouts: TIMEOUTS });

beforeAll(async () => {
  authority = createTestAuthority();
  valid = authority.issue({ hosts: [HOST], ips: ["127.0.0.1"] });
  expired = authority.issue({
    hosts: [HOST],
    notBefore: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    notAfter: new Date(Date.now() - 60 * 60 * 1000),
  });
  wrongHost = authority.issue({ hosts: ["other.example"] });
  selfSigned = authority.selfSigned({ hosts: [HOST] });
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
});

describe("the IMAP connection test", () => {
  it("authenticates over implicit TLS and reports capabilities, folders, and counts", async () => {
    const server = await startImap(valid, { user: USER, pass: PASSWORD });
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(true);
    expect(report.stage).toBe("inspect");
    expect(report.error).toBeNull();
    expect(report.capabilities).toContain("IMAP4rev1");
    expect(report.capabilities).toContain("SPECIAL-USE");
    expect(report.capabilities).toContain("IDLE");
    expect(report.folders).toEqual([
      // ImapFlow derives the \Inbox special-use flag from the reserved name.
      { name: "INBOX", specialUse: ["\\Inbox"], messages: 12, unread: 3 },
      { name: "Sent", specialUse: ["\\Sent"], messages: 210, unread: 0 },
      { name: "Archive", specialUse: ["\\Archive"], messages: 7, unread: 7 },
    ]);
    // The login did happen, and it happened inside the verified TLS channel.
    expect(server.sawLoginOverTls()).toBe(true);
    expect(server.sawCredentials(USER, PASSWORD)).toBe(true);
  });

  it("refuses a certificate the trusted authority did not sign", async () => {
    const server = await startImap(selfSigned, { user: USER, pass: PASSWORD });
    const report: ImapConnectionReport = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    // The handshake failed before any command: no credentials left the client.
    expect(server.commands).toHaveLength(0);
    expect(server.sawCredentials(USER, PASSWORD)).toBe(false);
    // The server sees the abandoned handshake a tick after the client errors,
    // so the count is read with a short wait.
    await vi.waitFor(() => expect(server.handshakeFailures).toBeGreaterThan(0));
  });

  it("refuses an expired certificate from the trusted authority", async () => {
    const server = await startImap(expired, { user: USER, pass: PASSWORD });
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    expect(server.commands).toHaveLength(0);
    expect(server.sawCredentials(USER, PASSWORD)).toBe(false);
  });

  it("refuses a valid certificate issued for another host name", async () => {
    const server = await startImap(wrongHost, { user: USER, pass: PASSWORD });
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    expect(server.commands).toHaveLength(0);
    expect(server.sawCredentials(USER, PASSWORD)).toBe(false);
  });

  it("reports an authentication rejection separately from transport failures", async () => {
    const server = await startImap(valid, null);
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("authenticate");
    expect(report.error?.code).toBe("authentication_failed");
    expect(report.error?.message).not.toContain(PASSWORD);
    // The rejected login still traveled only inside the TLS channel.
    expect(server.sawLoginOverTls()).toBe(true);
  });

  it("classifies an unreachable endpoint as a network failure", async () => {
    const port = await closedPort();
    const report = await testImapConnection({ host: HOST, port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("network_error");
  });
});

describe("the SMTP connection test", () => {
  it("authenticates over required STARTTLS and sends no mail", async () => {
    const server = await startSmtp("starttls", valid, { user: USER, pass: PASSWORD });
    const report: SmtpConnectionReport = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(true);
    expect(report.stage).toBe("inspect");
    expect(report.security).toBe("starttls_required");
    expect(report.error).toBeNull();
    expect(server.sawAuthenticationOverTls()).toBe(true);
    expect(server.sawAuthenticationInPlaintext()).toBe(false);
    expect(server.sawMailSubmission()).toBe(false);
  });

  it("authenticates over implicit TLS and sends no mail", async () => {
    const server = await startSmtp("implicit", valid, { user: USER, pass: PASSWORD });
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "implicit_tls" },
      trusted(),
    );

    expect(report.ok).toBe(true);
    expect(report.stage).toBe("inspect");
    expect(report.security).toBe("implicit_tls");
    expect(report.error).toBeNull();
    expect(server.sawAuthenticationOverTls()).toBe(true);
    expect(server.sawMailSubmission()).toBe(false);
  });

  it("fails before authentication when the server offers no STARTTLS", async () => {
    const server = await startSmtp("starttls-missing", valid, { user: USER, pass: PASSWORD });
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_unavailable");
    expect(server.sawAuthentication()).toBe(false);
    expect(server.sawMailSubmission()).toBe(false);
  });

  it("fails the STARTTLS upgrade on an untrusted certificate, before any credential", async () => {
    const server = await startSmtp("starttls", selfSigned, { user: USER, pass: PASSWORD });
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    expect(server.sawAuthentication()).toBe(false);
    // Decoded payloads included: base64 is not protection on a plaintext link.
    expect(server.sawTextInPlaintext(PASSWORD)).toBe(false);
    expect(server.sawMailSubmission()).toBe(false);
  });

  it("refuses an expired certificate during the STARTTLS upgrade", async () => {
    const server = await startSmtp("starttls", expired, { user: USER, pass: PASSWORD });
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    expect(server.sawAuthentication()).toBe(false);
  });

  it("reports an authentication rejection separately from transport failures", async () => {
    const server = await startSmtp("starttls", valid, null);
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("authenticate");
    expect(report.error?.code).toBe("authentication_failed");
    expect(report.error?.message).not.toContain(PASSWORD);
    // The credentials were refused, but only after the upgrade succeeded.
    expect(server.sawAuthenticationOverTls()).toBe(true);
    expect(server.sawAuthenticationInPlaintext()).toBe(false);
    expect(server.sawTextInPlaintext(PASSWORD)).toBe(false);
  });

  it("labels a second connection plaintext until that connection upgrades", async () => {
    const server = await startSmtp("starttls", valid, { user: USER, pass: PASSWORD });
    // The first session upgrades; a later connection must not inherit its
    // state, or plaintext lines would be mislabeled and the no-credentials-
    // in-plaintext assertion could pass as a false negative.
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );
    expect(report.ok).toBe(true);

    const probe = net.createConnection({ host: HOST, port: server.port });
    await new Promise<void>((resolve) => probe.once("connect", resolve));
    probe.write("NOOP\r\n");
    await vi.waitFor(() => expect(server.sawText("NOOP")).toBe(true));
    expect(server.commands.find(({ line }) => line === "NOOP")?.phase).toBe("plaintext");
    probe.destroy();
  });

  it("classifies an unreachable endpoint as a network failure", async () => {
    const port = await closedPort();
    const report = await testSmtpConnection(
      { host: HOST, port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("network_error");
  });
});

describe("the combined connection test", () => {
  it("reports each protocol separately when only one half fails", async () => {
    const imapPort = await closedPort();
    const smtp = await startSmtp("starttls", valid, { user: USER, pass: PASSWORD });

    const outcome = await runConnectionTest({
      imap: { host: HOST, port: imapPort },
      smtp: { host: HOST, port: smtp.port, security: "starttls_required" },
      ...trusted(),
    });

    expect(outcome.imap.ok).toBe(false);
    expect(outcome.imap.error?.code).toBe("network_error");
    expect(outcome.smtp.ok).toBe(true);
    expect(outcome.smtp.error).toBeNull();
  });
});

describe("error classification", () => {
  it("redacts the password from a classified message", () => {
    const classified = classifyTransportError(new Error(`LOGIN "${USER}" "${PASSWORD}" failed`), PASSWORD);
    expect(classified.message).not.toContain(PASSWORD);
    expect(classified.message).toContain("[redacted]");
    expect(classified.code).toBe("protocol_error");
  });

  it("bounds a message of unbounded length", () => {
    const classified = classifyTransportError(new Error("x".repeat(500)), PASSWORD);
    expect(classified.message.length).toBeLessThanOrEqual(300);
  });
});
