import { ArrowLeft, Download, Lightbulb, Paperclip, Sparkles, Star } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  MessageAttachmentView,
  MessageClassificationView,
  MessageDetailView,
  SearchResultItem,
} from "@mail-hub/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api";
import {
  classHintLabel,
  formatBytes,
  formatCount,
  formatFullTime,
  senderLabel,
  suggestionSourceLabel,
} from "@/lib/format";
import { useCleanView, useInlineImages, useMessageDetail } from "@/mail/data";
import { useAppSettings } from "@/settings/settings-context";
import { prepareMessageDocument } from "@/mail/render";
import { SanitizedMessageFrame, useReaderColors } from "./message-body";

/*
 * The reader pane (SPEC F3). The list row carries the header; this pane adds
 * the sanitized body, quote collapsing, the optional clean view, the
 * remote-image decision, and verified attachment downloads. Every body byte
 * is a server-sanitized derivative; the frame adds its own sandbox on top.
 */

export interface ReaderPaneProps {
  message: SearchResultItem | null;
  onBack: () => void;
  onSessionLost: () => void;
  className?: string;
}

export function ReaderPane({ message, onBack, onSessionLost, className }: ReaderPaneProps) {
  const messageId = message?.messageId ?? null;
  const detailResource = useMessageDetail(messageId);
  const detail = detailResource.phase === "ready" ? (detailResource.data?.message ?? null) : null;
  const body = detail !== null && detail.htmlSanitized !== null ? detail : null;
  const inline = useInlineImages(body);
  const colors = useReaderColors();

  // "Load images" is one decision per message; it never spills to the next.
  const [imagesLoadedFor, setImagesLoadedFor] = useState<string | null>(null);
  const allowRemoteImages = messageId !== null && imagesLoadedFor === messageId;

  // Clean view is one toggle per message (SPEC F3): Defuddle extraction,
  // then DOMPurify, then this same frame. The sanitized original stays one
  // click away, and the remote-image policy applies to both views. A message
  // without its own choice yet starts from the stored default (SPEC F10).
  const { settings } = useAppSettings();
  const [cleanChoice, setCleanChoice] = useState<{ id: string; on: boolean } | null>(null);
  const cleanEnabled =
    messageId !== null &&
    (cleanChoice?.id === messageId ? cleanChoice.on : settings.cleanViewDefault);
  const cleanResource = useCleanView(messageId, cleanEnabled);
  const cleanView = cleanEnabled && cleanResource.phase === "ready" ? cleanResource.data : null;
  const activeHtml = cleanView?.html ?? body?.htmlSanitized ?? null;

  const cleanNote =
    cleanEnabled && cleanResource.phase === "error"
      ? "Clean view cannot be loaded. Showing the sanitized original."
      : cleanView?.source === "original_fallback"
        ? "Extraction found nothing to clean. Showing the sanitized original."
        : null;

  const prepared = useMemo(
    () =>
      activeHtml !== null
        ? prepareMessageDocument({
            html: activeHtml,
            inlineImages: inline.map,
            allowRemoteImages,
            colors,
          })
        : null,
    [activeHtml, inline.map, allowRemoteImages, colors],
  );

  return (
    <section
      aria-label="Message reader"
      // An outer focus target beside the sandboxed body frame: while the
      // frame holds focus, its key events stay isolated, so keyboard users
      // need a reachable element back on the shell (SPEC F11).
      tabIndex={-1}
      className={cn("flex min-h-0 flex-col bg-surface", className)}
    >
      {message === null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-muted-foreground">Select a message to read it.</p>
        </div>
      ) : (
        <>
          <header className="flex shrink-0 items-start gap-2 border-b px-3 py-3 lg:px-4">
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ms-1 max-md:size-11 lg:hidden"
              onClick={onBack}
              aria-label="Back to the message list"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-reading font-semibold">
                {detail?.subject ?? message.subject ?? "(no subject)"}
              </h2>
              <p className="mt-0.5 truncate text-muted-foreground">
                {senderLabel(detail?.sender ?? message.sender)}
                <span aria-hidden="true"> · </span>
                {formatFullTime(detail?.sentAt ?? message.sentAt)}
              </p>
              {detail?.recipients !== null && detail?.recipients !== undefined && (
                <p className="mt-0.5 truncate text-muted-foreground">
                  To {addressList(detail.recipients.to)}
                  {detail.recipients.cc.length > 0 && (
                    <>
                      <span aria-hidden="true"> · </span>
                      Cc {addressList(detail.recipients.cc)}
                    </>
                  )}
                </p>
              )}
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto w-full max-w-3xl px-3 py-4 lg:px-6">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full ring-1 ring-border"
                    style={{ backgroundColor: message.accountColor }}
                  />
                  {message.accountLabel}
                </Badge>
                {message.unread && <Badge>Unread</Badge>}
                {message.flagged && (
                  <Badge variant="warning">
                    <Star aria-hidden="true" className="size-3 fill-current" />
                    Starred
                  </Badge>
                )}
                {message.hasAttachments && (
                  <Badge variant="info">
                    <Paperclip aria-hidden="true" className="size-3" />
                    Attachments
                  </Badge>
                )}
                {message.noServerCopy && <Badge variant="outline">No server copy</Badge>}
                {message.sentCopyStatus !== null && (
                  <Badge variant={message.sentCopyStatus === "stored" ? "success" : "warning"}>
                    Sent copy: {message.sentCopyStatus}
                  </Badge>
                )}
              </div>

              {detail?.classification !== undefined && (
                <ClassificationSuggestion classification={detail.classification} />
              )}

              <div className="mt-4">
                {detailResource.offlineFromCache && (
                  <p role="status" className="mb-3 rounded-lg border bg-surface px-3 py-1.5 text-muted-foreground">
                    Offline. Showing the copy downloaded earlier.
                  </p>
                )}
                {detailResource.phase === "error" ? (
                  <BodyError
                    unauthorized={detailResource.error?.unauthorized === true}
                    message={detailResource.error?.message ?? ""}
                    onReload={detailResource.reload}
                    onSessionLost={onSessionLost}
                  />
                ) : detail === null ? (
                  <BodySkeleton />
                ) : detail.fetchedBody ? (
                  <>
                    {detail.htmlSanitized !== null && (
                      <div className="mb-3 flex min-h-9 flex-wrap items-center justify-end gap-2">
                        {cleanNote !== null && (
                          <p className="min-w-0 flex-1 text-muted-foreground">{cleanNote}</p>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          aria-pressed={cleanEnabled}
                          disabled={cleanEnabled && cleanView === null && cleanResource.phase === "loading"}
                          onClick={() =>
                            setCleanChoice(
                              cleanEnabled ? null : { id: message.messageId, on: true },
                            )
                          }
                        >
                          <Sparkles aria-hidden="true" className="size-3.5" />
                          Clean view
                        </Button>
                      </div>
                    )}
                    <BodyContent
                      detail={detail}
                      prepared={prepared}
                      inlineMap={inline.map}
                      allowRemoteImages={allowRemoteImages}
                      onLoadImages={() => setImagesLoadedFor(messageId)}
                    />
                  </>
                ) : (
                  <p className="rounded-lg border bg-surface p-4 text-muted-foreground">
                    The body has not been fetched from the server yet. It
                    arrives during background synchronization; read the stored
                    header until then.
                  </p>
                )}
              </div>

              {detail !== null && detail.attachments.length > 0 && (
                <AttachmentsSection messageId={detail.id} attachments={detail.attachments} />
              )}
            </div>
          </div>

          <p role="status" aria-live="polite" className="sr-only">
            {readerStatus(detailResource.phase, detail?.fetchedBody ?? null, inline.map, cleanEnabled)}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The visible classification suggestion (SPEC F8 shadow mode). Badges carry
 * the advice; the caption states the contract — a suggestion never moves
 * mail. A message the owner placed by hand carries no class and shows only
 * what Jev flagged, or nothing at all.
 */
function ClassificationSuggestion({ classification }: { classification: MessageClassificationView }) {
  const flags = [
    classification.asksAction === true ? "Asks for action" : null,
    classification.asksReply === true ? "Asks for a reply" : null,
    classification.timeSensitive === true ? "Time-sensitive" : null,
  ].filter((flag): flag is string => flag !== null);
  if (classification.classHint === null && flags.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2">
      {classification.classHint !== null && (
        <Badge variant="outline">
          <Lightbulb aria-hidden="true" className="size-3" />
          {classHintLabel(classification.classHint)}
        </Badge>
      )}
      {flags.map((flag) => (
        <Badge key={flag} variant="outline">
          {flag}
        </Badge>
      ))}
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        Suggested by {suggestionSourceLabel(classification.source ?? "")}. Shadow
        mode: this never moves mail.
      </p>
    </div>
  );
}

/** The body of one fetched message: sanitized HTML or plain text. */
function BodyContent({
  detail,
  prepared,
  inlineMap,
  allowRemoteImages,
  onLoadImages,
}: {
  detail: MessageDetailView;
  prepared: ReturnType<typeof prepareMessageDocument> | null;
  inlineMap: Map<string, string> | null;
  allowRemoteImages: boolean;
  onLoadImages: () => void;
}) {
  if (detail.htmlSanitized === null) {
    if (detail.textPlain !== null) {
      return (
        <p className="measure whitespace-pre-wrap text-reading">{detail.textPlain}</p>
      );
    }
    return (
      <p className="rounded-lg border bg-surface p-4 text-muted-foreground">
        This message has no readable content.
      </p>
    );
  }

  if (prepared === null || inlineMap === null) {
    return <BodySkeleton />;
  }

  return (
    <div>
      {prepared.remoteImageCount > 0 && !allowRemoteImages && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <p className="min-w-0 flex-1 text-muted-foreground">
            {formatCount(prepared.remoteImageCount)} remote{" "}
            {prepared.remoteImageCount === 1 ? "image is" : "images are"} blocked
            to keep the sender from tracking this read.
          </p>
          <Button variant="outline" size="sm" onClick={onLoadImages}>
            Load images
          </Button>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border bg-surface">
        {/* The sandboxed content cannot report its height, so the frame
            takes a viewport share and scrolls inside itself when longer. */}
        <SanitizedMessageFrame
          document={prepared.document}
          className="h-[clamp(16rem,calc(100dvh-18rem),48rem)]"
        />
      </div>
    </div>
  );
}

function BodySkeleton() {
  return (
    <div className="space-y-3 rounded-lg border bg-surface p-4" aria-hidden="true">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function BodyError({
  unauthorized,
  message,
  onReload,
  onSessionLost,
}: {
  unauthorized: boolean;
  message: string;
  onReload: () => void;
  onSessionLost: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border bg-surface p-6 text-center">
      <p className="font-medium">
        {unauthorized ? "Your session ended." : "This message cannot be loaded."}
      </p>
      <p className="max-w-sm text-muted-foreground">{message}</p>
      {unauthorized ? (
        <Button onClick={onSessionLost}>Sign in again</Button>
      ) : (
        <Button variant="outline" onClick={onReload}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Download rows for every attachment of the message (SPEC F3). */
function AttachmentsSection({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: MessageAttachmentView[];
}) {
  return (
    <section aria-label="Attachments" className="mt-6">
      <h3 className="flex items-center gap-1.5 text-muted-foreground">
        <Paperclip aria-hidden="true" className="size-3.5" />
        {formatCount(attachments.length)}{" "}
        {attachments.length === 1 ? "attachment" : "attachments"}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {attachments.map((attachment) => (
          <li
            key={attachment.id}
            className="flex items-center gap-3 rounded-lg border bg-surface px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-reading">
                {attachment.filename ?? "Unnamed attachment"}
              </p>
              <p className="truncate text-muted-foreground">
                {[
                  attachment.contentType ?? "unknown type",
                  formatBytes(attachment.sizeBytes),
                  attachment.inlineResolvable ? "shown inline" : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a
                href={apiUrl(`/messages/${messageId}/attachments/${attachment.id}`)}
                download={attachment.filename ?? undefined}
              >
                <Download aria-hidden="true" className="size-3.5" />
                Download
              </a>
            </Button>
          </li>
        ))}
      </ul>
      <Separator className="mt-6" />
      <p className="mt-3 text-muted-foreground">
        Downloads carry the decoded bytes the server verified against their
        recorded hash.
      </p>
    </section>
  );
}

function addressList(addresses: { address: string; name?: string | null }[]): string {
  return addresses.map((address) => senderLabel(address)).join(", ");
}

function readerStatus(
  phase: "loading" | "ready" | "error",
  fetchedBody: boolean | null,
  inlineMap: Map<string, string> | null,
  cleanView: boolean,
): string {
  if (phase === "error") {
    return "The message could not be loaded.";
  }
  if (phase === "loading") {
    return "Loading the message.";
  }
  if (fetchedBody !== true) {
    return "Only the stored header exists for this message so far.";
  }
  if (inlineMap === null) {
    return "Loading the message with its inline images.";
  }
  return cleanView ? "Message loaded in clean view." : "Message loaded.";
}
