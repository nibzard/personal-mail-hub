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

export interface FakeSmtpServerOptions {
  mode: FakeSmtpMode;
  certificate: TestCertificate;
  /** The only accepted login. `null` rejects every attempt. */
  auth: { user: string; pass: string } | null;
}

/** One recorded command line with the phase it arrived in. */
export interface RecordedCommand {
  phase: "plaintext" | "tls";
  line: string;
}

export class FakeSmtpServer {
  /** The listening port, set once `start` resolves. */
  declare readonly port: number;
  private readonly options: FakeSmtpServerOptions;
  private readonly secureContext: tls.SecureContext;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private buffer = "";
  private upgraded = false;
  private loginStage: "user" | "pass" | null = null;
  private closed = false;

  /** Every command line the server received, in order. */
  readonly commands: RecordedCommand[] = [];

  private constructor(server: net.Server, options: FakeSmtpServerOptions) {
    this.server = server;
    this.options = options;
    this.secureContext = tls.createSecureContext({
      key: options.certificate.keyPem,
      cert: options.certificate.certPem,
    });
  }

  /** Start the server on an ephemeral loopback port. */
  static async start(options: FakeSmtpServerOptions): Promise<FakeSmtpServer> {
    const server =
      options.mode === "implicit"
        ? tls.createServer({ key: options.certificate.keyPem, cert: options.certificate.certPem })
        : net.createServer();
    if (options.mode === "implicit") {
      (server as tls.Server).on("secureConnection", (socket) => fake.onConnection(socket, "tls"));
    } else {
      server.on("connection", (socket) => fake.onConnection(socket, "plaintext"));
    }
    const fake = new FakeSmtpServer(server, options);
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

  /** True when any recorded line contains the given text. */
  sawText(text: string): boolean {
    return this.commands.some(({ line }) => line.includes(text));
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
    socket.on("data", (chunk: Buffer) => {
      this.receive(socket, chunk, phase === "tls" || this.upgraded);
    });
    socket.write("220 fake.example ESMTP Fake SMTP ready\r\n");
  }

  /** Buffer one chunk and dispatch the complete lines inside it. */
  private receive(socket: net.Socket, chunk: Buffer, secure: boolean): void {
    this.buffer += chunk.toString("binary");
    let index = this.buffer.indexOf("\r\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.handleLine(socket, line, secure);
      index = this.buffer.indexOf("\r\n");
    }
  }

  private handleLine(socket: net.Socket, line: string, secure: boolean): void {
    this.commands.push({ phase: secure ? "tls" : "plaintext", line });
    const command = line.toUpperCase();

    if (command === "STARTTLS") {
      if (secure) {
        socket.write("503 5.5.1 Already running TLS\r\n");
        return;
      }
      // A server that does not offer STARTTLS rejects the command outright.
      // The client cannot tell a missing offer from a refused upgrade until it
      // tries, and `requireTLS` clients do try.
      if (this.options.mode !== "starttls") {
        socket.write("454 4.7.0 TLS not available\r\n");
        return;
      }
      socket.write("220 2.0.0 Ready to start TLS\r\n");
      this.upgrade(socket);
      return;
    }

    if (command.startsWith("EHLO")) {
      socket.write("250-fake.example greets you\r\n");
      socket.write("250-PIPELINING\r\n");
      socket.write("250-SIZE 35882577\r\n");
      socket.write("250-AUTH PLAIN LOGIN\r\n");
      socket.write(!secure && this.options.mode === "starttls" ? "250 STARTTLS\r\n" : "250 OK\r\n");
      return;
    }

    if (command.startsWith("HELO")) {
      socket.write("250 fake.example\r\n");
      return;
    }

    if (command.startsWith("AUTH PLAIN")) {
      const payload = line.slice("AUTH PLAIN".length).trim();
      socket.write(
        this.checkPlainAuth(payload)
          ? "235 2.7.0 Authentication successful\r\n"
          : "535 5.7.8 Authentication credentials invalid\r\n",
      );
      return;
    }

    if (command === "AUTH LOGIN") {
      this.loginStage = "user";
      socket.write("334 VXNlcm5hbWU6\r\n");
      return;
    }

    // AUTH LOGIN continues with bare base64 lines, which carry no command verb.
    if (this.loginStage !== null && /^[A-Za-z0-9+/=]+$/.test(line)) {
      if (this.loginStage === "user") {
        this.loginStage = "pass";
        socket.write("334 UGFzc3dvcmQ6\r\n");
        return;
      }
      const pass = Buffer.from(line, "base64").toString("utf8");
      socket.write(
        this.options.auth !== null && pass === this.options.auth.pass
          ? "235 2.7.0 Authentication successful\r\n"
          : "535 5.7.8 Authentication credentials invalid\r\n",
      );
      this.loginStage = null;
      return;
    }

    if (command === "QUIT") {
      socket.write("221 2.0.0 Bye\r\n");
      socket.end();
      return;
    }

    socket.write("502 5.5.1 Command not implemented\r\n");
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
  private upgrade(socket: net.Socket): void {
    socket.removeAllListeners("data");
    socket.pause();
    const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext: this.secureContext });
    this.upgraded = true;
    secureSocket.on("error", () => {
      this.sockets.delete(socket);
    });
    secureSocket.on("data", (chunk: Buffer) => {
      this.receive(secureSocket, chunk, true);
    });
    secureSocket.resume();
  }
}
