import tls from "node:tls";
import type { TestCertificate } from "./test-certificates.ts";

/**
 * A minimal scripted IMAP4rev1 server for the transport suite.
 *
 * It speaks just enough of the protocol for a connection test: greeting with
 * capabilities, LOGIN, LIST, per-folder STATUS, LSUB, and LOGOUT. The suite
 * configures it to accept or reject the login. Every command line is
 * recorded with the phase it arrived in, so the tests can prove that
 * credentials never moved before a verified TLS connection existed
 * (SPEC section 12).
 */

/** One folder the fake server lists, with the counts STATUS reports. */
export interface FakeImapFolder {
  name: string;
  /** LIST flags, for example `\\Sent` or `\\HasNoChildren`. */
  flags?: string[];
  messages?: number;
  unseen?: number;
}

export interface FakeImapServerOptions {
  certificate: TestCertificate;
  /** The only accepted login. `null` rejects every attempt. */
  auth: { user: string; pass: string } | null;
  folders?: FakeImapFolder[];
}

/** Capabilities offered before and after the login. */
const PREAUTH_CAPABILITIES = "IMAP4rev1 SPECIAL-USE";
const POSTAUTH_CAPABILITIES = "IMAP4rev1 IDLE SPECIAL-USE";

/** One recorded command line. */
export interface RecordedCommand {
  phase: "tls" | "plaintext";
  line: string;
}

export class FakeImapServer {
  /** The listening port, set once `start` resolves. */
  declare readonly port: number;
  private readonly server: tls.Server;
  private readonly sockets = new Set<tls.TLSSocket>();
  private readonly options: FakeImapServerOptions;
  private buffer = "";
  private authenticated = false;
  private closed = false;

  /** Every command line the server received, in order. */
  readonly commands: RecordedCommand[] = [];
  /** TLS handshakes the client abandoned, which is how a rejected certificate looks here. */
  handshakeFailures = 0;

  private constructor(server: tls.Server, options: FakeImapServerOptions) {
    this.server = server;
    this.options = options;
  }

  /** Start the server on an ephemeral loopback port. */
  static async start(options: FakeImapServerOptions): Promise<FakeImapServer> {
    const server = tls.createServer({ key: options.certificate.keyPem, cert: options.certificate.certPem });
    server.on("secureConnection", (socket) => fake.onConnection(socket));
    server.on("tlsClientError", () => {
      fake.handshakeFailures += 1;
    });
    const fake = new FakeImapServer(server, options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    Object.defineProperty(fake, "port", { value: (server.address() as { port: number }).port });
    return fake;
  }

  /** Stop the server and drop every connection. */
  async stop(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // Connections already destroyed let close finish; guard against strays.
      setTimeout(resolve, 200).unref();
    });
  }

  /** True when any command carried the login credentials, in any phase. */
  sawCredentials(user: string, pass: string): boolean {
    return (
      this.commands.some(({ line }) => line.includes(pass)) ||
      this.commands.some(({ line }) => /^(\S+)\s+(LOGIN|AUTHENTICATE)/i.test(line) && line.includes(user))
    );
  }

  /** True when a login command arrived inside the TLS phase. */
  sawLoginOverTls(): boolean {
    return this.commands.some(({ phase, line }) => phase === "tls" && /^(\S+)\s+(LOGIN|AUTHENTICATE)/i.test(line));
  }

  private onConnection(socket: tls.TLSSocket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("error", () => {
      this.sockets.delete(socket);
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("binary");
      let index = this.buffer.indexOf("\r\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.handleLine(socket, line);
        index = this.buffer.indexOf("\r\n");
      }
    });
    // The greeting carries the pre-authentication capabilities.
    socket.write(`* OK [CAPABILITY ${PREAUTH_CAPABILITIES}] Fake IMAP ready\r\n`);
  }

  private handleLine(socket: tls.TLSSocket, line: string): void {
    // Everything on this server arrives over TLS; the phase marker exists so
    // assertions read the same way as the SMTP suite's.
    this.commands.push({ phase: "tls", line });
    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (match === null) {
      return;
    }
    const [, tag = "", command = "", rest = ""] = match;

    switch (command.toUpperCase()) {
      case "CAPABILITY":
        socket.write(`* CAPABILITY ${this.authenticated ? POSTAUTH_CAPABILITIES : PREAUTH_CAPABILITIES}\r\n`);
        socket.write(`${tag} OK CAPABILITY completed\r\n`);
        return;
      case "LOGIN": {
        const credentials = parseLoginArgs(rest);
        if (credentials !== null && this.accepts(credentials)) {
          this.authenticated = true;
          socket.write(`${tag} OK [CAPABILITY ${POSTAUTH_CAPABILITIES}] Logged in\r\n`);
        } else {
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
        return;
      }
      case "AUTHENTICATE":
        socket.write(`${tag} NO [AUTHENTICATIONFAILED] Not supported\r\n`);
        return;
      case "ENABLE":
        socket.write(`${tag} OK ENABLE ignored\r\n`);
        return;
      case "LIST": {
        // The empty pattern asks for the hierarchy delimiter, not the folders.
        if (parseMailboxArgs(rest).pattern === "") {
          socket.write('* LIST (\\Noselect) "/" ""\r\n');
          socket.write(`${tag} OK LIST completed\r\n`);
          return;
        }
        for (const folder of this.options.folders ?? []) {
          const flags = folder.flags ?? ["\\HasNoChildren"];
          socket.write(`* LIST (${flags.join(" ")}) "/" "${folder.name}"\r\n`);
        }
        socket.write(`${tag} OK LIST completed\r\n`);
        return;
      }
      case "LSUB":
        socket.write(`${tag} OK LSUB completed\r\n`);
        return;
      case "STATUS": {
        const target = parseMailboxArg(rest);
        const folder = (this.options.folders ?? []).find((candidate) => candidate.name === target);
        const items = [...(rest.match(/\(([A-Z0-9= ]+)\)/)?.[1]?.split(/\s+/) ?? [])];
        if (folder === undefined || items.length === 0) {
          socket.write(`${tag} BAD STATUS not understood\r\n`);
          return;
        }
        const values = items
          .map((item) => {
            if (item === "MESSAGES") {
              return `MESSAGES ${folder.messages ?? 0}`;
            }
            if (item === "UNSEEN") {
              return `UNSEEN ${folder.unseen ?? 0}`;
            }
            return `${item} 0`;
          })
          .join(" ");
        socket.write(`* STATUS "${folder.name}" (${values})\r\n`);
        socket.write(`${tag} OK STATUS completed\r\n`);
        return;
      }
      case "LOGOUT":
        socket.write(`* BYE Fake IMAP closing\r\n`);
        socket.write(`${tag} OK LOGOUT completed\r\n`);
        socket.end();
        return;
      case "NOOP":
        socket.write(`${tag} OK NOOP completed\r\n`);
        return;
      default:
        socket.write(`${tag} BAD Unrecognized command\r\n`);
    }
  }

  private accepts(credentials: { user: string; pass: string }): boolean {
    const expected = this.options.auth;
    return expected !== null && credentials.user === expected.user && credentials.pass === expected.pass;
  }
}

/** Parse the two quoted arguments of a LOGIN command. */
function parseLoginArgs(rest: string): { user: string; pass: string } | null {
  const match = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/.exec(rest.trim());
  if (match === null) {
    return null;
  }
  return { user: unescape(match[1]!), pass: unescape(match[2]!) };
}

/** Parse the reference and pattern arguments of a LIST command. */
function parseMailboxArgs(rest: string): { reference: string; pattern: string } {
  const [reference = "", pattern = ""] = tokenize(rest);
  return { reference, pattern };
}

/** Parse the single mailbox argument of a STATUS command, quoted or bare. */
function parseMailboxArg(rest: string): string {
  return tokenize(rest)[0] ?? "";
}

/** Split a command's argument list into quoted strings and atoms. */
function tokenize(rest: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of rest.matchAll(pattern)) {
    tokens.push(match[1] !== undefined ? unescape(match[1]) : (match[2] ?? ""));
  }
  return tokens;
}

/** Undo the IMAP quoted-string escaping. */
function unescape(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}
