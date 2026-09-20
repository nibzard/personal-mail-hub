import net from "node:net";
import { createTestAuthority } from "../src/certificates.ts";
import { ScriptedSmtpServer } from "../src/smtp-server.ts";

/**
 * A one-shot child the SMTP suite spawns. It drives one submission whose
 * final answer is delayed far past the child's life, closes the connection,
 * and stops the server. The parent asserts the process exits on its own: a
 * final-answer timer the close did not clear holds the event loop open for
 * the whole delay, and a child that exits proved the timer was cleared.
 */

async function main(): Promise<void> {
  const authority = createTestAuthority();
  const certificate = authority.issue({ hosts: ["localhost"], ips: ["127.0.0.1"] });
  const server = await ScriptedSmtpServer.start({
    mode: "starttls",
    certificate,
    auth: { user: "user@example.com", pass: "mailbox-secret" },
    submission: { delayFinalResponseMs: 60_000 },
  });
  const socket = net.createConnection({ host: "127.0.0.1", port: server.port });
  // A real client reads what the server sends; an unread peer obscures close.
  socket.on("data", () => undefined);
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const send = (line: string): void => {
    socket.write(`${line}\r\n`);
  };
  send("EHLO probe.example");
  send("MAIL FROM:<user@example.com>");
  send("RCPT TO:<to@example.com>");
  send("DATA");
  send("Subject: exit probe");
  // The terminating dot arms the delayed answer; give the server a beat to
  // read it, then walk away without reading the answer.
  send(".");
  await new Promise((resolve) => setTimeout(resolve, 250));
  socket.destroy();
  await new Promise<void>((resolve) => socket.once("close", resolve));
  await server.stop();
}

main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
