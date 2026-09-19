/**
 * The scripted mailbox state behind the fake IMAP server (SPEC section 12).
 *
 * One store is one account's server-side truth: folders, their generations,
 * their messages, and a modification-sequence counter. Tests load a folder,
 * then script the world changing underneath the client — new arrivals, server
 * expunges, `UIDVALIDITY` resets — by mutating the store between commands.
 * Every connection the server accepts shares one store, exactly like separate
 * sessions of one mailbox on a real server.
 */

/** One message the scripted server holds. */
export interface StoredImapMessage {
  uid: number;
  /** Complete message bytes: headers, blank line, body. */
  bytes: Buffer;
  /** Server flags, for example `["\\Seen", "\\Flagged"]`. */
  flags: string[];
  internalDate: Date;
  /**
   * The modification sequence of the last flag change. A CONDSTORE session
   * reads it on every fetch and captures it before a conditional write.
   */
  modseq: bigint;
}

/** One folder the scripted server holds. */
export interface StoredImapFolder {
  path: string;
  /** LIST flags beyond the hierarchy marker, for example `\\Sent`. */
  specialUse: string[];
  uidValidity: number;
  messages: Map<number, StoredImapMessage>;
  nextUid: number;
  /** The folder's highest modification sequence. */
  highestModseq: bigint;
}

/** Options for one message loaded into a folder. */
export interface LoadMessageOptions {
  bytes: Uint8Array;
  /** Defaults to unread: no `\Seen`. */
  flags?: string[];
  internalDate?: Date;
  /** Assigns a specific UID. The next auto-assigned UID clears the reserved one. */
  uid?: number;
}

/** Options for one folder created on the store. */
export interface LoadFolderOptions {
  specialUse?: string[];
  uidValidity?: number;
}

const DEFAULT_INTERNAL_DATE = new Date("2026-09-01T09:00:00Z");

/** The messages of one folder, ascending by UID. Every command shares it. */
export function messagesAscending(folder: StoredImapFolder): StoredImapMessage[] {
  return [...folder.messages.values()].sort((a, b) => a.uid - b.uid);
}

/** The UIDs one folder holds, ascending. Gaps stay gaps. */
export function uidsAscending(folder: StoredImapFolder): number[] {
  return messagesAscending(folder).map((message) => message.uid);
}

/** The server-side state of one mailbox, shared by every connection. */
export class ScriptedMailboxStore {
  readonly folders = new Map<string, StoredImapFolder>();

  /** Create one folder. An existing path is replaced whole. */
  addFolder(path: string, options: LoadFolderOptions = {}): StoredImapFolder {
    const folder: StoredImapFolder = {
      path,
      specialUse: options.specialUse ?? [],
      uidValidity: options.uidValidity ?? 1,
      messages: new Map(),
      nextUid: 1,
      highestModseq: 1n,
    };
    this.folders.set(path, folder);
    return folder;
  }

  /** Place one message in a folder and report the UID it received. */
  addMessage(path: string, options: LoadMessageOptions): number {
    const folder = this.folderOrThrow(path);
    const uid = options.uid ?? folder.nextUid;
    folder.nextUid = Math.max(folder.nextUid, uid + 1);
    folder.highestModseq += 1n;
    folder.messages.set(uid, {
      uid,
      bytes: Buffer.from(options.bytes),
      flags: [...(options.flags ?? [])],
      internalDate: options.internalDate ?? DEFAULT_INTERNAL_DATE,
      modseq: folder.highestModseq,
    });
    return uid;
  }

  /**
   * Remove one message as a server-side expunge would. Connections selected on
   * the folder learn of it with their next command.
   */
  expunge(path: string, uid: number): void {
    this.folderOrThrow(path).messages.delete(uid);
  }

  /**
   * Change the folder generation. The next selection reports the new value and
   * every stored occurrence of the old generation is invalid (SPEC F2).
   */
  setUidValidity(path: string, uidValidity: number): void {
    this.folderOrThrow(path).uidValidity = uidValidity;
  }

  /** Raise the generation by one, the shape of a silent UID renumbering. */
  resetUidValidity(path: string): number {
    const folder = this.folderOrThrow(path);
    folder.uidValidity += 1;
    return folder.uidValidity;
  }

  /**
   * Replace a folder's whole content under a new generation: UIDs may repeat,
   * so a client that kept its old occurrences now reads different messages.
   */
  replaceFolder(path: string, uidValidity: number, messages: LoadMessageOptions[]): void {
    const specialUse = this.folders.get(path)?.specialUse ?? [];
    const folder = this.addFolder(path, { specialUse, uidValidity });
    for (const message of messages) {
      this.addMessage(path, message);
    }
    const highest = Math.max(...[...folder.messages.keys(), 0]);
    folder.nextUid = Math.max(folder.nextUid, highest + 1);
  }

  /** Read one folder, when it exists. */
  folder(path: string): StoredImapFolder | undefined {
    return this.folders.get(path);
  }

  /** Advance the modification sequence and stamp one message with it. */
  bumpModseq(folder: StoredImapFolder, message: StoredImapMessage): bigint {
    folder.highestModseq += 1n;
    message.modseq = folder.highestModseq;
    return message.modseq;
  }

  private folderOrThrow(path: string): StoredImapFolder {
    const folder = this.folders.get(path);
    if (folder === undefined) {
      throw new Error(`No folder named ${path} exists on the scripted store.`);
    }
    return folder;
  }
}
