/**
 * The fake mailbox and SMTP test harness (SPEC section 12).
 *
 * One scripted IMAP server and one scripted SMTP server, both speaking real
 * wire protocol over validated TLS, plus the mailbox state and message
 * fixtures the acceptance suites script their scenarios with. Nothing here
 * contacts a real mail server, and no real credentials are involved.
 */

export {
  createTestAuthority,
  type IssueOptions,
  type TestAuthority,
  type TestCertificate,
} from "./certificates.ts";
export {
  ScriptedMailboxStore,
  messagesAscending,
  uidsAscending,
  type LoadFolderOptions,
  type LoadMessageOptions,
  type StoredImapFolder,
  type StoredImapMessage,
} from "./mailbox-store.ts";
export {
  ScriptedImapServer,
  type RecordedAppend,
  type RecordedImapCommand,
  type ScriptedImapFault,
  type ScriptedImapServerOptions,
} from "./imap-server.ts";
export {
  ScriptedSmtpServer,
  type RecordedSmtpCommand,
  type RecordedSubmission,
  type ScriptedSmtpMode,
  type ScriptedSmtpServerOptions,
  type SmtpSubmissionScript,
} from "./smtp-server.ts";
export {
  MALICIOUS_HTML,
  base64Lines,
  buildMessage,
  duplicateContentIdMessage,
  duplicateNotificationPair,
  identicalAttachmentPairMessage,
  maliciousHtmlMessage,
  nestedRfc822Message,
  orphanReplyMessage,
  oversizedAttachmentMessage,
  replyChain,
  replyToDiffersMessage,
  reusedMessageIdPair,
  type AttachmentSpec,
  type MessageSpec,
} from "./fixtures.ts";
