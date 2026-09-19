import tls from "node:tls";
import { ImapFlow } from "imapflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifiedTlsOptions } from "@mail-hub/transport";
import {
  createTestAuthority,
  maliciousHtmlMessage,
  replyChain,
  ScriptedImapServer,
  ScriptedMailboxStore,
  type TestAuthority,
  type TestCertificate,
} from "../src/index.ts";

/**
 * The scripted IMAP server against the production client (SPEC section 12).
 *
 * ImapFlow runs here exactly as the mailbox session factory configures it:
 * implicit TLS, no automatic IDLE, extension enablement only on request. The
 * scenarios cover the wire shapes the acceptance suites script: UID gaps,
 * generation changes, server expunges, arrivals, conditional flag writes,
 * UIDPLUS moves and appends, malicious mail on the wire, interrupted
 * transfers, and sessions that expire. Every test starts its own server with
 * its own store, so no scenario leaks into the next.
 */

const HOST = "localhost";
const USER = "user@example.com";
const PASSWORD = "mailbox-secret";

/** Fast timeouts keep the failure cases from stalling the suite. */
const TIMEOUTS = { connectMs: 4_000, greetingMs: 4_000, socketMs: 8_000 };

let authority: TestAuthority;
let certificate: TestCertificate;
const servers: ScriptedImapServer[] = [];

/** One standard store: INBOX with UID gaps, plus Archive and Sent. */
function freshStore(): ScriptedMailboxStore {
  const store = new ScriptedMailboxStore();
  store.addFolder("INBOX", { specialUse: ["\\Inbox"] });
  store.addFolder("Archive");
  store.addFolder("Sent", { specialUse: ["\\Sent"] });
  // A mailbox with UID gaps: 1, 3, and 7 exist; 2, 4, 5, and 6 never did.
  for (const uid of [1, 3, 7]) {
    store.addMessage("INBOX", { ...plainMessage(uid), uid, flags: uid === 1 ? ["\\Seen"] : [] });
  }
  return store;
}

/** Start one scripted server on a fresh store. */
async function startImap(): Promise<ScriptedImapServer> {
  const server = await ScriptedImapServer.start({
    certificate,
    auth: { user: USER, pass: PASSWORD },
    store: freshStore(),
  });
  servers.push(server);
  return server;
}

/** One client configured the way the production session factory does. */
async function connect(
  server: ScriptedImapServer,
  options: { condstore?: boolean } = {},
): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: HOST,
    port: server.port,
    secure: true,
    auth: { user: USER, pass: PASSWORD },
    tls: verifiedTlsOptions([authority.certPem]),
    disableAutoIdle: true,
    disableAutoEnable: options.condstore !== true,
    connectionTimeout: TIMEOUTS.connectMs,
    greetingTimeout: TIMEOUTS.greetingMs,
    socketTimeout: TIMEOUTS.socketMs,
    logger: false,
  });
  await client.connect();
  return client;
}

/** A plain message whose headers the header fetch must return whole. */
function plainMessage(uid: number): { uid: number; bytes: Uint8Array } {
  const bytes = Buffer.from(
    [
      "From: Sender <sender@example.net>",
      `Subject: Message ${uid}`,
      `Date: Mon, 07 Sep 2026 10:00:0${uid % 10} +0000`,
      `Message-ID: <message-${uid}@example.net>`,
      "",
      `Body of message ${uid}.`,
    ].join("\r\n"),
    "utf8",
  );
  return { uid, bytes };
}

beforeAll(() => {
  authority = createTestAuthority();
  certificate = authority.issue({ hosts: [HOST], ips: ["127.0.0.1"] });
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
});

describe("scripted IMAP server", () => {
  it("lists folders with their special-use flags", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      const list = await client.list();
      const paths = list.map((folder) => folder.path).sort();
      expect(paths).toEqual(["Archive", "INBOX", "Sent"]);
      const sent = list.find((folder) => folder.path === "Sent");
      expect(sent?.specialUse).toEqual("\\Sent");
    } finally {
      await client.logout();
    }
  });

  it("reports the folder generation and UID gaps on selection", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      const mailbox = await client.mailboxOpen("INBOX");
      expect(mailbox.uidValidity).toBe(1n);
      expect(mailbox.uidNext).toBe(8);
      expect(mailbox.exists).toBe(3);
      const uids = await client.search({ uid: "1:*" }, { uid: true });
      expect(uids).toEqual([1, 3, 7]);
      const gapped = await client.search({ uid: "2:6" }, { uid: true });
      expect(gapped).toEqual([3]);
    } finally {
      await client.logout();
    }
  });

  it("fetches headers with the requested fields only", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      const records: { uid: number; headers: Buffer }[] = [];
      for await (const message of client.fetch(
        "3",
        { uid: true, flags: true, internalDate: true, size: true, headers: ["date", "from", "subject", "message-id"] },
        { uid: true },
      )) {
        records.push({ uid: message.uid ?? 0, headers: message.headers ?? Buffer.alloc(0) });
      }
      expect(records).toHaveLength(1);
      expect(records[0]!.uid).toBe(3);
      const headerText = records[0]!.headers.toString("utf8");
      expect(headerText).toContain("Subject: Message 3");
      expect(headerText).toContain("Message-ID: <message-3@example.net>");
      expect(headerText).not.toContain("Sender:");
    } finally {
      await client.logout();
    }
  });

  it("returns the exact stored bytes for a full fetch", async () => {
    const malicious = maliciousHtmlMessage();
    const server = await startImap();
    server.store.addMessage("INBOX", { bytes: malicious, uid: 9 });
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      const fetched = await client.fetchOne("9", { source: true }, { uid: true });
      expect(fetched).not.toBe(false);
      const source = (fetched as { source?: Buffer }).source ?? Buffer.alloc(0);
      expect(Buffer.compare(source, malicious)).toBe(0);
    } finally {
      await client.logout();
    }
  });

  it("answers flags with modification sequences on a CONDSTORE session", async () => {
    const server = await startImap();
    const client = await connect(server, { condstore: true });
    try {
      await client.mailboxOpen("INBOX");
      expect(client.enabled.has("CONDSTORE")).toBe(true);
      const records: { uid: number; modseq?: bigint }[] = [];
      for await (const message of client.fetch("1:3", { uid: true, flags: true }, { uid: true })) {
        records.push({ uid: message.uid ?? 0, modseq: message.modseq });
      }
      expect(records.map((record) => record.uid)).toEqual([1, 3]);
      expect(records.every((record) => record.modseq !== undefined && record.modseq > 0n)).toBe(true);
    } finally {
      await client.logout();
    }
  });

  it("applies an unconditional flag store and reports the new flags", async () => {
    const server = await startImap();
    const client = await connect(server, { condstore: true });
    try {
      await client.mailboxOpen("INBOX");
      const stored = await client.messageFlagsAdd("3", ["\\Seen"], { uid: true });
      expect(stored).toBe(true);
      const fetched = await client.fetchOne("3", { uid: true, flags: true }, { uid: true });
      expect((fetched as { flags?: Set<string> }).flags?.has("\\Seen")).toBe(true);
    } finally {
      await client.logout();
    }
  });

  it("rejects a conditional store whose target moved on", async () => {
    const server = await startImap();
    const client = await connect(server, { condstore: true });
    try {
      await client.mailboxOpen("INBOX");
      // Move the target forward first, so the stale conditional write fails.
      await client.messageFlagsAdd("3", ["\\Flagged"], { uid: true });
      // A CONDSTORE session asks for MODSEQ on every fetch by itself.
      const fresh = await client.fetchOne("3", { uid: true, flags: true }, { uid: true });
      const modseq = (fresh as { modseq?: bigint }).modseq ?? 1n;
      const stored = await client.messageFlagsAdd("3", ["\\Seen"], {
        uid: true,
        unchangedSince: modseq - 1n,
      });
      // The all-failed conditional write answers NO [MODIFIED ...], which
      // ImapFlow folds into `false` without an error.
      expect(stored).toBe(false);
      const after = await client.fetchOne("3", { uid: true, flags: true }, { uid: true });
      expect((after as { flags?: Set<string> }).flags?.has("\\Seen")).toBe(false);
    } finally {
      await client.logout();
    }
  });

  it("moves a message with UIDPLUS coordinates and expunges the source", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      const moved = await client.messageMove("3", "Archive", { uid: true });
      expect(moved).not.toBe(false);
      const result = moved as { destination: string; uidValidity: bigint; uidMap: Map<number, number> };
      expect(result.destination).toBe("Archive");
      expect(result.uidValidity).toBe(1n);
      expect(result.uidMap.get(3)).toBe(1);
      const remaining = await client.search({ uid: "1:*" }, { uid: true });
      expect(remaining).toEqual([1, 7]);
      const archive = await client.status("Archive", { messages: true });
      expect(archive.messages).toBe(1);
    } finally {
      await client.logout();
    }
  });

  it("refuses a move to a folder that does not exist", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      const moved = await client.messageMove("7", "Missing", { uid: true });
      expect(moved).toBe(false);
      expect(server.store.folder("INBOX")?.messages.has(7)).toBe(true);
    } finally {
      await client.logout();
    }
  });

  it("appends with APPENDUID coordinates and counts the Sent copy", async () => {
    const bytes = replyChain()[1]!;
    const server = await startImap();
    const client = await connect(server);
    try {
      const appended = await client.append("Sent", bytes, ["\\Seen"]);
      expect(appended).not.toBe(false);
      const result = appended as { uidValidity: bigint; uid: number };
      expect(result.uidValidity).toBe(1n);
      expect(result.uid).toBe(1);
      expect(server.appends).toHaveLength(1);
      expect(Buffer.compare(server.appends[0]!.bytes, bytes)).toBe(0);
    } finally {
      await client.logout();
    }
  });

  it("refuses an append to a folder that does not exist", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await expect(client.append("Missing", Buffer.from("x"), ["\\Seen"])).rejects.toThrow();
      expect(server.appends).toHaveLength(0);
    } finally {
      await client.logout();
    }
  });

  it("stores an append whose response is lost, leaving the copy findable", async () => {
    const bytes = replyChain()[2]!;
    const server = await startImap();
    const client = await connect(server);
    server.faults.push({ kind: "lost-append-response" });
    try {
      await expect(client.append("Sent", bytes, ["\\Seen"])).rejects.toThrow();
      // The server stored the copy; only the answer never arrived. A
      // reconciliation search by identifier finds it (SPEC F7 step 5).
      const verification = await connect(server);
      try {
        await verification.mailboxOpen("Sent");
        const found = await verification.search(
          { header: { "message-id": "<chain-reply-2@example.net>" } },
          { uid: true },
        );
        expect(found).toEqual([1]);
      } finally {
        await verification.logout();
      }
    } finally {
      client.close();
    }
  });

  it("finds a header search hit by identifier substring", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      const found = await client.search({ header: { "message-id": "<message-7@example.net>" } }, { uid: true });
      expect(found).toEqual([7]);
    } finally {
      await client.logout();
    }
  });

  it("reports a changed generation on the next selection", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      const before = await client.mailboxOpen("INBOX");
      expect(before.uidValidity).toBe(1n);
      server.store.resetUidValidity("INBOX");
      const after = await client.mailboxOpen("INBOX");
      expect(after.uidValidity).toBe(2n);
    } finally {
      await client.logout();
    }
  });

  it("flushes a scripted expunge on the next command", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      server.store.expunge("INBOX", 7);
      const uids = await client.search({ uid: "1:*" }, { uid: true });
      expect(uids).toEqual([1, 3]);
      const mailbox = await client.status("INBOX", { messages: true });
      expect(mailbox.messages).toBe(2);
    } finally {
      await client.logout();
    }
  });

  it("flushes a scripted arrival on the next command", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      server.store.addMessage("INBOX", { ...plainMessage(11), uid: 11 });
      const uids = await client.search({ uid: "1:*" }, { uid: true });
      expect(uids).toEqual([1, 3, 7, 11]);
    } finally {
      await client.logout();
    }
  });

  it("serves two connections over one shared store", async () => {
    const server = await startImap();
    const reader = await connect(server);
    const writer = await connect(server);
    try {
      await reader.mailboxOpen("INBOX");
      await writer.mailboxOpen("INBOX");
      await writer.append("INBOX", Buffer.from(plainMessage(11).bytes), []);
      // The reader learns of the arrival on its next command, not before.
      const uids = await reader.search({ uid: "1:*" }, { uid: true });
      expect(uids).toEqual([1, 3, 7, 8]);
    } finally {
      await reader.logout();
      await writer.logout();
    }
  });

  it("rejects wrong credentials before any mailbox access", async () => {
    const server = await startImap();
    const client = new ImapFlow({
      host: HOST,
      port: server.port,
      secure: true,
      auth: { user: USER, pass: "wrong-password" },
      tls: verifiedTlsOptions([authority.certPem]),
      disableAutoIdle: true,
      logger: false,
    });
    await expect(client.connect()).rejects.toThrow();
    client.close();
    expect(server.sawWrite()).toBe(false);
  });

  it("expires the session with BYE on the next command", async () => {
    const server = await startImap();
    const client = await connect(server);
    server.faults.push({ kind: "bye", reason: "Session expired" });
    try {
      await expect(client.mailboxOpen("INBOX")).rejects.toThrow();
    } finally {
      client.close();
    }
  });

  it("drops the connection mid-protocol on a scripted fault", async () => {
    const server = await startImap();
    const client = await connect(server);
    server.faults.push({ kind: "drop" });
    try {
      await expect(client.mailboxOpen("INBOX")).rejects.toThrow();
    } finally {
      client.close();
    }
  });

  it("answers a tagged refusal without touching the mailbox", async () => {
    const server = await startImap();
    const client = await connect(server);
    try {
      await client.mailboxOpen("INBOX");
      server.faults.push({ kind: "no", code: "OVERQUOTA", text: "Quota exceeded" });
      // ImapFlow folds a tagged NO into a `false` result, not an error.
      const found = await client.search({ uid: "1:*" }, { uid: true });
      expect(found).toBe(false);
      expect(server.store.folder("INBOX")?.messages.size).toBe(3);
    } finally {
      await client.logout();
    }
  });
});

describe("the scripted IMAP server's input bounds", () => {
  /** One raw TLS connection, trusted the way the production clients trust. */
  function rawConnect(server: ScriptedImapServer): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: HOST, port: server.port, ...verifiedTlsOptions([authority.certPem]) });
      // A real client reads the greeting; an unread peer obscures the close.
      socket.on("data", () => undefined);
      socket.once("secureConnect", () => resolve(socket));
      socket.once("error", (error) => reject(error));
    });
  }

  it("destroys the connection when a line grows past the bound", async () => {
    const server = await startImap();
    const socket = await rawConnect(server);
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    // No line terminator: the unterminated remainder is what the bound stops.
    socket.write(`a1 NOOP ${"x".repeat(1_048_577)}`);
    await closed;
    expect(server.commands).toHaveLength(0);
  });

  it("destroys the connection on an oversized literal claim", async () => {
    const server = await startImap();
    const socket = await rawConnect(server);
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    // The claim alone crosses the bound; no literal bytes need to follow.
    socket.write(`a1 APPEND "Sent" {67108865}\r\n`);
    await closed;
    expect(server.commands).toHaveLength(0);
  });
});
