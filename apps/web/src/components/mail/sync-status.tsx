import { AlertTriangle, CloudOff, History } from "lucide-react";
import { useEffect, useState } from "react";
import type { DraftView } from "@mail-hub/contracts";
import {
  RESTORE_REVIEW_MESSAGE,
  type ReviewChoice,
  type ReviewItem,
  type SyncSnapshot,
} from "@mail-hub/offline";
import { useOfflineSync } from "@/offline/sync-context.tsx";
import { fetchServerDraft, offlineSync } from "@/offline/port.ts";
import { offlineStore } from "@/offline/store.ts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/*
 * The always-visible sync state (SPEC F9): what has not synchronized, sends
 * waiting on this device, and the review a restore requires. Nothing here
 * replays by itself; every resolution goes through the explicit steps.
 */

/** How the header presents the device's sync state. */
export interface SyncStatusView {
  tone: "hidden" | "offline" | "review" | "pending" | "syncing";
  label: string;
  /** Longer text for tooltips and screen-reader announcements. */
  description: string;
}

/** Derive the one status line the interface shows (SPEC F9). */
export function describeSyncStatus(
  snapshot: SyncSnapshot | null,
  online: boolean,
  syncing: boolean,
): SyncStatusView {
  const waiting = snapshot?.pendingActions ?? 0;
  const waitingText = `${waiting} waiting on this device`;
  if (snapshot?.reviewRequired === true) {
    return {
      tone: "review",
      label: RESTORE_REVIEW_MESSAGE,
      description:
        "The server was restored from an earlier history. Review each pending change before it syncs.",
    };
  }
  if (!online) {
    return {
      tone: "offline",
      label: waiting > 0 ? `Offline · ${waitingText}` : "Offline",
      description:
        waiting > 0
          ? `Offline. ${waitingText}. Drafts and files stay on this device.`
          : "Offline. Downloaded mail still reads, and drafting continues.",
    };
  }
  if (waiting > 0) {
    return {
      tone: "pending",
      label: waitingText,
      description:
        "Changes queued on this device sync when the connection returns. They keep their original targets.",
    };
  }
  if (syncing) {
    return {
      tone: "syncing",
      label: "Syncing",
      description: "Sending this device's queued changes to the server.",
    };
  }
  return { tone: "hidden", label: "", description: "" };
}

/** The header control for sync state; it opens the review when needed. */
export function SyncStatusChip() {
  const { snapshot, online, syncing } = useOfflineSync();
  const [reviewOpen, setReviewOpen] = useState(false);
  const view = describeSyncStatus(snapshot, online, syncing);
  const reviewCount = snapshot?.reviewActions.length ?? 0;

  useEffect(() => {
    if (snapshot?.reviewRequired === true && reviewCount > 0) {
      // A restore demands attention (SPEC F9); the dialog opens once.
      setReviewOpen(true);
    }
  }, [snapshot?.reviewRequired, reviewCount]);

  if (view.tone === "hidden") {
    return null;
  }

  const icon =
    view.tone === "offline" ? (
      <CloudOff aria-hidden="true" className="size-4" />
    ) : view.tone === "review" ? (
      <History aria-hidden="true" className="size-4" />
    ) : view.tone === "syncing" ? (
      <Spinner aria-hidden="true" className="size-4" />
    ) : (
      <AlertTriangle aria-hidden="true" className="size-4" />
    );

  return (
    <>
      <Button
        variant={view.tone === "review" ? "default" : "ghost"}
        size="sm"
        className={cn("gap-1.5 max-md:size-11 max-md:px-0")}
        onClick={() => setReviewOpen(true)}
        disabled={reviewCount === 0}
        aria-label={view.description}
      >
        {icon}
        <span className="hidden md:inline max-w-40 truncate">{view.label}</span>
      </Button>
      <p role="status" aria-live="polite" className="sr-only">
        {view.description}
      </p>
      <RestoreReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} />
    </>
  );
}

/** One queued action family, in interface terms. */
export function reviewKindLabel(kind: ReviewItem["kind"]): string {
  switch (kind) {
    case "draft-save":
      return "Draft edits";
    case "upload":
      return "File upload";
    case "send":
      return "Queued send";
    case "flag":
      return "Flag change";
    case "move":
      return "Move to a folder";
  }
}

/** Why one item waits for a person (SPEC F9 and F7). */
export function reviewReasonLabel(reason: ReviewItem["reason"]): string {
  switch (reason) {
    case "server_restored":
      return "Created before the server was restored.";
    case "uncertain_send":
      return "The send result is unknown. It may have arrived.";
    case "draft_conflict":
      return "The draft changed on the server after these edits.";
  }
}

/** The review surface a restore or an uncertain outcome opens (SPEC F9). */
function RestoreReviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { snapshot, resolve } = useOfflineSync();
  const items = snapshot?.reviewActions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review pending changes</DialogTitle>
          <DialogDescription>
            {snapshot?.reviewRequired === true
              ? RESTORE_REVIEW_MESSAGE
              : "These changes need a decision before they can sync."}
            {" Local text and files stay on this device."}
          </DialogDescription>
        </DialogHeader>
        {items.length === 0 ? (
          <p className="text-muted-foreground">Nothing waits for review.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {items.map((item) => (
              <ReviewItemRow key={item.localId} item={item} onResolve={resolve} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One reviewable action and its explicit resolution steps. */
function ReviewItemRow({
  item,
  onResolve,
}: {
  item: ReviewItem;
  onResolve: (localId: string, choice: ReviewChoice) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [comparison, setComparison] = useState<{
    server: DraftView | null;
    localMarkdown: string | null;
  } | null>(null);

  const run = async (choice: ReviewChoice) => {
    setBusy(true);
    try {
      await onResolve(item.localId, choice);
    } finally {
      setBusy(false);
    }
  };

  const compare = async () => {
    setBusy(true);
    try {
      const [server, local] = await Promise.all([
        item.draftId === null ? Promise.resolve(null) : fetchServerDraft(item.draftId),
        item.draftId === null
          ? Promise.resolve(null)
          : (offlineSync()?.localDraft(item.draftId) ?? Promise.resolve(null)),
      ]);
      setComparison({ server, localMarkdown: local?.markdown ?? null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border p-3">
      <p className="font-medium">{reviewKindLabel(item.kind)}</p>
      <p className="text-muted-foreground">{reviewReasonLabel(item.reason)}</p>

      {item.kind === "send" ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="rounded bg-destructive-muted px-2 py-1.5 text-destructive-muted-foreground">
            Sending again may deliver a duplicate. The original attempt may have arrived.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={warningAcknowledged}
              onCheckedChange={(checked) => setWarningAcknowledged(checked === true)}
            />
            I understand this may send a duplicate.
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run({ choice: "discard" })}>
              Don&apos;t send
            </Button>
            <Button
              size="sm"
              disabled={busy || !warningAcknowledged}
              onClick={() =>
                run({ choice: "rebase", duplicateWarningAcknowledged: true })
              }
            >
              Send again with a new key
            </Button>
          </div>
        </div>
      ) : item.kind === "draft-save" ? (
        <div className="mt-2 flex flex-col gap-2">
          {comparison === null ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void compare()}>
              Compare with the server
            </Button>
          ) : (
            <>
              <div className="grid gap-2 text-sm">
                <div>
                  <p className="font-medium">On the server</p>
                  <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-muted-foreground">
                    {comparison.server?.markdown ?? "(the server no longer holds this draft)"}
                  </pre>
                </div>
                <div>
                  <p className="font-medium">On this device</p>
                  <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-muted-foreground">
                    {comparison.localMarkdown ?? "(no local copy)"}
                  </pre>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || comparison.server === null}
                  onClick={() =>
                    void keepServerCopy(item, comparison.server!).then(() =>
                      run({ choice: "discard" }),
                    )
                  }
                >
                  Keep the server copy
                </Button>
                <Button
                  size="sm"
                  disabled={busy || comparison.server === null}
                  onClick={() =>
                    run({
                      choice: "rebase",
                      comparedWithServer: true,
                      serverRevision: comparison.server!.revision,
                    })
                  }
                >
                  Keep my edits
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => run({ choice: "discard" })}>
            Discard
          </Button>
          <Button size="sm" disabled={busy} onClick={() => run({ choice: "rebase" })}>
            Keep it queued
          </Button>
        </div>
      )}
      <Separator className="mt-3" />
    </li>
  );
}

/** Adopt the server copy locally after a discard (SPEC F9: explicit choice). */
async function keepServerCopy(item: ReviewItem, server: DraftView): Promise<void> {
  const controller = offlineSync();
  const store = offlineStore();
  if (controller === null || store === null) {
    return;
  }
  await controller.noteComparedServerCopy(item.draftId ?? "", server);
  const local = await controller.localDraft(item.draftId ?? "");
  if (local !== null) {
    await store.putLocalDraft({
      ...local,
      subject: server.subject,
      markdown: server.markdown,
      baseRevision: server.revision,
      dirty: false,
    });
  }
}
