import { ArrowLeft, Paperclip, Star } from "lucide-react";
import type { SearchResultItem } from "@mail-hub/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { formatFullTime, senderLabel } from "@/lib/format";

/*
 * The reader pane. This milestone shows the stored summary of the selected
 * message; the sanitized reader, quote collapsing, and attachment routes are
 * the safe-reader update (SPEC F3). The pane itself, its header, and its
 * empty state are the surfaces that update keeps.
 */

export interface ReaderPaneProps {
  message: SearchResultItem | null;
  onBack: () => void;
  className?: string;
}

export function ReaderPane({ message, onBack, className }: ReaderPaneProps) {
  return (
    <section
      aria-label="Message reader"
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
              className="-ms-1 lg:hidden"
              onClick={onBack}
              aria-label="Back to the message list"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
            </Button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-reading font-semibold">
                {message.subject ?? "(no subject)"}
              </h2>
              <p className="mt-0.5 truncate text-muted-foreground">
                {senderLabel(message.sender)}
                <span aria-hidden="true"> · </span>
                {formatFullTime(message.sentAt)}
              </p>
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

              <div className="mt-4 rounded-lg border bg-surface p-4">
                <p className="text-reading whitespace-pre-wrap">
                  {message.snippet ??
                    (message.fetchedBody
                      ? "This message has no preview text."
                      : "The body has not been fetched from the server yet.")}
                </p>
                <Separator className="my-4" />
                <p className="text-muted-foreground">
                  The sanitized message reader arrives with the safe-reader
                  update. This pane shows the stored summary of the selected
                  message.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
