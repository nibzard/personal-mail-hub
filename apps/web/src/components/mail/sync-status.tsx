import { AlertTriangle, CloudOff, History, LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import type { DraftView } from "@mail-hub/contracts";
import {
  RESTORE_REVIEW_MESSAGE,
  type FailedItem,
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
  tone: "hidden" | "offline" | "review" | "sign-in" | "failed" | "pending" | "syncing";
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
  const failed = snapshot?.failedActions.length ?? 0;
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
  if (snapshot?.signInRequired === true) {
    return {
      tone: "sign-in",
      label: waiting > 0 ? `Sign in to sync · ${waitingText}` : "Sign in to sync",
      description:
        waiting > 0
          ? "Your session ended. Sign in again so the queued changes can sync."
          : "Your session ended. Sign in again to sync this device.",
    };
  }
  if (failed > 0) {
    return {
      tone: "failed",
      label: `${failed} failed to sync`,
      description:
        "The server refused these queued changes. Review each one, then retry or discard it.",
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
export function SyncStatusChip({ onSessionLost }: { onSessionLost: () => void }) {
  const { snapshot, online, syncing } = useOfflineSync();
  const [reviewOpen, setReviewOpen] = useState(false);
  const view = describeSyncStatus(snapshot, online, syncing);
  const reviewCount = snapshot?.reviewActions.length ?? 0;
  const failedCount = snapshot?.failedActions.length ?? 0;

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
    ) : view.tone === "sign-in" ? (
      <LogIn aria-hidden="true" className="size-4" />
    ) : view.tone === "syncing" ? (
      <Spinner aria-hidden="true" className="size-4" />
    ) : (
      <AlertTriangle aria-hidden="true" className="size-4" />
    );

  return (
    <>
      <Button
        variant={view.tone === "review" || view.tone === "sign-in" ? "default" : "ghost"}
        size="sm"
        className={cn("gap-1.5 max-md:size-11 max-md:px-0")}
        onClick={() => setReviewOpen(true)}
        disabled={reviewCount === 0 && failedCount === 0 && snapshot?.signInRequired !== true}
        aria-label={view.description}
      >
        {icon}
        <span className="hidden md:inline max-w-40 truncate">{view.label}</span>
      </Button>
      <p role="status" aria-live="polite" className="sr-only">
        {view.description}
      </p>
      <RestoreReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onSessionLost={onSessionLost}
      />
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
  onSessionLost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSessionLost: () => void;
}) {
  const { snapshot, resolve, retry, discard } = useOfflineSync();
  const items = snapshot?.reviewActions ?? [];
  const failed = snapshot?.failedActions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review pending changes</DialogTitle>
          <DialogDescription>
            {snapshot?.reviewRequired === true
              ? RESTORE_REVIEW_MESSAGE
              : "These changes need a decision before they can sync."}
            {" Local text stays on this device."}
          </DialogDescription>
        </DialogHeader>
        {snapshot?.signInRequired === true && (
          <div className="flex flex-wrap items-center gap-2 rounded bg-destructive-muted px-2 py-1.5">
            <p className="min-w-0 flex-1 text-destructive-muted-foreground">
              Your session ended. Sign in again so the queued changes can sync.
            </p>
            <Button size="sm" onClick={onSessionLost}>
              Sign in again
            </Button>
          </div>
        )}
        {items.length === 0 && failed.length === 0 ? (
          <p className="text-muted-foreground">Nothing waits for review.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {items.map((item) => (
              <ReviewItemRow key={item.localId} item={item} onResolve={resolve} />
            ))}
            {failed.map((item) => (
              <FailedItemRow key={item.localId} item={item} onRetry={retry} onDiscard={discard} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One definitively refused action, with its retry and discard path. */
function FailedItemRow({
  item,
  onRetry,
  onDiscard,
}: {
  item: FailedItem;
  onRetry: (localId: string) => Promise<void>;
  onDiscard: (localId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // A refused step stays owned by its row: the rejection surfaces here, not
  // as an unhandled one, and the busy flag settles either way.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (error) {
      setNote(actionFailureText(error, "The change could not be applied. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-md border p-3">
      <p className="font-medium">{reviewKindLabel(item.kind)}</p>
      <p className="text-muted-foreground">{item.failure}</p>
      {note !== null && (
        <p role="status" className="mt-2 text-sm text-destructive">
          {note}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run(() => onRetry(item.localId))}
        >
          Try again
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void run(() => onDiscard(item.localId))}
        >
          Discard
        </Button>
      </div>
      <Separator className="mt-3" />
    </li>
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
  const [note, setNote] = useState<string | null>(null);
  const [warningAcknowledged, setWarningAcknowledged] = useState(false);
  const [comparison, setComparison] = useState<{
    server: DraftView | null;
    localMarkdown: string | null;
  } | null>(null);

  // Every step a row can take runs through one guard: a rejection — a
  // choice the queue no longer holds, a comparison the server refused —
  // shows its words in the row instead of escaping unhandled, and the busy
  // flag settles either way.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (error) {
      setNote(actionFailureText(error, "The step could not be applied. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const resolve = (choice: ReviewChoice) => run(() => onResolve(item.localId, choice));

  const compare = () =>
    run(async () => {
      const [server, local] = await Promise.all([
        item.draftId === null ? Promise.resolve(null) : fetchServerDraft(item.draftId),
        item.draftId === null
          ? Promise.resolve(null)
          : (offlineSync()?.localDraft(item.draftId) ?? Promise.resolve(null)),
      ]);
      setComparison({ server, localMarkdown: local?.markdown ?? null });
    });

  /** Adopts the server copy first; only then resolves the item as discarded. */
  const keepServer = (server: DraftView) =>
    run(async () => {
      await keepServerCopy(item, server);
      await onResolve(item.localId, { choice: "discard" });
    });

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
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void resolve({ choice: "discard" })}>
              Don&apos;t send
            </Button>
            <Button
              size="sm"
              disabled={busy || !warningAcknowledged}
              onClick={() =>
                void resolve({ choice: "rebase", duplicateWarningAcknowledged: true })
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
                  onClick={() => void keepServer(comparison.server!)}
                >
                  Keep the server copy
                </Button>
                <Button
                  size="sm"
                  disabled={busy || comparison.server === null}
                  onClick={() =>
                    void resolve({
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
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void resolve({ choice: "discard" })}>
            Discard
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void resolve({ choice: "rebase" })}>
            Keep it queued
          </Button>
        </div>
      )}
      {note !== null && (
        <p role="status" className="mt-2 text-sm text-destructive">
          {note}
        </p>
      )}
      <Separator className="mt-3" />
    </li>
  );
}

/**
 * The words one failed row step shows: the error's own message when it
 * carries one — an `ApiError` refusal, a `ReviewChoiceError` for a queued
 * action that no longer exists — and the fallback otherwise.
 */
function actionFailureText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
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
