import { AlertTriangle, Check, RefreshCw, X } from "lucide-react";
import type { OutboundView, RecipientResultView } from "@mail-hub/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { formatFullTime } from "@/lib/format";
import {
  resendGateOf,
  sendAttemptSettled,
  sendPhaseBadgeVariant,
  sendPhaseDescription,
  sendPhaseLabel,
  sendPhaseOf,
  sentCopyBadgeVariant,
  sentCopyStatusDescription,
  sentCopyStatusLabel,
} from "@/mail/send-state";
import { cn } from "@/lib/utils";

/*
 * The send panel (SPEC F7): the SMTP attempt and the separate Sent-copy
 * append each show their own state, recipient results stay visible, and no
 * control ever resubmits an attempt whose outcome is not known for certain.
 */

export interface SendPanelProps {
  outbound: OutboundView;
  /** Re-reads the snapshot once; polling continues on its own. */
  onRefresh: () => void;
  /** Offered after a definitive failure: edit the unlocked draft again. */
  onEditAgain?: () => void;
  className?: string;
}

export function SendPanel({ outbound, onRefresh, onEditAgain, className }: SendPanelProps) {
  const phase = sendPhaseOf(outbound);
  const gate = resendGateOf(outbound);
  const settled = sendAttemptSettled(outbound);
  const rejected = outbound.recipientResults.filter((result) => !result.accepted);
  const accepted = outbound.recipientResults.filter((result) => result.accepted);

  return (
    <section
      aria-label="Send status"
      className={cn("flex flex-col gap-3 rounded-md border bg-surface p-3", className)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={sendPhaseBadgeVariant(phase)}>
          {!settled ? (
            <Spinner aria-hidden="true" className="size-3" />
          ) : phase === "failed" ? (
            <X aria-hidden="true" className="size-3" />
          ) : (
            <Check aria-hidden="true" className="size-3" />
          )}
          {sendPhaseLabel(phase)}
        </Badge>
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {sendPhaseDescription(phase)}
        </p>
        <Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Refresh send status">
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">Queued</dt>
        <dd>{formatFullTime(outbound.createdAt)}</dd>
        {outbound.sentAt !== null && (
          <>
            <dt className="text-muted-foreground">Finished</dt>
            <dd>{formatFullTime(outbound.sentAt)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Message</dt>
        <dd className="truncate font-mono text-xs">{outbound.rfcMessageId}</dd>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={sentCopyBadgeVariant(outbound.sentCopyStatus)}>
          {sentCopyStatusLabel(outbound.sentCopyStatus)}
        </Badge>
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {sentCopyStatusDescription(outbound.sentCopyStatus)}
        </p>
      </div>

      {outbound.recipientResults.length > 0 && (
        <>
          <Separator />
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium">Recipients</h4>
            <ul className="flex flex-col gap-1" data-testid="send-recipients">
              {outbound.recipientResults.map((result) => (
                <li key={result.address} className="flex items-start gap-2 text-sm">
                  <span aria-hidden="true" className="mt-0.5">
                    {result.accepted ? (
                      <Check className="size-4 text-success" />
                    ) : (
                      <X className="size-4 text-destructive" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="break-all">{result.address}</span>
                    <span className="block text-muted-foreground">
                      {result.accepted ? "Accepted for delivery." : responseLine(result)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {phase === "partial" && rejected.length > 0 && (
        <p className="rounded bg-warning-muted px-2 py-1.5 text-sm text-warning-muted-foreground">
          {accepted.length} recipient{accepted.length === 1 ? "" : "s"} accepted and{" "}
          {rejected.length} rejected. The accepted ones were sent once; a retry would send to
          them again, so none is offered.
        </p>
      )}

      {outbound.lastError !== null && (
        <p className="flex items-start gap-2 rounded bg-destructive-muted px-2 py-1.5 text-sm text-destructive-muted-foreground">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {errorLine(outbound)}
        </p>
      )}

      {gate.kind === "unavailable" ? (
        phase === "failed" || phase === "unknown" ? (
          <p className="text-sm text-muted-foreground">{gate.reason}</p>
        ) : null
      ) : (
        onEditAgain !== undefined && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onEditAgain}>
              Edit the draft and queue it again
            </Button>
          </div>
        )
      )}
    </section>
  );
}

/** The first line of one recorded SMTP response, whatever shape it took. */
function responseLine(result: RecipientResultView): string {
  const text = responseText(result.response);
  return text === "" ? "Rejected by the server." : `Rejected: ${text}`;
}

/** The first line of the recorded failure of one attempt. */
function errorLine(outbound: OutboundView): string {
  const text = responseText(outbound.lastError);
  return text === "" ? "The attempt failed without a recorded reason." : text;
}

/** One display line from an unknown-shape response value. */
function responseText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.split("\n")[0]!.trim();
  }
  if (typeof value === "object") {
    for (const key of ["message", "reason", "error", "finalResponse", "response"]) {
      const entry = (value as Record<string, unknown>)[key];
      if (typeof entry === "string" && entry.trim().length > 0) {
        return entry.split("\n")[0]!.trim();
      }
    }
  }
  return String(value).split("\n")[0]!.trim();
}
