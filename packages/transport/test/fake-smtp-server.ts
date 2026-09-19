import net from "node:net";
import tls from "node:tls";
import type { TestCertificate } from "./test-certificates.ts";

/**
 * A minimal scripted SMTP server for the transport suite.
 *
 * Modes cover the three sessions the connection test can meet: a server
 * that offers STARTTLS, one that does not, and implicit TLS. The EHLO
 * response advertises authentication so the test has something to verify,
 * and the server accepts or rejects the offered credentials. Command lines
 * are recorded per phase — plaintext before the upgrade, TLS after it — so
 * the tests can prove the client sent no credentials and no mail before a
 * verified encrypted channel existed (SPEC section 12).
 */

/** The session shapes the fake server can present. */
export type FakeSmtpMode = "starttls" | "starttls-missing" | "implicit";

/**
 * One scripted submission conversation (SPEC F7 and section 12). The defaults
 * accept everything; each field bends one stage so tests can prove the
 * client's outcome classification.
 */
export interface FakeSmtpSubmissionScript {
  /** Addresses rejected at `RCPT TO`, given `550` (default: none). */
  rejectedRecipients?: string[];
  /** Reject the sender at `MAIL FROM` with `550` (default: false). */
  rejectSender?: boolean;
  /** The final response after the message data (default: `250 2.0.0 Ok: queued`). */
  finalResponse?: string;
  /** Drop the connection after the message data instead of answering. */
  dropAfterData?: boolean;
}

export interface FakeSmtpServerOptions {
  mode: FakeSmtpMode;
  certificate: TestCertificate;
  /** The only accepted login. `null` rejects every attempt. */
  auth: { user: string; pass: string } | null;
  /** Submission behavior. Without it the server refuses mail commands. */
  submission?: FakeSmtpSubmissionScript;
  /** Advertise `AUTH` in the EHLO response (default: true). */
  advertiseAuth?: boolean;
}

/** One recorded command line with the phase it arrived in. */
export interface RecordedCommand {
  phase: "plaintext" | "tls";
  line: string;
  /**
   * The decoded SASL payload when the line carried base64 credentials.
   * `AUTH LOGIN` and `AUTH PLAIN` move the password encoded, so an assertion
   * on the raw line alone proves nothing about what a tap could read.
   */
  decoded?: string;
}

/**
 * The longest line the server tolerates, in bytes. A client that never sends
 * a line terminator must not grow the buffer without end, so a longer line or
 * an unterminated remainder destroys the connection.
 */
const MAX_LINE_BYTES = 1_048_576;

export class FakeSmtpServer {
  /** The listening port, set once `start` resolves. */
  declare readonly port: number;
  private readonly options: FakeSmtpServerOptions;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private closed = false;

  /** Every command line the server received, in order. */
  readonly commands: RecordedCommand[] = [];

  /** The envelope sender of the current submission, as the client stated it. */
  mailFrom: string | null = null;

  /** Every envelope recipient the server accepted, in order. */
  acceptedRecipients: string[] = [];

  /** The message data lines of the current submission, exactly as received. */
  dataLines: string[] = [];

  private constructor(server: net.Server, options: FakeSmtpServerOptions) {
    this.server = server;
    this.options = options;
  }

  /** Start the server on an ephemeral loopback port. */
  static async start(options: FakeSmtpServerOptions): Promise<FakeSmtpServer> {
    const server =
      options.mode === "implicit"
        ? tls.createServer({ key: options.certificate.keyPem, cert: options.certificate.certPem })
        : net.createServer();
    const fake = new FakeSmtpServer(server, options);
    if (options.mode === "implicit") {
      (server as tls.Server).on("secureConnection", (socket) => fake.onConnection(socket, "tls"));
    } else {
      server.on("connection", (socket) => fake.onConnection(socket, "plaintext"));
    }
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
      setTimeout(resolve, 200).unref();
    });
  }

  /** True when any command line began an authentication exchange. */
  sawAuthentication(): boolean {
    return this.commands.some(({ line }) => /^AUTH\b/i.test(line));
  }

  /** True when the client attempted any mail submission. */
  sawMailSubmission(): boolean {
    return this.commands.some(({ line }) => /^(MAIL FROM|RCPT TO|DATA|BDAT)\b/i.test(line));
  }

  /** True when an authentication command arrived before TLS existed. */
  sawAuthenticationInPlaintext(): boolean {
    return this.commands.some(({ phase, line }) => phase === "plaintext" && /^AUTH\b/i.test(line));
  }

  /** True when an authentication command arrived over the encrypted channel. */
  sawAuthenticationOverTls(): boolean {
    return this.commands.some(({ phase, line }) => phase === "tls" && /^AUTH\b/i.test(line));
  }

  /** True when any recorded line contains the given text, decoded payloads included. */
  sawText(text: string): boolean {
    return this.commands.some(({ line, decoded }) => line.includes(text) || (decoded?.includes(text) ?? false));
  }

  /** True when the text appeared in a plaintext-phase line, decoded payloads included. */
  sawTextInPlaintext(text: string): boolean {
    return this.commands.some(
      ({ phase, line, decoded }) => phase === "plaintext" && (line.includes(text) || (decoded?.includes(text) ?? false)),
    );
  }

  /**
   * The submitted message bytes with SMTP dot-unstuffing applied. Compares
   * byte for byte against the MIME object the client was told to submit.
   */
  receivedMessage(): Buffer {
    return Buffer.from(
      this.dataLines.map((line) => (line.startsWith(".") ? line.slice(1) : line)).join("\r\n"),
      "binary",
    );
  }

  private onConnection(socket: net.Socket, phase: "plaintext" | "tls"): void {
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
    // One session per connection: the buffer, the upgrade state, and the
    // login stage never cross connections, so a second connection to an
    // upgraded server is still labeled plaintext until it upgrades itself.
    new FakeSmtpSession(socket, phase, this.options, this).start();
  }
}

/** One SMTP conversation over one socket. */
class FakeSmtpSession {
  private buffer = "";
  /** The socket responses go to: the raw socket, or its TLS wrapper. */
  private transport: net.Socket;
  private upgraded: boolean;
  private loginStage: "user" | "pass" | null = null;
  private inDataMode = false;
  private readonly secureContext: tls.SecureContext;

  constructor(
    private readonly socket: net.Socket,
    phase: "plaintext" | "tls",
    private readonly options: FakeSmtpServerOptions,
    private readonly owner: FakeSmtpServer,
  ) {
    this.upgraded = phase === "tls";
    this.transport = socket;
    this.secureContext = tls.createSecureContext({
      key: options.certificate.keyPem,
      cert: options.certificate.certPem,
    });
  }

  start(): void {
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.transport.write("220 fake.example ESMTP Fake SMTP ready\r\n");
  }

  /** Buffer one chunk and dispatch the complete lines inside it. */
  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString("binary");
    let index = this.buffer.indexOf("\r\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      if (line.length > MAX_LINE_BYTES) {
        this.socket.destroy();
        return;
      }
      this.handleLine(line);
      index = this.buffer.indexOf("\r\n");
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.socket.destroy();
    }
  }

  private handleLine(line: string): void {
    if (this.inDataMode) {
      this.receiveDataLine(line);
      return;
    }

    const decoded = decodedAuthPayload(line, this.loginStage);
    this.owner.commands.push({
      phase: this.upgraded ? "tls" : "plaintext",
      line,
      ...(decoded === null ? {} : { decoded }),
    });
    const command = line.toUpperCase();

    if (command.startsWith("MAIL FROM")) {
      const script = this.options.submission;
      if (script === undefined) {
        this.transport.write("503 5.5.1 This server accepts no mail\r\n");
        return;
      }
      if (script.rejectSender) {
        this.transport.write("550 5.7.1 Sender rejected\r\n");
        return;
      }
      this.owner.mailFrom = envelopeAddress(line);
      this.transport.write("250 2.1.0 Ok\r\n");
      return;
    }

    if (command.startsWith("RCPT TO")) {
      const script = this.options.submission;
      if (script === undefined) {
        this.transport.write("503 5.5.1 This server accepts no mail\r\n");
        return;
      }
      const address = envelopeAddress(line);
      if (script.rejectedRecipients?.includes(address) === true) {
        this.transport.write(`550 5.1.1 <${address}> User unknown\r\n`);
        return;
      }
      this.owner.acceptedRecipients.push(address);
      this.transport.write("250 2.1.5 Ok\r\n");
      return;
    }

    if (command === "DATA") {
      const script = this.options.submission;
      if (script === undefined) {
        this.transport.write("503 5.5.1 This server accepts no mail\r\n");
        return;
      }
      this.inDataMode = true;
      this.owner.dataLines = [];
      this.transport.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      return;
    }

    if (command === "STARTTLS") {
      if (this.upgraded) {
        this.transport.write("503 5.5.1 Already running TLS\r\n");
        return;
      }
      // A server that does not offer STARTTLS rejects the command outright.
      // The client cannot tell a missing offer from a refused upgrade until it
      // tries, and `requireTLS` clients do try.
      if (this.options.mode !== "starttls") {
        this.transport.write("454 4.7.0 TLS not available\r\n");
        return;
      }
      this.transport.write("220 2.0.0 Ready to start TLS\r\n");
      this.upgrade();
      return;
    }

    if (command.startsWith("EHLO")) {
      this.transport.write("250-fake.example greets you\r\n");
      this.transport.write("250-PIPELINING\r\n");
      this.transport.write("250-SIZE 35882577\r\n");
      if (this.options.advertiseAuth !== false) {
        this.transport.write("250-AUTH PLAIN LOGIN\r\n");
      }
      this.transport.write(!this.upgraded && this.options.mode === "starttls" ? "250 STARTTLS\r\n" : "250 OK\r\n");
      return;
    }

    if (command.startsWith("HELO")) {
      this.transport.write("250 fake.example\r\n");
      return;
    }

    if (command.startsWith("AUTH PLAIN")) {
      if (this.options.advertiseAuth === false) {
        // A server that advertised no AUTH refuses the command, the way a
        // real one answers a capability the session never offered.
        this.transport.write("502 5.5.1 Authentication not advertised\r\n");
        return;
      }
      const payload = line.slice("AUTH PLAIN".length).trim();
      this.transport.write(
        this.checkPlainAuth(payload)
          ? "235 2.7.0 Authentication successful\r\n"
          : "535 5.7.8 Authentication credentials invalid\r\n",
      );
      return;
    }

    if (command === "AUTH LOGIN") {
      if (this.options.advertiseAuth === false) {
        this.transport.write("502 5.5.1 Authentication not advertised\r\n");
        return;
      }
      this.loginStage = "user";
      this.transport.write("334 VXNlcm5hbWU6\r\n");
      return;
    }

    // AUTH LOGIN continues with bare base64 lines, which carry no command verb.
    if (this.loginStage !== null && /^[A-Za-z0-9+/=]+$/.test(line)) {
      if (this.loginStage === "user") {
        this.loginStage = "pass";
        this.transport.write("334 UGFzc3dvcmQ6\r\n");
        return;
      }
      const pass = Buffer.from(line, "base64").toString("utf8");
      this.transport.write(
        this.options.auth !== null && pass === this.options.auth.pass
          ? "235 2.7.0 Authentication successful\r\n"
          : "535 5.7.8 Authentication credentials invalid\r\n",
      );
      this.loginStage = null;
      return;
    }

    if (command === "QUIT") {
      this.transport.write("221 2.0.0 Bye\r\n");
      this.transport.end();
      return;
    }

    this.transport.write("502 5.5.1 Command not implemented\r\n");
  }

  /** Collect one message-data line; the terminating dot ends the transfer. */
  private receiveDataLine(line: string): void {
    if (line !== ".") {
      this.owner.dataLines.push(line);
      return;
    }
    this.inDataMode = false;
    const script = this.options.submission;
    if (script?.dropAfterData === true) {
      // The final response is lost; the client cannot know the outcome.
      this.transport.destroy();
      return;
    }
    this.transport.write(`${script?.finalResponse ?? "250 2.0.0 Ok: queued"}\r\n`);
  }

  /** Validate one `AUTH PLAIN <base64>` payload against the accepted login. */
  private checkPlainAuth(payload: string): boolean {
    const expected = this.options.auth;
    if (expected === null || payload === "") {
      return false;
    }
    // SASL PLAIN is authzid, authcid, and password, each NUL-separated.
    const parts = Buffer.from(payload, "base64").toString("utf8").split("\0");
    return parts.length === 3 && parts[1] === expected.user && parts[2] === expected.pass;
  }

  /** Wrap the plaintext socket in TLS after the client's STARTTLS. */
  private upgrade(): void {
    this.socket.removeAllListeners("data");
    this.socket.pause();
    const secureSocket = new tls.TLSSocket(this.socket, { isServer: true, secureContext: this.secureContext });
    this.upgraded = true;
    this.transport = secureSocket;
    secureSocket.on("error", () => undefined);
    secureSocket.on("data", (chunk: Buffer) => this.receive(chunk));
    secureSocket.resume();
  }
}

/**
 * The decoded SASL payload of one authentication line: the NUL-separated
 * PLAIN tuple, or the bare LOGIN credential the stage expects. Null for
 * lines that carry none.
 */
function decodedAuthPayload(line: string, loginStage: "user" | "pass" | null): string | null {
  if (/^AUTH PLAIN \S/i.test(line)) {
    return Buffer.from(line.slice("AUTH PLAIN".length).trim(), "base64").toString("utf8");
  }
  if (loginStage !== null && /^[A-Za-z0-9+/=]+$/.test(line)) {
    return Buffer.from(line, "base64").toString("utf8");
  }
  return null;
}

/** The bare address of one `MAIL FROM:<addr>` or `RCPT TO:<addr>` line. */
function envelopeAddress(line: string): string {
  const start = line.indexOf("<");
  const end = line.indexOf(">", start);
  if (start === -1 || end === -1) {
    return line;
  }
  return line.slice(start + 1, end);
}
