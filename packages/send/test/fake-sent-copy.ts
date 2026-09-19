import type { SentCopyMailbox, SentCopyWriteResult } from "../src/index.ts";

/**
 * An in-memory Sent folder for the append job (SPEC F7 step 5).
 *
 * It implements the Sent-copy port with scripted state: copies that already
 * sit in the folder, appends that get refused or lose their response, and
 * failures between commands. The wire protocol belongs to the transport
 * harness; this double lets every recovery rule run against the real
 * database.
 */

/** One copy the fake folder holds. */
interface StoredCopy {
  uid: number;
  rfcMessageId: string;
  bytes: Uint8Array;
}

/** A failure the fake raises from one named step. */
export interface FakeSentCopyFailure {
  step: "select" | "search" | "append";
  error: Error;
}

export class FakeSentFolder {
  readonly path: string;
  /** The generation every select reports. Change it to script a reset. */
  uidValidity = 1;
  /** Every copy in the folder. */
  readonly copies: StoredCopy[] = [];
  /** Every append attempt, in order, including refused and lost ones. */
  readonly appends: { folder: string; rfcMessageId: string; bytes: Uint8Array }[] = [];
  /** When set, the next append answers this instead of storing bytes. */
  scriptedAppend: SentCopyWriteResult | null = null;
  /** When set, the named step throws before it runs. */
  failure: FakeSentCopyFailure | null = null;

  private nextUid = 1;

  constructor(path = "Sent") {
    this.path = path;
  }

  /** Place one copy in the folder, as a server-side save or a racing import would. */
  load(rfcMessageId: string, bytes: Uint8Array): number {
    const uid = this.nextUid;
    this.nextUid += 1;
    this.copies.push({ uid, rfcMessageId, bytes });
    return uid;
  }

  /** The UID the copy with this identifier holds, when one exists. */
  uidOf(rfcMessageId: string): number | null {
    return this.copies.find((copy) => copy.rfcMessageId === rfcMessageId)?.uid ?? null;
  }

  /** How many append attempts the message with this identifier started. */
  appendsOf(rfcMessageId: string): number {
    return this.appends.filter((attempt) => attempt.rfcMessageId === rfcMessageId).length;
  }

  /** One session over this folder, as the service opens it per account. */
  session(): SentCopyMailbox {
    const folder = this;
    return {
      async select(_path: string) {
        if (folder.failure?.step === "select") {
          throw folder.failure.error;
        }
        return { uidValidity: folder.uidValidity, uidNext: folder.nextUid };
      },
      async searchByMessageId(rfcMessageId: string) {
        if (folder.failure?.step === "search") {
          throw folder.failure.error;
        }
        return folder.copies
          .filter((copy) => copy.rfcMessageId === rfcMessageId)
          .map((copy) => copy.uid)
          .sort((a, b) => a - b);
      },
      async fetchOriginal(uid: number) {
        return folder.copies.find((copy) => copy.uid === uid)?.bytes ?? null;
      },
      async appendMessage(path: string, bytes: Uint8Array) {
        if (folder.failure?.step === "append") {
          throw folder.failure.error;
        }
        folder.appends.push({ folder: path, rfcMessageId: readMessageId(bytes), bytes });
        if (folder.scriptedAppend !== null) {
          return folder.scriptedAppend;
        }
        const uid = folder.nextUid;
        folder.nextUid += 1;
        folder.copies.push({ uid, rfcMessageId: readMessageId(bytes), bytes });
        return { result: "appended" as const, uidvalidity: folder.uidValidity, uid };
      },
      async logout() {
        // Nothing to close; the double holds no connection.
      },
    };
  }
}

/** Read one `Message-ID` header value out of complete message bytes. */
function readMessageId(bytes: Uint8Array): string {
  const header = Buffer.from(bytes.slice(0, 8192)).toString("utf8").split("\r\n\r\n")[0] ?? "";
  const match = /^Message-ID:[ \t]*(.+)$/im.exec(header);
  return match === null ? "" : match[1]!.trim();
}
