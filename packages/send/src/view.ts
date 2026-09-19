import type { MessageAddress, MessageRecipients, OutboundView } from "@mail-hub/contracts";
import type { OutboundRecord } from "./service.ts";

/**
 * The wire shape of one outbound snapshot. Recipient results and the SMTP
 * response travel verbatim; timestamps become ISO strings. Nothing here can
 * carry credentials: the record holds none.
 */
export function toOutboundView(record: OutboundRecord): OutboundView {
  return {
    id: record.id,
    draftId: record.draftId,
    accountId: record.accountId,
    status: record.status,
    sentCopyStatus: record.sentCopyStatus,
    identity: toAddress(record.identity),
    recipients: toRecipients(record.recipients),
    subject: record.subject,
    rfcMessageId: record.rfcMessageId,
    recipientResults: record.recipientResults,
    smtpResponse: record.smtpResponse,
    lastError: record.lastError,
    createdAt: record.createdAt.toISOString(),
    sentAt: record.sentAt === null ? null : record.sentAt.toISOString(),
  };
}

function toAddress(address: { address: string; name: string | null }): MessageAddress {
  return { address: address.address, name: address.name };
}

function toRecipients(recipients: {
  to: { address: string; name: string | null }[];
  cc?: { address: string; name: string | null }[] | null;
  bcc?: { address: string; name: string | null }[] | null;
}): MessageRecipients {
  return {
    to: recipients.to.map(toAddress),
    cc: recipients.cc?.map(toAddress) ?? [],
    bcc: recipients.bcc?.map(toAddress) ?? [],
  };
}
