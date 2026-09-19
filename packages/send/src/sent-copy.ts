/**
 * The Sent-copy port (SPEC F7 step 5).
 *
 * Storing the sent copy is a separate job from SMTP submission: it runs after
 * acceptance, works from the same stored MIME bytes, and can never invoke
 * SMTP. The port mirrors the shape of the synchronization session, so one
 * open IMAP connection satisfies it structurally and tests script it
 * in memory. Every answer is classified the way the submitter's is: a
 * definitive refusal, a stored copy with whatever destination coordinates the
 * server reported, or an uncertain outcome that reconciliation must resolve.
 */

/** One Sent-copy destination as the server reported it. */
export interface SentCopyDestination {
  /** Database identifier of the folder mapped to the Sent role. */
  folderId: string;
  /** Folder generation of the stored copy, when the server reported one. */
  uidvalidity: number | null;
  /** UID of the stored copy, when the server reported one. */
  uid: number | null;
}

/** The classified answer of one Sent-folder append attempt. */
export type SentCopyWriteResult =
  | { result: "appended"; uidvalidity: number | null; uid: number | null }
  | { result: "rejected" }
  | { result: "uncertain"; reason: string };

/**
 * One mailbox connection the Sent-copy job may use. The ImapFlow session of
 * the synchronization package satisfies this interface structurally.
 */
export interface SentCopyMailbox {
  /** Select one folder and report its generation. */
  select(folder: string): Promise<{ uidValidity: number; uidNext: number }>;

  /**
   * UIDs in the selected folder whose `Message-ID` header carries the
   * identifier. A substring match is allowed; callers verify content before
   * trusting a candidate.
   */
  searchByMessageId(rfcMessageId: string): Promise<number[]>;

  /** The complete bytes of one message, or `null` when the UID no longer exists. */
  fetchOriginal(uid: number): Promise<Uint8Array | null>;

  /** Append complete message bytes to one folder. */
  appendMessage(folder: string, bytes: Uint8Array): Promise<SentCopyWriteResult>;

  /** Close the connection gracefully. */
  logout(): Promise<void>;
}

/** Opens one Sent-copy connection for one account. */
export type SentCopySessionFactory = (accountId: string) => Promise<SentCopyMailbox>;
