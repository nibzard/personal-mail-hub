import net from "node:net";
import tls from "node:tls";
import type { TestCertificate } from "./certificates.ts";

/**
 * The scripted SMTP server of the send-safety harness (SPEC F7 and
 * section 12).
 *
 * The session shapes match the account settings: required STARTTLS, implicit
 * TLS, and a server that offers no upgrade. The submission script bends one
 * stage of one conversation — refused senders, refused or deferred
 * recipients, a refused DATA, a lost final response, a connection dropped
 * mid-message, and a final answer that never comes before a short socket
 * timeout — so the suites can prove the outcome classification and the
 * duplicate-safety rules against the production submitter.
 *
 * Every submission attempt is recorded whole: envelope, accepted and refused
 * recipients, and the exact received bytes. The suites count SMTP
 * submissions here and Sent copies on the IMAP server, independently.
 */

/** The session shapes the scripted server can present. */
export type ScriptedSmtpMode = "starttls" | "starttls-missing" | "implicit";

/**
 * One scripted submission conversation (SPEC F7 and section 12). The defaults
 * accept everything; each field bends one stage so the suites can prove the
 * client's outcome classification and its duplicate safety.
 */
export interface SmtpSubmissionScript {
  /** Addresses rejected at `RCPT TO` with `550` (default: none). */
  rejectedRecipients?: string[];
  /** Addresses deferred at `RCPT TO` with `451` (default: none). */
  deferredRecipients?: string[];
  /** Reject the sender at `MAIL FROM` with `550` (default: false). */
  rejectSender?: boolean;
  /** Refuse the `DATA` command itself with `554` (default: false). */
  rejectDataCommand?: boolean;
  /**
   * The final response after the message data (default: `250 2.0.0 Ok:
   * queued`). Anything but a `2xx` line refuses the message after it flowed.
   */
  finalResponse?: string;
  /** Drop the connection after the final dot instead of answering. */
  dropAfterData?: boolean;
  /**
   * Drop the connection part way through the message data, before the
   * terminating dot. The submission is incomplete and unclassifiable.
   */
  dropDuringData?: boolean;
  /** Hold the final response, so a client with a short socket timeout gives up. */
  delayFinalResponseMs?: number;
}

export interface ScriptedSmtpServerOptions {
  mode: ScriptedSmtpMode;
  certificate: TestCertificate;
  /** The only accepted login. `null` rejects every attempt. */
  auth: { user: string; pass: string } | null;
  /**
   * The greeting line. A `4xx` greeting scripts a server that refuses the
   * session before any mail command (default: a `220` greeting).
   */
  greeting?: string;
  /** Submission behavior. Without it the server refuses mail commands. */
  submission?: SmtpSubmissionScript;
}

/** One recorded command line with the phase it arrived in. */
export interface RecordedSmtpCommand {
  phase: "plaintext" | "tls";
  line: string;
}

/** One submission attempt, complete or not. */
export interface RecordedSubmission {
  /** The envelope sender, as the client stated it. */
  mailFrom: string | null;
  /** Recipients the server accepted, in order. */
  acceptedRecipients: string[];
  /** Recipients the server refused or deferred, with the response line. */
  rejectedRecipients: { address: string; response: string }[];
  /**
   * The message bytes with SMTP dot-unstuffing applied, when the terminating
   * dot arrived. Null for attempts cut off inside the data.
   */
  message: Buffer | null;
}

export class ScriptedSmtpServer {
  /** The listening port, set once `start` resolves. */
  declare readonly port: number;
  /** Every command line the server received, in order. */
  readonly commands: RecordedSmtpCommand[] = [];
  /** Every submission attempt, in order, including refused and cut-off ones. */
  readonly submissions: RecordedSubmission[] = [];

  private readonly options: ScriptedSmtpServerOptions;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private closed = false;

  private constructor(server: net.Server, options: ScriptedSmtpServerOptions) {
    this.server = server;
    this.options = options;
  }

  /** Start the server on an ephemeral loopback port. */
  static async start(options: ScriptedSmtpServerOptions): Promise<ScriptedSmtpServer> {
    const server =
      options.mode === "implicit"
        ? tls.createServer({ key: options.certificate.keyPem, cert: options.certificate.certPem })
        : net.createServer();
    const scripted = new ScriptedSmtpServer(server, options);
    if (options.mode === "implicit") {
      (server as tls.Server).on("secureConnection", (socket) => scripted.onConnection(socket, "tls"));
    } else {
      server.on("connection", (socket) => scripted.onConnection(socket, "plaintext"));
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    Object.defineProperty(scripted, "port", {
      value: (server.address() as { port: number }).port,
    });
    return scripted;
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

  /** Submission attempts whose terminating dot arrived: the accepted count. */
  completedSubmissions(): RecordedSubmission[] {
    return this.submissions.filter((attempt) => attempt.message !== null);
  }

  /** True when any recorded line contains the given text. */
  sawText(text: string): boolean {
    return this.commands.some(({ line }) => line.includes(text));
  }

  /** True when the client attempted any mail submission. */
  sawMailSubmission(): boolean {
    return this.commands.some(({ line }) => /^(MAIL FROM|RCPT TO|DATA|BDAT)\b/i.test(line));
  }

  private onConnection(socket: net.Socket, phase: "plaintext" | "tls"): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const session = new SmtpSession(socket, phase, this.options, this.commands, this.submissions);
    session.start();
    socket.on("error", () => {
      this.sockets.delete(socket);
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
  }
}

/** One SMTP conversation over one socket. */
class SmtpSession {
  private buffer = "";
  /** The socket responses go to: the raw socket, or its TLS wrapper. */
  private transport: net.Socket;
  private upgraded: boolean;
  private loginStage: "user" | "pass" | null = null;
  private inDataMode = false;
  private droppedDuringData = false;
  private dataLines: string[] = [];
  private readonly secureContext: tls.SecureContext;

  constructor(
    private readonly socket: net.Socket,
    phase: "plaintext" | "tls",
    private readonly options: ScriptedSmtpServerOptions,
    private readonly log: RecordedSmtpCommand[],
    private readonly submissions: RecordedSubmission[],
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
    this.transport.write(`${this.options.greeting ?? "220 scripted.example ESMTP Scripted SMTP ready"}\r\n`);
  }

  /** Buffer one chunk and dispatch the complete lines inside it. */
  private receive(chunk: Buffer): void {
    if (this.droppedDuringData) {
      return;
    }
    this.buffer += chunk.toString("binary");
    let index = this.buffer.indexOf("\r\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.handleLine(line);
      index = this.buffer.indexOf("\r\n");
    }
  }

  private handleLine(line: string): void {
    if (this.inDataMode) {
      this.receiveDataLine(line);
      return;
    }

    this.log.push({ phase: this.secure() ? "tls" : "plaintext", line });
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
      this.current().mailFrom = envelopeAddress(line);
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
      const rejection = script.rejectedRecipients?.includes(address) === true;
      const deferral = script.deferredRecipients?.includes(address) === true;
      if (rejection || deferral) {
        const response = rejection ? `550 5.1.1 <${address}> User unknown` : `451 4.2.0 <${address}> Mailbox busy`;
        this.current().rejectedRecipients.push({ address, response });
        this.transport.write(`${response}\r\n`);
        return;
      }
      this.current().acceptedRecipients.push(address);
      this.transport.write("250 2.1.5 Ok\r\n");
      return;
    }

    if (command === "DATA") {
      const script = this.options.submission;
      if (script === undefined) {
        this.transport.write("503 5.5.1 This server accepts no mail\r\n");
        return;
      }
      if (script.rejectDataCommand) {
        this.transport.write("554 5.7.1 Message refused\r\n");
        return;
      }
      this.inDataMode = true;
      this.dataLines = [];
      this.transport.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      return;
    }

    if (command === "STARTTLS") {
      if (this.secure()) {
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
      this.transport.write("250-scripted.example greets you\r\n");
      this.transport.write("250-PIPELINING\r\n");
      this.transport.write("250-SIZE 35882577\r\n");
      this.transport.write("250-AUTH PLAIN LOGIN\r\n");
      this.transport.write(!this.secure() && this.options.mode === "starttls" ? "250 STARTTLS\r\n" : "250 OK\r\n");
      return;
    }

    if (command.startsWith("HELO")) {
      this.transport.write("250 scripted.example\r\n");
      return;
    }

    if (command.startsWith("AUTH PLAIN")) {
      const payload = line.slice("AUTH PLAIN".length).trim();
      this.transport.write(
        this.checkPlainAuth(payload)
          ? "235 2.7.0 Authentication successful\r\n"
          : "535 5.7.8 Authentication credentials invalid\r\n",
      );
      return;
    }

    if (command === "AUTH LOGIN") {
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
    const script = this.options.submission;
    if (line !== ".") {
      this.dataLines.push(line);
      if (script?.dropDuringData === true && this.dataLines.length >= 1) {
        // Mid-message cut: no terminating dot, no final response, no record.
        this.droppedDuringData = true;
        this.current().message = null;
        this.transport.destroy();
      }
      return;
    }
    this.inDataMode = false;
    const attempt = this.current();
    attempt.message = unstuffed(this.dataLines);
    if (script?.dropAfterData === true) {
      // The final response is lost; the client cannot know the outcome.
      this.transport.destroy();
      return;
    }
    const delay = script?.delayFinalResponseMs ?? 0;
    const respond = (): void => {
      this.transport.write(`${script?.finalResponse ?? "250 2.0.0 Ok: queued"}\r\n`);
    };
    if (delay > 0) {
      setTimeout(respond, delay);
      return;
    }
    respond();
  }

  /** The submission attempt in progress, created on first envelope use. */
  private current(): RecordedSubmission {
    let attempt = this.submissions[this.submissions.length - 1];
    if (attempt === undefined || attempt.message !== null) {
      attempt = { mailFrom: null, acceptedRecipients: [], rejectedRecipients: [], message: null };
      this.submissions.push(attempt);
    }
    return attempt;
  }

  private secure(): boolean {
    return this.upgraded;
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
    const secureSocket = new tls.TLSSocket(this.socket, {
      isServer: true,
      secureContext: this.secureContext,
    });
    this.upgraded = true;
    this.transport = secureSocket;
    secureSocket.on("error", () => undefined);
    secureSocket.on("data", (chunk: Buffer) => this.receive(chunk));
    secureSocket.resume();
  }
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

/** Undo SMTP dot-stuffing on the received lines. */
function unstuffed(lines: string[]): Buffer {
  return Buffer.from(
    lines.map((line) => (line.startsWith(".") ? line.slice(1) : line)).join("\r\n"),
    "binary",
  );
}
