import { Paperclip, Star } from "lucide-react";
import type { SearchResultItem } from "@mail-hub/contracts";
import { cn } from "@/lib/utils";
import { formatListTime, senderLabel } from "@/lib/format";

/*
 * One message row (SPEC F3): sender, subject, snippet, time, and one state
 * marker. The account color dot is never the only account signal, and state
 * is never carried by color alone.
 */

export interface MessageRowProps {
  item: SearchResultItem;
  selected: boolean;
  /** Shows the account label next to the sender in cross-account views. */
  showAccount: boolean;
  onSelect: (item: SearchResultItem) => void;
}

export function MessageRow({ item, selected, showAccount, onSelect }: MessageRowProps) {
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(item)}
      className={cn(
        "flex h-full w-full flex-col items-start gap-0.5 border-b border-border px-3 py-row-y text-left",
        "transition-colors duration-feedback ease-out-quiet",
        selected ? "bg-selection" : "hover:bg-muted active:bg-muted/70",
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full ring-1 ring-border"
          style={{ backgroundColor: item.accountColor }}
        />
        <span
          className={cn(
            "min-w-0 truncate",
            item.unread ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
          )}
        >
          {senderLabel(item.sender)}
        </span>
        {showAccount ? (
          <span className="min-w-0 truncate text-muted-foreground">{item.accountLabel}</span>
        ) : (
          <span className="sr-only">in {item.accountLabel}</span>
        )}
        {item.noServerCopy && (
          <span className="shrink-0 text-muted-foreground">no server copy</span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <span>{formatListTime(item.sentAt)}</span>
          <StateMarker item={item} />
        </span>
      </span>
      <span className={cn("w-full truncate", item.unread && "font-semibold")}>
        {item.subject ?? "(no subject)"}
      </span>
      <span className="w-full truncate text-muted-foreground">{snippetText(item)}</span>
    </button>
  );
}

/** The snippet, or an honest placeholder while the body is still syncing. */
function snippetText(item: SearchResultItem): string {
  if (item.snippet !== null && item.snippet.length > 0) {
    return item.snippet;
  }
  return item.fetchedBody ? "" : "Body still syncing";
}

/**
 * One state marker per row (SPEC F3). Unread wins over starred, which wins
 * over the attachment note; each marker carries screen-reader text.
 */
function StateMarker({ item }: { item: SearchResultItem }) {
  if (item.unread) {
    return (
      <span className="flex items-center gap-1">
        <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
        <span className="sr-only">Unread</span>
      </span>
    );
  }
  if (item.flagged) {
    return (
      <span className="flex items-center gap-1">
        <Star aria-hidden="true" className="size-3.5 fill-current" />
        <span className="sr-only">Starred</span>
      </span>
    );
  }
  if (item.hasAttachments) {
    return (
      <span className="flex items-center gap-1">
        <Paperclip aria-hidden="true" className="size-3.5" />
        <span className="sr-only">Has attachments</span>
      </span>
    );
  }
  return null;
}
