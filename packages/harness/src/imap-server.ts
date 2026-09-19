import tls from "node:tls";
import type { TestCertificate } from "./certificates.ts";
import {
  messagesAscending,
  uidsAscending,
  ScriptedMailboxStore,
  type StoredImapFolder,
  type StoredImapMessage,
} from "./mailbox-store.ts";

/**
 * The scripted IMAP server of the fake mailbox harness (SPEC section 12).
 *
 * It speaks real IMAP4rev1 over implicit TLS — greeting, login, folder
 * listing, selection with `UIDVALIDITY` and `UIDNEXT`, UID search and fetch
 * with literals, conditional and plain flag stores, UIDPLUS moves and
 * appends — so the production clients (ImapFlow sessions, the send and
 * action paths built on them) run against it unmodified.
 *
 * The scenarios come from two places. The store holds the mailbox state, and
 * tests change it between commands to script arrivals, server expunges, and
 * generation changes. The fault queue bends the protocol itself: dropped
 * connections, `BYE` before a session expires, tagged refusals, stalled
 * responses, and appends whose answer never arrives. One fault is consumed
 * per command, so a test scripts exactly the failure it means.
 */

/** Capabilities the scripted server advertises. */
const CAPABILITIES = "IMAP4rev1 ENABLE UIDPLUS MOVE CONDSTORE SPECIAL-USE NAMESPACE";

const SYSTEM_FLAGS = ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft"];

/**
 * One scripted protocol fault, consumed by the next command the server
 * receives on any connection.
 */
export type ScriptedImapFault =
  /** Destroy the connection before answering. */
  | { kind: "drop" }
  /** Say `BYE`, then close: the shape of an expired session. */
  | { kind: "bye"; reason?: string }
  /** Answer the command with a tagged `NO`. */
  | { kind: "no"; text?: string; code?: string }
  /** Answer the command with a tagged `BAD`. */
  | { kind: "bad"; text?: string }
  /** Hold the answer, so a client with a short socket timeout gives up. */
  | { kind: "delay"; ms: number }
  /**
   * Store the next `APPEND` but destroy the connection before the response.
   * The copy exists; the client cannot know (SPEC F7 step 5).
   */
  | { kind: "lost-append-response" };

export interface ScriptedImapServerOptions {
  certificate: TestCertificate;
  /** The only accepted login. `null` rejects every attempt. */
  auth: { user: string; pass: string } | null;
  /** The mailbox state. One fresh store is created when omitted. */
  store?: ScriptedMailboxStore;
}

/** One recorded command line, without literal payloads. */
export interface RecordedImapCommand {
  connection: number;
  line: string;
}

/** One append the server accepted, as the Sent-copy counter reads it. */
export interface RecordedAppend {
  folder: string;
  uid: number;
  uidvalidity: number;
  bytes: Buffer;
}

/** One parsed argument token of a command line. */
type Token =
  | {
      type: "atom";
      value: string;
      section: string | null;
      /** The `<origin.count>` byte range attached to a section, when present. */
      partial?: { start: number; count: number | null };
    }
  | { type: "string"; value: string }
  | { type: "list"; items: Token[] }
  | { type: "literal"; value: Buffer };

/** The per-connection state the protocol needs. */
interface ConnectionState {
  socket: tls.TLSSocket;
  authenticated: boolean;
  enabled: Set<string>;
  selected: StoredImapFolder | null;
  /** The message set this connection has already reported, ascending UIDs. */
  view: number[];
}

export class ScriptedImapServer {
  /** The listening port, set once `start` resolves. */
  declare readonly port: number;
  /** The mailbox state every connection shares. */
  readonly store: ScriptedMailboxStore;
  /** Faults to consume, one per command. Push to script the next failure. */
  readonly faults: ScriptedImapFault[] = [];
  /** Every command line the server received, in order. */
  readonly commands: RecordedImapCommand[] = [];
  /** Every append the server stored, in order. */
  readonly appends: RecordedAppend[] = [];
  /** Connections accepted and still open. */
  openConnections = 0;

  private readonly server: tls.Server;
  private readonly options: ScriptedImapServerOptions;
  private nextConnectionId = 1;
  private closed = false;

  private constructor(server: tls.Server, options: ScriptedImapServerOptions) {
    this.server = server;
    this.options = options;
    this.store = options.store ?? new ScriptedMailboxStore();
  }

  /** Start the server on an ephemeral loopback port. */
  static async start(options: ScriptedImapServerOptions): Promise<ScriptedImapServer> {
    const server = tls.createServer({
      key: options.certificate.keyPem,
      cert: options.certificate.certPem,
    });
    const scripted = new ScriptedImapServer(server, options);
    server.on("secureConnection", (socket) => scripted.onConnection(socket));
    server.on("tlsClientError", () => {
      // A handshake the client abandoned is a scripted drop as far as the
      // suites care; nothing is owed to a connection that never opened.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    Object.defineProperty(scripted, "port", {
      value: (server.address() as { port: number }).port,
    });
    return scripted;
  }

  /** Stop the server and drop every connection. */
  async stop(): Promise<void> {
    this.closed = true;
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // Connections already destroyed let close finish; guard against strays.
      setTimeout(resolve, 200).unref();
    });
  }

  /** True when any recorded line wrote to the mailbox. */
  sawWrite(): boolean {
    return this.commands.some(({ line }) =>
      /^(?:\S+)\s+(?:UID\s+)?(?:STORE|MOVE|APPEND|EXPUNGE|COPY)\b/i.test(line),
    );
  }

  private readonly connections = new Map<number, ConnectionState>();

  private onConnection(socket: tls.TLSSocket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.openConnections += 1;
    const id = this.nextConnectionId;
    this.nextConnectionId += 1;
    const state: ConnectionState = {
      socket,
      authenticated: false,
      enabled: new Set(),
      selected: null,
      view: [],
    };
    this.connections.set(id, state);
    socket.on("error", () => this.dropConnection(id));
    socket.on("close", () => this.dropConnection(id));
    // The reader is per connection; literal payloads never cross connections.
    new CommandReader(socket, (line, tokens) => {
      this.commands.push({ connection: id, line });
      void this.dispatch(state, line, tokens);
    }).start(`* OK [CAPABILITY ${CAPABILITIES}] Scripted IMAP ready\r\n`);
  }

  private dropConnection(id: number): void {
    if (this.connections.delete(id)) {
      this.openConnections -= 1;
    }
  }

  /** Apply one scripted fault. Returns false when the command must not run. */
  private async applyFault(
    state: ConnectionState,
    tag: string,
  ): Promise<"continue" | "answered" | "dropped"> {
    const fault = this.faults.shift();
    if (fault === undefined) {
      return "continue";
    }
    switch (fault.kind) {
      case "delay":
        await sleep(fault.ms);
        return "continue";
      case "drop":
        state.socket.destroy();
        return "dropped";
      case "bye":
        state.socket.write(`* BYE ${fault.reason ?? "Session expired"}\r\n`);
        state.socket.destroy();
        return "dropped";
      case "no":
        this.writeTagged(state.socket, tag, "NO", fault.code === undefined ? "" : ` [${fault.code}]`, fault.text ?? "Scripted refusal");
        return "answered";
      case "bad":
        this.writeTagged(state.socket, tag, "BAD", "", fault.text ?? "Scripted protocol error");
        return "answered";
      default:
        // The lost-append fault belongs to the APPEND handler alone.
        this.faults.unshift(fault);
        return "continue";
    }
  }

  private async dispatch(state: ConnectionState, line: string, tokens: Token[]): Promise<void> {
    const match = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (match === null) {
      return;
    }
    const [, tag = "", command = ""] = match;
    try {
      const faulted = await this.applyFault(state, tag);
      if (faulted !== "continue") {
        return;
      }
      // The token list still carries the tag and the command word; the
      // handlers want the arguments only.
      await this.handle(state, tag, command.toUpperCase(), tokens.slice(2));
    } catch (cause) {
      // A scripting bug in a test must read as a protocol error, not silence.
      this.writeTagged(state.socket, tag, "BAD", "", `Scripted server error: ${String(cause)}`);
    }
  }

  private async handle(
    state: ConnectionState,
    tag: string,
    command: string,
    tokens: Token[],
  ): Promise<void> {
    const write = state.socket;
    switch (command) {
      case "CAPABILITY":
        write.write(`* CAPABILITY ${CAPABILITIES}\r\n`);
        this.writeTagged(write, tag, "OK", "", "CAPABILITY completed");
        return;
      case "NOOP":
        this.flushView(state);
        this.writeTagged(write, tag, "OK", "", "NOOP completed");
        return;
      case "CHECK":
        this.flushView(state);
        this.writeTagged(write, tag, "OK", "", "CHECK completed");
        return;
      case "LOGIN": {
        const [user, pass] = tokens;
        const accepted =
          this.options.auth !== null &&
          user !== undefined &&
          pass !== undefined &&
          textOf(user) === this.options.auth.user &&
          textOf(pass) === this.options.auth.pass;
        if (accepted) {
          state.authenticated = true;
          this.writeTagged(write, tag, "OK", ` [CAPABILITY ${CAPABILITIES}]`, "Logged in");
        } else {
          this.writeTagged(write, tag, "NO", " [AUTHENTICATIONFAILED]", "Invalid credentials");
        }
        return;
      }
      case "AUTHENTICATE":
        this.writeTagged(write, tag, "NO", " [AUTHENTICATIONFAILED]", "Not supported");
        return;
      case "ENABLE": {
        const requested = tokens.flatMap((token) => (token.type === "list" ? token.items : [token]));
        const enabled = requested
          .map((token) => textOf(token).toUpperCase())
          .filter((name) => name === "CONDSTORE");
        for (const name of enabled) {
          state.enabled.add(name);
        }
        write.write(`* ENABLED ${enabled.join(" ")}\r\n`);
        this.writeTagged(write, tag, "OK", "", "ENABLE completed");
        return;
      }
      case "NAMESPACE":
        write.write(`* NAMESPACE (("" "/")) NIL NIL\r\n`);
        this.writeTagged(write, tag, "OK", "", "NAMESPACE completed");
        return;
      case "LIST":
      case "LSUB":
        this.handleList(state, tag, command, tokens);
        return;
      case "STATUS":
        this.handleStatus(state, tag, tokens);
        return;
      case "SELECT":
      case "EXAMINE":
        this.handleSelect(state, tag, command, tokens, command === "EXAMINE");
        return;
      case "CLOSE":
      case "UNSELECT":
        state.selected = null;
        state.view = [];
        this.writeTagged(write, tag, "OK", "", `${command} completed`);
        return;
      case "SEARCH":
      case "FETCH":
      case "STORE":
      case "MOVE":
      case "COPY":
      case "EXPUNGE":
        await this.handleSelected(state, tag, command, tokens, false);
        return;
      case "UID":
        await this.handleUid(state, tag, tokens);
        return;
      case "APPEND":
        await this.handleAppend(state, tag, tokens);
        return;
      case "LOGOUT":
        write.write(`* BYE Scripted IMAP closing\r\n`);
        this.writeTagged(write, tag, "OK", "", "LOGOUT completed");
        write.end();
        return;
      default:
        this.writeTagged(write, tag, "BAD", "", `Unrecognized command ${command}`);
    }
  }

  private requireSelected(state: ConnectionState, tag: string): StoredImapFolder | null {
    if (state.selected === null) {
      this.writeTagged(state.socket, tag, "BAD", "", "No mailbox selected");
      return null;
    }
    return state.selected;
  }

  private async handleUid(state: ConnectionState, tag: string, tokens: Token[]): Promise<void> {
    const subcommand = tokens[0] === undefined ? "" : textOf(tokens[0]).toUpperCase();
    const rest = tokens.slice(1);
    switch (subcommand) {
      case "SEARCH":
      case "FETCH":
      case "STORE":
      case "MOVE":
      case "COPY":
      case "EXPUNGE":
        await this.handleSelected(state, tag, subcommand, rest, true);
        return;
      default:
        this.writeTagged(state.socket, tag, "BAD", "", `Unsupported UID subcommand ${subcommand}`);
    }
  }

  private async handleSelected(
    state: ConnectionState,
    tag: string,
    command: string,
    tokens: Token[],
    byUid: boolean,
  ): Promise<void> {
    const folder = this.requireSelected(state, tag);
    if (folder === null) {
      return;
    }
    switch (command) {
      case "SEARCH":
        this.handleSearch(state, tag, folder, tokens, byUid);
        return;
      case "FETCH":
        this.handleFetch(state, tag, folder, tokens, byUid);
        return;
      case "STORE":
        this.handleStore(state, tag, folder, tokens, byUid);
        return;
      case "EXPUNGE":
        this.handleExpunge(state, tag, folder);
        return;
      case "MOVE":
      case "COPY":
        this.handleCopyMove(state, tag, folder, tokens, byUid, command === "MOVE");
        return;
      default:
        this.writeTagged(state.socket, tag, "BAD", "", `Unsupported command ${command}`);
    }
  }

  private handleList(
    state: ConnectionState,
    tag: string,
    command: string,
    tokens: Token[],
  ): void {
    const write = state.socket;
    const pattern = tokens[1] === undefined ? "" : textOf(tokens[1]);
    if (pattern === "") {
      // The empty pattern asks for the hierarchy delimiter, not the folders.
      write.write(`* ${command} (\\Noselect) "/" ""\r\n`);
      this.writeTagged(write, tag, "OK", "", `${command} completed`);
      return;
    }
    const matcher = folderMatcher(pattern);
    for (const folder of this.store.folders.values()) {
      if (!matcher(folder.path)) {
        continue;
      }
      const flags = ["\\HasNoChildren", ...folder.specialUse].join(" ");
      write.write(`* ${command} (${flags}) "/" "${folder.path}"\r\n`);
    }
    this.writeTagged(write, tag, "OK", "", `${command} completed`);
  }

  private handleStatus(state: ConnectionState, tag: string, tokens: Token[]): void {
    const write = state.socket;
    const path = tokens[0] === undefined ? "" : textOf(tokens[0]);
    const items = tokens[1]?.type === "list" ? tokens[1].items.map(textOf) : [];
    const folder = this.store.folder(path);
    if (folder === undefined || items.length === 0) {
      this.writeTagged(write, tag, "BAD", "", "STATUS not understood");
      return;
    }
    const values = items
      .map((item) => {
        switch (item.toUpperCase()) {
          case "MESSAGES":
            return `MESSAGES ${folder.messages.size}`;
          case "RECENT":
            return `RECENT 0`;
          case "UIDNEXT":
            return `UIDNEXT ${folder.nextUid}`;
          case "UIDVALIDITY":
            return `UIDVALIDITY ${folder.uidValidity}`;
          case "UNSEEN":
            return `UNSEEN ${messagesAscending(folder).filter((m) => !m.flags.includes("\\Seen")).length}`;
          case "HIGHESTMODSEQ":
            return `HIGHESTMODSEQ ${folder.highestModseq.toString()}`;
          default:
            return `${item.toUpperCase()} 0`;
        }
      })
      .join(" ");
    write.write(`* STATUS "${folder.path}" (${values})\r\n`);
    this.writeTagged(write, tag, "OK", "", "STATUS completed");
  }

  private handleSelect(
    state: ConnectionState,
    tag: string,
    command: string,
    tokens: Token[],
    readOnly: boolean,
  ): void {
    const write = state.socket;
    const path = tokens[0] === undefined ? "" : textOf(tokens[0]);
    const folder = this.store.folder(path);
    if (folder === undefined) {
      this.writeTagged(write, tag, "NO", " [NONEXISTENT]", `No such mailbox: ${path}`);
      return;
    }
    state.selected = folder;
    state.view = uidsAscending(folder);
    const messages = messagesAscending(folder);
    write.write(`* FLAGS (${SYSTEM_FLAGS.join(" ")})\r\n`);
    write.write(`* ${messages.length} EXISTS\r\n`);
    write.write(`* 0 RECENT\r\n`);
    const firstUnseen = messages.findIndex((message) => !message.flags.includes("\\Seen"));
    if (firstUnseen !== -1) {
      write.write(`* OK [UNSEEN ${firstUnseen + 1}] First unseen\r\n`);
    }
    write.write(`* OK [PERMANENTFLAGS (${[...SYSTEM_FLAGS, "\\*"].join(" ")})] Flags permitted\r\n`);
    write.write(`* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid\r\n`);
    write.write(`* OK [UIDNEXT ${folder.nextUid}] Predicted next UID\r\n`);
    write.write(`* OK [HIGHESTMODSEQ ${folder.highestModseq.toString()}] Highest\r\n`);
    this.writeTagged(write, tag, "OK", readOnly ? " [READ-ONLY]" : " [READ-WRITE]", `${command} completed`);
  }

  private handleSearch(
    state: ConnectionState,
    tag: string,
    folder: StoredImapFolder,
    tokens: Token[],
    byUid: boolean,
  ): void {
    const write = state.socket;
    const messages = messagesAscending(folder);
    let candidates = messages;
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index]!;
      const key = textOf(token).toUpperCase();
      if (key === "ALL") {
        index += 1;
        continue;
      }
      if (key === "UID" || key === "SEQ") {
        const rangeToken = tokens[index + 1];
        const range = rangeToken === undefined ? "" : textOf(rangeToken);
        const wanted = new Set(expandSequenceSet(range, byUid ? uidsAscending(folder) : messages.map((_, i) => i + 1)));
        candidates = candidates.filter((message) =>
          wanted.has(byUid ? message.uid : messages.indexOf(message) + 1),
        );
        index += 2;
        continue;
      }
      if (key === "HEADER") {
        const nameToken = tokens[index + 1];
        const valueToken = tokens[index + 2];
        const name = nameToken === undefined ? "" : textOf(nameToken);
        const value = valueToken === undefined ? "" : textOf(valueToken);
        candidates = candidates.filter((message) => {
          const header = headerBlock(message.bytes).toLowerCase();
          const pattern = new RegExp(`^${escapeRegExp(name)}:\\s.*${escapeRegExp(value)}`, "im");
          return value === "" ? header.includes(`${name.toLowerCase()}:`) : pattern.test(header);
        });
        index += 3;
        continue;
      }
      const flag = SEARCH_FLAGS[key];
      if (flag !== undefined) {
        candidates = candidates.filter((message) =>
          message.flags.includes(flag) === SEARCH_FLAGS_EXPECTED[key],
        );
        index += 1;
        continue;
      }
      this.writeTagged(write, tag, "BAD", "", `Unsupported search key ${key}`);
      return;
    }
    const results = candidates.map((message) => (byUid ? message.uid : messages.indexOf(message) + 1));
    write.write(`* SEARCH${results.length === 0 ? "" : ` ${results.join(" ")}`}\r\n`);
    this.writeTagged(write, tag, "OK", "", "SEARCH completed");
  }

  private handleFetch(
    state: ConnectionState,
    tag: string,
    folder: StoredImapFolder,
    tokens: Token[],
    byUid: boolean,
  ): void {
    const write = state.socket;
    const range = tokens[0] === undefined ? "" : textOf(tokens[0]);
    const messages = messagesAscending(folder);
    const positions = messages.map((_, i) => i + 1);
    const wanted = expandSequenceSet(range, byUid ? uidsAscending(folder) : positions);
    const matched = messages.filter((message) => wanted.has(byUid ? message.uid : messages.indexOf(message) + 1));

    const query = tokens[1]?.type === "list" ? tokens[1].items : tokens.slice(1).filter(isNotModifier);
    // A trailing CHANGEDSINCE modifier filters by modification sequence.
    const changedSince = readChangedSince(tokens);
    const visible = changedSince === null ? matched : matched.filter((m) => m.modseq > changedSince);

    for (const message of visible) {
      const items = this.fetchItems(state, message, query);
      if (items === null) {
        this.writeTagged(write, tag, "BAD", "", "Unsupported fetch section");
        return;
      }
      const seq = messages.indexOf(message) + 1;
      // Literal payloads ride inside the line; the whole response is latin1 so
      // message bytes survive the write untouched.
      write.write(`* ${seq} FETCH (${items.join(" ")})\r\n`, "latin1");
    }
    this.flushView(state);
    this.writeTagged(write, tag, "OK", "", "FETCH completed");
  }

  /** Build the response items of one message, or null for an unsupported section. */
  private fetchItems(state: ConnectionState, message: StoredImapMessage, query: Token[]): string[] | null {
    const items: string[] = [];
    for (const token of query) {
      if (token.type !== "atom") {
        return null;
      }
      const name = token.value.toUpperCase();
      if (token.section !== null) {
        let literal = sectionLiteral(message.bytes, token.section);
        if (literal === null) {
          return null;
        }
        // A byte range attached to the section answers only that window, and
        // the response echoes the origin alone (RFC 3501 partial syntax).
        let origin = "";
        if (token.partial !== undefined) {
          const { start, count } = token.partial;
          literal = literal.subarray(start, count === null ? undefined : start + count);
          origin = `<${start}>`;
        }
        // The response echoes the item with its section, minus `.PEEK`.
        const item = `${token.value.toUpperCase().replace(/\.PEEK$/, "")}[${token.section}]${origin}`;
        // One response piece: the echoed item, the size marker with the CRLF
        // it terminates on, then the payload itself. A following item
        // separates with the space `items.join` adds.
        items.push(`${item} {${literal.length}}\r\n${literal.toString("binary")}`);
        continue;
      }
      switch (name) {
        case "UID":
          items.push(`UID ${message.uid}`);
          break;
        case "FLAGS":
          items.push(`FLAGS (${message.flags.join(" ")})`);
          break;
        case "INTERNALDATE":
          items.push(`INTERNALDATE "${formatInternalDate(message.internalDate)}"`);
          break;
        case "RFC822.SIZE":
          items.push(`RFC822.SIZE ${message.bytes.length}`);
          break;
        case "MODSEQ":
          if (state.enabled.has("CONDSTORE")) {
            items.push(`MODSEQ (${message.modseq.toString()})`);
          }
          break;
        default:
          return null;
      }
    }
    return items;
  }

  private handleStore(
    state: ConnectionState,
    tag: string,
    folder: StoredImapFolder,
    tokens: Token[],
    byUid: boolean,
  ): void {
    const write = state.socket;
    const range = tokens[0] === undefined ? "" : textOf(tokens[0]);
    const messages = messagesAscending(folder);
    const wanted = expandSequenceSet(range, byUid ? uidsAscending(folder) : messages.map((_, i) => i + 1));
    const matched = messages.filter((message) => wanted.has(byUid ? message.uid : messages.indexOf(message) + 1));

    let unchangedSince: bigint | null = null;
    let operation: string | null = null;
    let flags: string[] = [];
    for (const token of tokens.slice(1)) {
      if (token.type === "list") {
        const values = token.items.map(textOf);
        if (values[0]?.toUpperCase() === "UNCHANGEDSINCE") {
          unchangedSince = BigInt(values[1] ?? "0");
        } else {
          // Flags keep the case the client sent; IMAP flags are case-blind,
          // but the clients echo back what they read.
          flags = values;
        }
        continue;
      }
      const value = textOf(token).toUpperCase();
      if (/^[+-]?FLAGS(\.SILENT)?$/.test(value)) {
        operation = value;
      }
    }
    if (operation === null) {
      this.writeTagged(write, tag, "BAD", "", "STORE without a flag operation");
      return;
    }
    const silent = operation.endsWith(".SILENT");
    const mode = operation.startsWith("+") ? "add" : operation.startsWith("-") ? "remove" : "set";
    const modified: number[] = [];
    for (const message of matched) {
      if (unchangedSince !== null && message.modseq > unchangedSince) {
        modified.push(message.uid);
        continue;
      }
      const next =
        mode === "add"
          ? [...new Set([...message.flags, ...flags])]
          : mode === "remove"
            ? message.flags.filter(
                (flag) => !flags.some((removed) => removed.toUpperCase() === flag.toUpperCase()),
              )
            : [...flags];
      message.flags = next;
      const modseq = this.store.bumpModseq(folder, message);
      if (!silent) {
        const items = [`UID ${message.uid}`, `FLAGS (${message.flags.join(" ")})`];
        if (state.enabled.has("CONDSTORE")) {
          items.push(`MODSEQ (${modseq.toString()})`);
        }
        const live = messagesAscending(folder);
        const seq = live.findIndex((entry) => entry.uid === message.uid) + 1;
        if (seq > 0) {
          write.write(`* ${seq} FETCH (${items.join(" ")})\r\n`);
        }
      }
    }
    this.flushView(state);
    if (modified.length > 0) {
      // RFC 7162: the conditional write failed for these UIDs. When nothing
      // was written at all, the answer is a tagged NO, so a client that reads
      // only the status sees the conflict; a partial success stays an OK.
      const code = ` [MODIFIED ${modified.join(",")}]`;
      if (modified.length === matched.length) {
        this.writeTagged(write, tag, "NO", code, "Conditional STORE failed");
      } else {
        this.writeTagged(write, tag, "OK", code, "Conditional STORE partially applied");
      }
    } else {
      this.writeTagged(write, tag, "OK", "", "STORE completed");
    }
  }

  private handleExpunge(state: ConnectionState, tag: string, folder: StoredImapFolder): void {
    const write = state.socket;
    const doomed = messagesAscending(folder).filter((message) => message.flags.includes("\\Deleted"));
    for (const message of doomed) {
      const seq = state.view.indexOf(message.uid) + 1;
      if (seq > 0) {
        write.write(`* ${seq} EXPUNGE\r\n`);
      }
      folder.messages.delete(message.uid);
      const index = state.view.indexOf(message.uid);
      if (index !== -1) {
        state.view.splice(index, 1);
      }
    }
    this.writeTagged(write, tag, "OK", "", "EXPUNGE completed");
  }

  private handleCopyMove(
    state: ConnectionState,
    tag: string,
    folder: StoredImapFolder,
    tokens: Token[],
    byUid: boolean,
    isMove: boolean,
  ): void {
    const write = state.socket;
    const range = tokens[0] === undefined ? "" : textOf(tokens[0]);
    const destinationPath = tokens[1] === undefined ? "" : textOf(tokens[1]);
    const destination = this.store.folder(destinationPath);
    if (destination === undefined) {
      this.writeTagged(write, tag, "NO", " [TRYCREATE]", `No such mailbox: ${destinationPath}`);
      return;
    }
    const messages = messagesAscending(folder);
    const wanted = expandSequenceSet(range, byUid ? uidsAscending(folder) : messages.map((_, i) => i + 1));
    const matched = messages.filter((message) => wanted.has(byUid ? message.uid : messages.indexOf(message) + 1));
    if (matched.length === 0) {
      this.writeTagged(write, tag, "OK", "", `${isMove ? "MOVE" : "COPY"} completed`);
      return;
    }
    const sourceUids: number[] = [];
    const destinationUids: number[] = [];
    for (const message of matched) {
      const uid = destination.nextUid;
      destination.nextUid += 1;
      destination.highestModseq += 1n;
      destination.messages.set(uid, {
        uid,
        bytes: message.bytes,
        flags: [...message.flags],
        internalDate: message.internalDate,
        modseq: destination.highestModseq,
      });
      sourceUids.push(message.uid);
      destinationUids.push(uid);
    }
    const copyUid = `COPYUID ${destination.uidValidity} ${joinRanges(sourceUids)} ${joinRanges(destinationUids)}`;
    write.write(`* OK [${copyUid}] Copied\r\n`);
    if (isMove) {
      for (const message of matched) {
        const seq = state.view.indexOf(message.uid) + 1;
        if (seq > 0) {
          write.write(`* ${seq} EXPUNGE\r\n`);
        }
        folder.messages.delete(message.uid);
        const index = state.view.indexOf(message.uid);
        if (index !== -1) {
          state.view.splice(index, 1);
        }
      }
    }
    this.flushView(state);
    this.writeTagged(write, tag, "OK", ` [${copyUid}]`, `${isMove ? "MOVE" : "COPY"} completed`);
  }

  private async handleAppend(state: ConnectionState, tag: string, tokens: Token[]): Promise<void> {
    const write = state.socket;
    const path = tokens[0] === undefined ? "" : textOf(tokens[0]);
    const folder = this.store.folder(path);
    let flags: string[] = [];
    let internalDate = new Date();
    const literal = tokens.find((token): token is { type: "literal"; value: Buffer } => token.type === "literal");
    for (const token of tokens.slice(1)) {
      if (token.type === "list") {
        flags = token.items.map(textOf);
      } else if (token.type === "string") {
        const parsed = parseInternalDate(token.value);
        if (parsed !== null) {
          internalDate = parsed;
        }
      }
    }
    if (folder === undefined || literal === undefined) {
      this.writeTagged(write, tag, "NO", " [TRYCREATE]", `No such mailbox: ${path}`);
      return;
    }
    const uid = folder.nextUid;
    folder.nextUid += 1;
    folder.highestModseq += 1n;
    folder.messages.set(uid, {
      uid,
      bytes: Buffer.from(literal.value),
      flags,
      internalDate,
      modseq: folder.highestModseq,
    });
    this.appends.push({
      folder: folder.path,
      uid,
      uidvalidity: folder.uidValidity,
      bytes: Buffer.from(literal.value),
    });
    if (state.selected === folder) {
      state.view = uidsAscending(folder);
      write.write(`* ${folder.messages.size} EXISTS\r\n`);
    }
    const lost = this.faults[0]?.kind === "lost-append-response";
    if (lost) {
      this.faults.shift();
      // The copy is stored; the answer never arrives (SPEC F7 step 5).
      write.destroy();
      return;
    }
    this.writeTagged(write, tag, "OK", ` [APPENDUID ${folder.uidValidity} ${uid}]`, "APPEND completed");
  }

  /**
   * Report the world the connection has not seen yet: expunges first, in the
   * order the connection's view holds them, then the new arrival count.
   */
  private flushView(state: ConnectionState): void {
    const folder = state.selected;
    if (folder === null) {
      return;
    }
    const actual = uidsAscending(folder);
    for (const uid of [...state.view]) {
      if (!folder.messages.has(uid)) {
        const seq = state.view.indexOf(uid) + 1;
        state.socket.write(`* ${seq} EXPUNGE\r\n`);
        state.view.splice(seq - 1, 1);
      }
    }
    const arrivals = actual.filter((uid) => !state.view.includes(uid));
    if (arrivals.length > 0) {
      state.view = [...state.view, ...arrivals].sort((a, b) => a - b);
      state.socket.write(`* ${state.view.length} EXISTS\r\n`);
    }
  }

  private writeTagged(
    write: tls.TLSSocket,
    tag: string,
    status: "OK" | "NO" | "BAD",
    code: string,
    text: string,
  ): void {
    write.write(`${tag} ${status}${code} ${text}\r\n`);
  }
}

/** The flag search keys the scripted server understands. */
const SEARCH_FLAGS: Record<string, string> = {
  SEEN: "\\Seen",
  UNSEEN: "\\Seen",
  FLAGGED: "\\Flagged",
  UNFLAGGED: "\\Flagged",
  DELETED: "\\Deleted",
  ANSWERED: "\\Answered",
  DRAFT: "\\Draft",
};

/** Whether the key asks for the flag to be present. */
const SEARCH_FLAGS_EXPECTED: Record<string, boolean> = {
  SEEN: true,
  UNSEEN: false,
  FLAGGED: true,
  UNFLAGGED: false,
  DELETED: true,
  ANSWERED: true,
  DRAFT: true,
};

/**
 * Reads command lines with client-to-server literals. An `{n}` marker at the
 * end of a line asks for a continuation; the reader answers it, collects the
 * exact byte count, and hands the dispatcher one complete command. The rest
 * of the command may follow a literal (`LOGIN {5}` octets ` {5}` octets), so
 * tokens accumulate until a line ends without a literal marker.
 */
class CommandReader {
  private buffer = Buffer.alloc(0);
  private tokens: Token[] = [];
  private literalParts: Buffer[] = [];
  private literalRemaining = 0;
  /** The first line of the command in progress, for dispatch and the log. */
  private firstLine = "";

  constructor(
    private readonly socket: tls.TLSSocket,
    private readonly onCommand: (line: string, tokens: Token[]) => void,
  ) {}

  start(greeting: string): void {
    this.socket.on("error", () => undefined);
    this.socket.write(greeting);
    this.socket.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.literalRemaining > 0) {
        const take = Math.min(this.buffer.length, this.literalRemaining);
        this.literalParts.push(this.buffer.subarray(0, take));
        this.literalRemaining -= take;
        this.buffer = this.buffer.subarray(take);
        if (this.literalRemaining > 0) {
          return;
        }
        this.tokens.push({ type: "literal", value: Buffer.concat(this.literalParts) });
        this.literalParts = [];
        continue;
      }
      const index = this.buffer.indexOf("\r\n");
      if (index === -1) {
        return;
      }
      const line = this.buffer.subarray(0, index).toString("binary");
      this.buffer = this.buffer.subarray(index + 2);
      const parsed = tokenize(line);
      if (parsed.literalSize !== null) {
        if (this.tokens.length === 0) {
          this.firstLine = line;
        }
        this.tokens.push(...parsed.tokens);
        this.literalRemaining = parsed.literalSize;
        this.socket.write("+ Ready for literal data\r\n");
        continue;
      }
      const complete = [...this.tokens, ...parsed.tokens];
      const originalLine = this.tokens.length === 0 ? line : this.firstLine;
      this.tokens = [];
      this.onCommand(originalLine, complete);
    }
  }
}

/** The tokenizer result: argument tokens and, when the line ends with `{n}`, its size. */
function tokenize(line: string): { tokens: Token[]; literalSize: number | null } {
  const literalMatch = /(\{(\d+)\})$/.exec(line);
  const literalSize = literalMatch === null ? null : Number(literalMatch[2]);
  const body = literalMatch === null ? line : line.slice(0, line.length - literalMatch[1]!.length);
  const tokens: Token[] = [];
  let position = 0;
  while (position < body.length) {
    while (position < body.length && body[position] === " ") {
      position += 1;
    }
    if (position >= body.length) {
      break;
    }
    const character = body[position]!;
    if (character === "(") {
      const { items, next } = parseList(body, position);
      tokens.push({ type: "list", items });
      position = next;
      continue;
    }
    if (character === '"') {
      const { value, next } = parseQuoted(body, position);
      tokens.push({ type: "string", value });
      position = next;
      continue;
    }
    const { value, section, next } = parseAtom(body, position);
    tokens.push({ type: "atom", value, section });
    position = next;
  }
  return { tokens, literalSize };
}

/** Parse one parenthesized list starting at `start`. */
function parseList(body: string, start: number): { items: Token[]; next: number } {
  const items: Token[] = [];
  let position = start + 1;
  for (;;) {
    while (position < body.length && body[position] === " ") {
      position += 1;
    }
    if (position >= body.length) {
      return { items, next: position };
    }
    const character = body[position]!;
    if (character === ")") {
      return { items, next: position + 1 };
    }
    if (character === "(") {
      const { items: nested, next } = parseList(body, position);
      items.push({ type: "list", items: nested });
      position = next;
      continue;
    }
    if (character === '"') {
      const { value, next } = parseQuoted(body, position);
      items.push({ type: "string", value });
      position = next;
      continue;
    }
    const { value, section, next } = parseAtom(body, position);
    items.push({ type: "atom", value, section });
    position = next;
  }
}

/** Parse one quoted string starting at `start`. */
function parseQuoted(body: string, start: number): { value: string; next: number } {
  let value = "";
  let position = start + 1;
  while (position < body.length) {
    const character = body[position]!;
    if (character === "\\" && position + 1 < body.length) {
      value += body[position + 1]!;
      position += 2;
      continue;
    }
    if (character === '"') {
      return { value, next: position + 1 };
    }
    value += character;
    position += 1;
  }
  return { value, next: position };
}

/**
 * Parse one atom. A `[...]` section attached to it (as in
 * `BODY.PEEK[HEADER.FIELDS (DATE)]`) is kept apart from the item name,
 * because the response echoes the section without the `.PEEK` marker. A
 * `<origin.count>` byte range may follow the section, as the partial FETCH
 * of a streaming download uses.
 */
function parseAtom(
  body: string,
  start: number,
): { value: string; section: string | null; partial?: { start: number; count: number | null }; next: number } {
  let position = start;
  let value = "";
  let section: string | null = null;
  let partial: { start: number; count: number | null } | undefined;
  while (position < body.length) {
    const character = body[position]!;
    if (character === " " || character === "(" || character === ")") {
      break;
    }
    if (character === "[") {
      const end = matchSection(body, position);
      section = body.slice(position + 1, end);
      position = end + 1;
      continue;
    }
    // `<` opens a byte range only directly after a section; anywhere else it
    // is an ordinary atom character.
    if (character === "<" && section !== null && partial === undefined) {
      const end = body.indexOf(">", position);
      const range = /^(\d+)(?:\.(\d+))?$/.exec(body.slice(position + 1, end === -1 ? body.length : end));
      if (range !== null) {
        partial = { start: Number(range[1]), count: range[2] === undefined ? null : Number(range[2]) };
        position = end === -1 ? body.length : end + 1;
        continue;
      }
    }
    value += character;
    position += 1;
  }
  return partial === undefined
    ? { value, section, next: position }
    : { value, section, partial, next: position };
}

/** Find the `]` that closes the section opened at `start`. */
function matchSection(body: string, start: number): number {
  let depth = 0;
  for (let position = start; position < body.length; position += 1) {
    const character = body[position]!;
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return position;
      }
    }
  }
  return body.length - 1;
}

/** The text of one token, whatever its shape. */
function textOf(token: Token): string {
  switch (token.type) {
    case "atom":
      return token.value;
    case "string":
      return token.value;
    case "literal":
      return token.value.toString("binary");
    case "list":
      return token.items.map(textOf).join(" ");
  }
}

/** Expand one sequence set against the identifiers it addresses. */
function expandSequenceSet(range: string, identifiers: number[]): Set<number> {
  const wanted = new Set<number>();
  const highest = identifiers.length === 0 ? 0 : identifiers[identifiers.length - 1]!;
  for (const entry of range.split(",")) {
    const [lowText, highText] = entry.split(":");
    if (lowText === undefined || lowText === "") {
      continue;
    }
    const low = lowText === "*" ? highest : Number(lowText);
    const high = highText === undefined ? low : highText === "*" ? highest : Number(highText);
    if (Number.isNaN(low) || Number.isNaN(high)) {
      continue;
    }
    for (const identifier of identifiers) {
      if (identifier >= Math.min(low, high) && identifier <= Math.max(low, high)) {
        wanted.add(identifier);
      }
    }
  }
  return wanted;
}

/** The trailing `(CHANGEDSINCE n)` modifier of a FETCH, when present. */
function readChangedSince(tokens: Token[]): bigint | null {
  for (const token of tokens) {
    if (token.type !== "list") {
      continue;
    }
    const values = token.items.map(textOf);
    if (values[0]?.toUpperCase() === "CHANGEDSINCE") {
      return BigInt(values[1] ?? "0");
    }
  }
  return null;
}

/** True unless the token is the `(CHANGEDSINCE n)` FETCH modifier. */
function isNotModifier(token: Token): boolean {
  if (token.type !== "list") {
    return true;
  }
  return token.items.length === 0 || textOf(token.items[0]!).toUpperCase() !== "CHANGEDSINCE";
}

/** The header block of one message: every byte before the blank line. */
function headerBlock(bytes: Buffer): string {
  const text = bytes.toString("binary");
  const end = text.indexOf("\r\n\r\n");
  return end === -1 ? text : text.slice(0, end);
}

/**
 * The literal one fetch section answers with, or null when the section is
 * unsupported. Part-number sections stay unimplemented: nothing in this
 * codebase fetches them, and an honest BAD beats a wrong literal.
 */
function sectionLiteral(bytes: Buffer, section: string): Buffer | null {
  const normalized = section.trim().toUpperCase();
  const text = bytes.toString("binary");
  const headerEnd = text.indexOf("\r\n\r\n");
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const bodyStart = headerEnd === -1 ? text.length : headerEnd + 4;
  if (normalized === "") {
    return bytes;
  }
  if (normalized === "HEADER") {
    return Buffer.from(`${header}\r\n`, "binary");
  }
  if (normalized === "TEXT") {
    return Buffer.from(text.slice(bodyStart), "binary");
  }
  const fieldsMatch = /^HEADER\.FIELDS(\.NOT)?\s*\((.*)\)$/.exec(normalized);
  if (fieldsMatch === null) {
    return null;
  }
  const negate = fieldsMatch[1] !== undefined;
  const fields = new Set(
    fieldsMatch[2]!
      .split(/\s+/)
      .map((field) => field.trim())
      .filter((field) => field !== ""),
  );
  const selected: string[] = [];
  for (const line of header.split("\r\n")) {
    if (line === "") {
      continue;
    }
    const name = /^[^:]+/.exec(line)?.[0]?.trim().toUpperCase() ?? "";
    const wanted = fields.has(name) !== negate;
    if (wanted) {
      selected.push(line);
    }
  }
  return Buffer.from(`${selected.join("\r\n")}\r\n\r\n`, "binary");
}

/** `dd-Mon-yyyy HH:MM:SS +0000`, the IMAP date-time shape. */
function formatInternalDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${day}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${hour}:${minute}:${second} +0000`;
}

/** Parse one IMAP date-time, when the bytes hold one. */
function parseInternalDate(value: string): Date | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) \d{2}:\d{2}:\d{2} [+-]\d{4}$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Compress ascending identifiers into colon ranges: `1,3:5,9`. */
function joinRanges(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0] ?? 0;
  let previous = start;
  for (const value of sorted.slice(1)) {
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}:${previous}`);
    start = value;
    previous = value;
  }
  parts.push(start === previous ? `${start}` : `${start}:${previous}`);
  return parts.join(",");
}

/** One LIST pattern against folder paths: `*` crosses the delimiter, `%` does not. */
function folderMatcher(pattern: string): (path: string) => boolean {
  const source = escapeRegExp(pattern)
    .replace(/\\\*/g, ".*")
    .replace(/%/g, "[^/]*");
  const expression = new RegExp(`^${source}$`);
  return (path) => expression.test(path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
