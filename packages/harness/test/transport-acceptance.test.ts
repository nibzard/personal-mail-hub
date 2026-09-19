import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testImapConnection, testSmtpConnection } from "@mail-hub/transport";
import {
  createTestAuthority,
  ScriptedImapServer,
  ScriptedMailboxStore,
  ScriptedSmtpServer,
  type TestAuthority,
  type TestCertificate,
} from "../src/index.ts";

/**
 * Encrypted transport acceptance on the shared harness (SPEC section 12,
 * "Transport and authentication acceptance"). The production connection
 * testers run against the scripted servers, so the failure cases share one
 * wire truth with the sync, send, and restore suites: every scenario keeps
 * certificate validation on, and the recorded command lines prove the
 * strongest property directly. Neither protocol sends a credential or a
 * message byte before a verified encrypted channel exists.
 */

const HOST = "localhost";
const USER = "user@example.com";
const PASSWORD = "mailbox-secret";

/** Fast timeouts keep the negative cases from stalling the suite. */
const TIMEOUTS = { connectMs: 4_000, greetingMs: 4_000, socketMs: 8_000 };

/** One message body of a known shape. */
function message(uid: number, seen: boolean): { bytes: Uint8Array; flags: string[] } {
  const bytes = Buffer.from(
    [
      "From: Sender <sender@example.net>",
      `Subject: Transport message ${uid}`,
      `Message-ID: <transport-${uid}@example.net>`,
      "",
      `Body of transport message ${uid}.`,
    ].join("\r\n"),
    "utf8",
  );
  return { bytes, flags: seen ? ["\\Seen"] : [] };
}

/** One store the connection tester inspects: known folders and counts. */
function inspectionStore(): ScriptedMailboxStore {
  const store = new ScriptedMailboxStore();
  store.addFolder("INBOX", { specialUse: ["\\Inbox"] });
  // Three messages, one already read: the report must count two unread.
  for (const uid of [1, 2, 3]) {
    const spec = message(uid, uid === 1);
    store.addMessage("INBOX", { ...spec, uid });
  }
  store.addFolder("Archive");
  for (const uid of [1, 2]) {
    store.addMessage("Archive", { ...message(uid, false), uid });
  }
  store.addFolder("Sent", { specialUse: ["\\Sent"] });
  store.addMessage("Sent", { ...message(1, true), uid: 1 });
  return store;
}

let authority: TestAuthority;
let valid: TestCertificate;
let expired: TestCertificate;
let wrongHost: TestCertificate;
let selfSigned: TestCertificate;

const servers: { stop(): Promise<void> }[] = [];

/** Start one scripted IMAP server this suite stops afterwards. */
async function startImap(certificate: TestCertificate, auth: { user: string; pass: string } | null) {
  const server = await ScriptedImapServer.start({ certificate, auth, store: inspectionStore() });
  servers.push(server);
  return server;
}

/** Start one scripted SMTP server this suite stops afterwards. */
async function startSmtp(
  mode: "starttls" | "starttls-missing" | "implicit",
  certificate: TestCertificate,
  auth: { user: string; pass: string } | null,
) {
  const server = await ScriptedSmtpServer.start({ mode, certificate, auth });
  servers.push(server);
  return server;
}

/** Shared context: trust only the test authority. */
const trusted = () => ({ username: USER, password: PASSWORD, trustedCaPem: [authority.certPem], timeouts: TIMEOUTS });

beforeAll(() => {
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

describe("the IMAP connection test on the harness server", () => {
  it("authenticates over implicit TLS and reports capabilities, folders, and counts", async () => {
    const server = await startImap(valid, { user: USER, pass: PASSWORD });
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(true);
    expect(report.stage).toBe("inspect");
    expect(report.error).toBeNull();
    // The scripted server advertises the write extensions the action paths use.
    expect(report.capabilities).toContain("IMAP4rev1");
    expect(report.capabilities).toContain("CONDSTORE");
    expect(report.capabilities).toContain("UIDPLUS");
    expect(report.capabilities).toContain("MOVE");
    const folders = [...report.folders].sort((a, b) => a.name.localeCompare(b.name));
    expect(folders).toEqual([
      // ImapFlow derives \Archive and \Inbox from the reserved names.
      { name: "Archive", specialUse: ["\\Archive"], messages: 2, unread: 2 },
      { name: "INBOX", specialUse: ["\\Inbox"], messages: 3, unread: 2 },
      { name: "Sent", specialUse: ["\\Sent"], messages: 1, unread: 0 },
    ]);
    // The login did happen, and the inspection wrote nothing.
    expect(server.commands.some(({ line }) => /^(\S+)\s+LOGIN\b/i.test(line))).toBe(true);
    expect(server.sawWrite()).toBe(false);
    expect(server.appends).toHaveLength(0);
  });

  it("refuses a certificate the trusted authority did not sign", async () => {
    const server = await startImap(selfSigned, { user: USER, pass: PASSWORD });
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    // The handshake failed before any command: no credential left the client.
    expect(server.commands).toHaveLength(0);
  });

  it("refuses an expired certificate from the trusted authority", async () => {
    const server = await startImap(expired, { user: USER, pass: PASSWORD });
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    expect(server.commands).toHaveLength(0);
  });

  it("refuses a valid certificate issued for another host name", async () => {
    const server = await startImap(wrongHost, { user: USER, pass: PASSWORD });
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    expect(server.commands).toHaveLength(0);
  });

  it("reports an authentication rejection separately from transport failures", async () => {
    const server = await startImap(valid, null);
    const report = await testImapConnection({ host: HOST, port: server.port }, trusted());

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("authenticate");
    expect(report.error?.code).toBe("authentication_failed");
    expect(report.error?.message).not.toContain(PASSWORD);
    // The refused login traveled only inside the verified TLS channel.
    expect(server.commands.some(({ line }) => /^(\S+)\s+LOGIN\b/i.test(line))).toBe(true);
  });
});

describe("the SMTP connection test on the harness server", () => {
  /** Every recorded AUTH line, whatever its phase. */
  const authLines = (server: ScriptedSmtpServer) =>
    server.commands.filter(({ line }) => /^AUTH\b/i.test(line));

  it("authenticates over required STARTTLS and sends no mail", async () => {
    const server = await startSmtp("starttls", valid, { user: USER, pass: PASSWORD });
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(true);
    expect(report.stage).toBe("inspect");
    expect(report.security).toBe("starttls_required");
    expect(report.error).toBeNull();
    // The credential traveled only after the upgrade; no mail command ran.
    expect(authLines(server).length).toBeGreaterThan(0);
    expect(authLines(server).every(({ phase }) => phase === "tls")).toBe(true);
    expect(server.sawMailSubmission()).toBe(false);
    expect(server.submissions).toHaveLength(0);
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
    expect(authLines(server).length).toBeGreaterThan(0);
    expect(server.sawMailSubmission()).toBe(false);
  });

  it("fails before any credential when the server refuses STARTTLS", async () => {
    const server = await startSmtp("starttls-missing", valid, { user: USER, pass: PASSWORD });
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_unavailable");
    expect(authLines(server)).toHaveLength(0);
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
    expect(authLines(server)).toHaveLength(0);
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
    expect(authLines(server)).toHaveLength(0);
    expect(server.sawMailSubmission()).toBe(false);
  });

  it("refuses a valid certificate issued for another host name during the upgrade", async () => {
    const server = await startSmtp("starttls", wrongHost, { user: USER, pass: PASSWORD });
    const report = await testSmtpConnection(
      { host: HOST, port: server.port, security: "starttls_required" },
      trusted(),
    );

    expect(report.ok).toBe(false);
    expect(report.stage).toBe("tls");
    expect(report.error?.code).toBe("tls_invalid");
    expect(authLines(server)).toHaveLength(0);
    expect(server.sawMailSubmission()).toBe(false);
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
    expect(authLines(server).every(({ phase }) => phase === "tls")).toBe(true);
    expect(server.sawMailSubmission()).toBe(false);
  });
});
