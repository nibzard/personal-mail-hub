import { CloudOff, Eye, FileUp, Pencil, Trash2 } from "lucide-react";
import type { AccountSummary, DraftAttachmentView, DraftView, MessageRecipients } from "@mail-hub/contracts";
import { DraftAutosaver, type AutosaveState } from "@mail-hub/compose/autosave";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { toApiError } from "@/lib/api";
import { formatBytes, formatListTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useOfflineSync } from "@/offline/sync-context.tsx";
import {
  addFileToDraft,
  attachAcknowledgedUploads,
  detachDraftAttachment,
  discardDraft,
  draftSaveRunner,
  invalidAddresses,
  listDraftAttachments,
  localUploadsOf,
  newSendIdempotencyKey,
  parseRecipientList,
  readDraft,
  recipientCount,
  requestDraftSend,
  useOutbound,
  type ComposeSession,
} from "@/mail/compose-data";
import {
  buildPreviewDocument,
  preparePreviewDocument,
} from "@/mail/markdown";
import { DUPLICATE_SEND_WARNING } from "@/mail/send-state";
import { useReaderColors } from "./message-body";
import { SanitizedMessageFrame } from "./message-body";
import { MarkdownEditor } from "./markdown-editor";
import { SendPanel } from "./send-panel";

/*
 * The draft editor (SPEC F6 and F7): the Markdown editor with its preview,
 * the identity and recipient pickers, attachments with their upload state,
 * the two-second autosave with its stale-revision choice, and the send
 * control. Nothing here resubmits an uncertain attempt: a deliberate resend
 * needs the acknowledged duplicate warning and a new idempotency key.
 */

/** The editable fields the editor mirrors from the draft. */
interface DraftFields {
  identity: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  markdown: string;
}

function fieldsOf(draft: DraftView): DraftFields {
  return {
    identity: draft.identity.address,
    to: listToText(draft.recipients.to),
    cc: listToText(draft.recipients.cc ?? []),
    bcc: listToText(draft.recipients.bcc ?? []),
    subject: draft.subject ?? "",
    markdown: draft.markdown,
  };
}

function listToText(list: readonly { address: string; name?: string | null }[]): string {
  return list
    .map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address))
    .join(", ");
}

/** The one-line autosave status, in the words the editor shows (SPEC F12). */
export function autosaveStatusLabel(state: AutosaveState): string {
  switch (state) {
    case "saved":
      return "Saved.";
    case "unsaved":
      return "Unsaved edits.";
    case "saving":
      return "Saving…";
    case "conflict":
      return "The draft changed on the server. Choose which copy to keep.";
    case "offline":
      return "Offline. Edits wait on this device.";
    case "error":
      return "The draft could not be saved.";
  }
}

export interface DraftEditorProps {
  session: ComposeSession;
  accounts: AccountSummary[];
  draftId: string;
  /** The drafts list refreshes after a queue or a discard. */
  onDraftChanged: () => void;
  onDraftDiscarded: () => void;
  onSessionLost: () => void;
}

export function DraftEditor({
  session,
  accounts,
  draftId,
  onDraftChanged,
  onDraftDiscarded,
  onSessionLost,
}: DraftEditorProps) {
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [fields, setFields] = useState<DraftFields | null>(null);
  const [autosaveState, setAutosaveState] = useState<AutosaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ revision: number; server: DraftView | null } | null>(
    null,
  );
  const [attachments, setAttachments] = useState<DraftAttachmentView[] | null>(null);
  const [pendingUploads, setPendingUploads] = useState<
    { localId: string; filename: string; sizeBytes: number }[]
  >([]);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [sendTarget, setSendTarget] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);

  const autosaverRef = useRef<DraftAutosaver | null>(null);
  const autosaverForRef = useRef<string | null>(null);
  const generationRef = useRef(session.recoveryGeneration);
  generationRef.current = session.recoveryGeneration;
  const serverDraftRef = useRef<DraftView | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fieldsRef = useRef<DraftFields | null>(null);
  const sync = useOfflineSync();

  const outboundId = sendTarget ?? draft?.lockedBySend ?? null;
  const outbound = useOutbound(outboundId);

  //
  // Draft loading and the autosaver's life cycle
  //

  const load = useCallback(
    async (options: { adopt: boolean }) => {
      try {
        const read = await readDraft(draftId);
        serverDraftRef.current = read;
        setDraft(read);
        setLoadMessage(null);
        if (options.adopt) {
          setFields(fieldsOf(read));
          fieldsRef.current = fieldsOf(read);
        }
        if (autosaverForRef.current !== read.id) {
          autosaverRef.current?.dispose();
          autosaverRef.current = null;
          autosaverForRef.current = read.id;
          setSaveError(null);
          setAutosaveState("saved");
          autosaverRef.current = new DraftAutosaver({
            draftId: read.id,
            revision: read.revision,
            save: draftSaveRunner({
              recoveryGeneration: () => generationRef.current,
              noteServerDraft: (server) => {
                serverDraftRef.current = server;
              },
              onError: (message) => setSaveError(message),
            }),
            onStateChange: (state) => setAutosaveState(state),
          });
        }
      } catch (error) {
        setLoadMessage(
          error instanceof Error && error.name === "ApiError"
            ? error.message
            : "The draft cannot be loaded.",
        );
      }
    },
    [draftId],
  );

  useEffect(() => {
    setSendTarget(null);
    setUncertain(null);
    setSendNote(null);
    setDiscarding(false);
    void load({ adopt: true });
  }, [load, nonce]);

  // The autosaver stops with the editor.
  useEffect(
    () => () => {
      autosaverRef.current?.dispose();
      autosaverRef.current = null;
      autosaverForRef.current = null;
    },
    [draftId],
  );

  // A conflict fetches the server copy, so the choice compares both (SPEC F9).
  useEffect(() => {
    if (autosaveState !== "conflict") {
      setConflict(null);
      return;
    }
    let live = true;
    void readDraft(draftId)
      .then((server) => {
        if (live) {
          setConflict({ revision: server.revision, server });
        }
      })
      .catch(() => {
        if (live) {
          setConflict({ revision: autosaverRef.current?.revision ?? 0, server: null });
        }
      });
    return () => {
      live = false;
    };
  }, [autosaveState, draftId]);

  //
  // Field edits
  //

  const push = useCallback((patch: Parameters<DraftAutosaver["push"]>[0]) => {
    autosaverRef.current?.push(patch);
  }, []);

  const recipientsOf = useCallback((next: DraftFields): MessageRecipients => ({
    to: parseRecipientList(next.to),
    cc: parseRecipientList(next.cc),
    bcc: parseRecipientList(next.bcc),
  }), []);

  const edit = useCallback(
    (part: Partial<DraftFields>) => {
      const current = fieldsRef.current;
      if (current === null) {
        return;
      }
      const next = { ...current, ...part };
      fieldsRef.current = next;
      setFields(next);
      if (part.identity !== undefined) {
        push({ identity: { address: part.identity } });
      }
      if (part.to !== undefined || part.cc !== undefined || part.bcc !== undefined) {
        push({ recipients: recipientsOf(next) });
      }
      if (part.subject !== undefined) {
        push({ subject: part.subject.length === 0 ? null : part.subject });
      }
      if (part.markdown !== undefined) {
        push({ markdown: part.markdown });
      }
    },
    [push, recipientsOf],
  );

  //
  // Attachments and uploads
  //

  const refreshAttachments = useCallback(async () => {
    try {
      setAttachments(await listDraftAttachments(draftId));
    } catch {
      setAttachments([]);
    }
    setPendingUploads(await localUploadsOf(draftId));
  }, [draftId]);

  useEffect(() => {
    void refreshAttachments();
  }, [refreshAttachments, sync.snapshot?.pendingActions, sync.snapshot?.pendingUploads]);

  // Uploads the queue acknowledged while the editor was closed still need
  // their attach step (SPEC F6).
  useEffect(() => {
    if (!sync.online || session.recoveryGeneration === null || attachments === null) {
      return;
    }
    let live = true;
    void attachAcknowledgedUploads(session, draftId, attachments).then((changed) => {
      if (live && changed) {
        void refreshAttachments();
      }
    });
    return () => {
      live = false;
    };
  }, [session, draftId, attachments, sync.online, refreshAttachments]);

  const onFilesChosen = async (files: FileList | null) => {
    if (draft === null || files === null || files.length === 0) {
      return;
    }
    setFileBusy(true);
    setFileNote(null);
    for (const file of Array.from(files)) {
      const outcome = await addFileToDraft(session, draft, file);
      if (outcome.state === "rejected") {
        setFileNote(outcome.message);
      } else if (outcome.state === "queued-offline") {
        setFileNote(`${outcome.filename} waits on this device and uploads on return.`);
      }
    }
    setFileBusy(false);
    if (fileInputRef.current !== null) {
      fileInputRef.current.value = "";
    }
    await refreshAttachments();
  };

  const removeAttachment = async (uploadId: string) => {
    setFileBusy(true);
    try {
      await detachDraftAttachment(session, draftId, uploadId);
    } catch {
      setFileNote("The file could not be removed. Try again.");
    }
    setFileBusy(false);
    await refreshAttachments();
  };

  //
  // Sending
  //

  const waitingUploads = pendingUploads;
  const invalidInFields = fields === null ? [] : invalidEntries(fields);
  const locked = draft?.lockedBySend != null;
  const canSend =
    draft !== null &&
    fields !== null &&
    !locked &&
    autosaveState !== "conflict" &&
    autosaveState !== "saving" &&
    recipientCount(recipientsOf(fields)) > 0 &&
    invalidInFields.length === 0 &&
    waitingUploads.length === 0;

  const submitSend = async () => {
    const autosaver = autosaverRef.current;
    if (autosaver === null || draft === null || fields === null) {
      return;
    }
    setSendNote(null);
    if (recipientCount(recipientsOf(fields)) === 0) {
      setSendNote("A send needs at least one recipient.");
      return;
    }
    if (invalidInFields.length > 0) {
      setSendNote(`These addresses do not look valid: ${invalidInFields.join(", ")}.`);
      return;
    }
    if (autosaver.pendingPatch !== null) {
      await autosaver.flush();
    }
    if (autosaver.state === "conflict") {
      setSendNote("Resolve the conflicting copy before sending.");
      return;
    }
    // A deliberate send is new work: its own key, never a reused one.
    const outcome = await requestDraftSend(
      session,
      draft.id,
      autosaver.revision,
      newSendIdempotencyKey(),
    );
    switch (outcome.state) {
      case "queued":
        setUncertain(null);
        setDuplicateAcknowledged(false);
        setSendTarget(outcome.outbound.id);
        onDraftChanged();
        void load({ adopt: false });
        return;
      case "queued-offline":
        setSendNote(
          "Offline. The send is queued on this device and replays when the connection returns.",
        );
        onDraftChanged();
        return;
      case "uncertain":
        setUncertain(outcome.message);
        return;
      case "rejected":
        setSendNote(outcome.message);
        return;
    }
  };

  /** Resolves an uncertain queue request: the draft lock is the evidence. */
  const checkUncertain = async () => {
    if (draft === null) {
      return;
    }
    try {
      const read = await readDraft(draft.id);
      serverDraftRef.current = read;
      setDraft(read);
      setUncertain(null);
      setDuplicateAcknowledged(false);
      if (read.lockedBySend !== null) {
        setSendTarget(read.lockedBySend);
        return;
      }
      setSendNote("The server holds no queued send for this draft. Nothing was sent.");
    } catch {
      setSendNote("The draft cannot be read right now. Try again.");
    }
  };

  const editAgain = async () => {
    setSendTarget(null);
    setSendNote(null);
    setNonce((value) => value + 1);
    await load({ adopt: true });
  };

  const discard = async () => {
    if (draft === null) {
      return;
    }
    if (!discarding) {
      setDiscarding(true);
      return;
    }
    try {
      await discardDraft(session, draft.id);
    } catch (error) {
      if (toApiError(error).unauthorized) {
        onSessionLost();
        return;
      }
      setDiscarding(false);
      setSendNote("The draft could not be discarded. Try again.");
      return;
    }
    autosaverRef.current?.dispose();
    autosaverRef.current = null;
    autosaverForRef.current = null;
    onDraftDiscarded();
  };

  //
  // Preview
  //

  const colors = useReaderColors();
  const preview = useMemo(
    () =>
      preparePreviewDocument(fields?.markdown ?? "", {
        allowRemoteImages,
      }),
    [fields?.markdown, allowRemoteImages],
  );
  const previewDocument = useMemo(
    () => buildPreviewDocument(preview.html, colors, allowRemoteImages),
    [preview.html, colors, allowRemoteImages],
  );

  if (draft === null || fields === null) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
        {loadMessage === null ? (
          <>
            <Spinner aria-hidden="true" className="size-5" />
            <p>Loading the draft.</p>
          </>
        ) : (
          <>
            <p>{loadMessage}</p>
            <Button variant="outline" size="sm" onClick={() => setNonce((value) => value + 1)}>
              Try again
            </Button>
          </>
        )}
      </div>
    );
  }

  const account = accounts.find((entry) => entry.id === draft.accountId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {outboundId !== null && (
        <>
          {outbound.phase === "ready" && outbound.outbound !== null ? (
            <SendPanel
              outbound={outbound.outbound}
              onRefresh={outbound.reload}
              onEditAgain={editAgain}
            />
          ) : (
            <p className="flex items-center gap-2 rounded-md border bg-surface p-3 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" className="size-4" />
              {outbound.phase === "error"
                ? (outbound.message ?? "The send status cannot be read.")
                : "Reading the send status."}
            </p>
          )}
          <Separator />
        </>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <Label htmlFor="draft-from">From</Label>
          <Select
            value={fields.identity}
            onValueChange={(address) => edit({ identity: address })}
            disabled={locked || (account?.identities.length ?? 0) < 2}
          >
            <SelectTrigger id="draft-from" className="w-full">
              <SelectValue>{identityLabel(draft, account)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(account?.identities ?? [{ address: draft.identity.address, name: draft.identity.name, isDefault: true }]).map(
                (identity) => (
                  <SelectItem key={identity.address} value={identity.address}>
                    {identity.name === null || identity.name.length === 0
                      ? identity.address
                      : `${identity.name} <${identity.address}>`}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <p
          role="status"
          className={cn(
            "flex items-center gap-1.5 pb-2 text-sm",
            autosaveState === "conflict" || autosaveState === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          data-testid="autosave-status"
        >
          {autosaveState === "saving" || autosaveState === "unsaved" ? (
            <Spinner aria-hidden="true" className="size-3.5" />
          ) : autosaveState === "offline" ? (
            <CloudOff aria-hidden="true" className="size-3.5" />
          ) : null}
          {autosaveState === "error" && saveError !== null ? saveError : autosaveStatusLabel(autosaveState)}
        </p>
        <div className="flex gap-2 pb-1.5">
          {autosaveState === "offline" || autosaveState === "error" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void autosaverRef.current?.retry()}
            >
              Try saving again
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={locked || autosaveState === "saved"}
              onClick={() => void autosaverRef.current?.flush()}
            >
              Save now
            </Button>
          )}
        </div>
      </div>

      {conflict !== null && (
        <section
          aria-label="Conflicting draft copies"
          className="flex flex-col gap-2 rounded-md border border-warning bg-warning-muted p-3 text-sm"
        >
          <p className="font-medium">
            The server holds revision {conflict.revision}; this window edits revision{" "}
            {autosaverRef.current?.revision ?? draft.revision}.
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <p className="font-medium">On the server</p>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-muted-foreground">
                {conflict.server === null
                  ? "(the server copy could not be read)"
                  : conflict.server.markdown || "(empty)"}
              </pre>
            </div>
            <div>
              <p className="font-medium">In this window</p>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-surface p-2 text-muted-foreground">
                {fields.markdown || "(empty)"}
              </pre>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={conflict.server === null}
              onClick={() => {
                autosaverRef.current?.acceptServerCopy(conflict.revision);
                if (conflict.server !== null) {
                  const adopted = fieldsOf(conflict.server);
                  fieldsRef.current = adopted;
                  setFields(adopted);
                  setDraft(conflict.server);
                }
              }}
            >
              Keep the server copy
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void autosaverRef.current?.keepLocalCopy(conflict.revision);
              }}
            >
              Keep my edits
            </Button>
          </div>
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="draft-to">To</Label>
          <Input
            id="draft-to"
            value={fields.to}
            onChange={(event) => edit({ to: event.target.value })}
            readOnly={locked}
            aria-invalid={invalidInFields.length > 0 || undefined}
            placeholder="name@example.com, other@example.com"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="draft-cc">Cc</Label>
          <Input
            id="draft-cc"
            value={fields.cc}
            onChange={(event) => edit({ cc: event.target.value })}
            readOnly={locked}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="draft-bcc">Bcc</Label>
          <Input
            id="draft-bcc"
            value={fields.bcc}
            onChange={(event) => edit({ bcc: event.target.value })}
            readOnly={locked}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="draft-subject">Subject</Label>
          <Input
            id="draft-subject"
            value={fields.subject}
            onChange={(event) => edit({ subject: event.target.value })}
            readOnly={locked}
          />
        </div>
      </div>

      {invalidInFields.length > 0 && (
        <p className="text-sm text-destructive">
          These addresses do not look valid: {invalidInFields.join(", ")}.
        </p>
      )}

      <section aria-label="Attachments" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => void onFilesChosen(event.target.files)}
            disabled={locked || fileBusy}
            aria-label="Attach files"
            id="draft-file-input"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={locked || fileBusy}
            onClick={() => fileInputRef.current?.click()}
          >
            {fileBusy ? (
              <Spinner aria-hidden="true" className="size-4" />
            ) : (
              <FileUp aria-hidden="true" className="size-4" />
            )}
            Attach files…
          </Button>
          {fileNote !== null && (
            <p role="status" className="min-w-0 flex-1 text-sm text-muted-foreground">
              {fileNote}
            </p>
          )}
        </div>
        {(attachments === null || attachments.length > 0 || pendingUploads.length > 0) && (
          <ul className="flex flex-col gap-1" data-testid="draft-attachments">
            {attachments?.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center gap-2 rounded-md border bg-surface px-2 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                <span className="text-muted-foreground">{formatBytes(attachment.sizeBytes)}</span>
                <Badge variant="success">Attached</Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={locked || fileBusy}
                  onClick={() => void removeAttachment(attachment.id)}
                  aria-label={`Remove ${attachment.filename}`}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </li>
            ))}
            {pendingUploads.map((upload) => (
              <li
                key={upload.localId}
                className="flex items-center gap-2 rounded-md border bg-surface px-2 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{upload.filename}</span>
                <span className="text-muted-foreground">{formatBytes(upload.sizeBytes)}</span>
                <Badge variant="outline">
                  <CloudOff aria-hidden="true" className="size-3" />
                  Waits to upload
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {waitingUploads.length > 0 && (
          <p className="text-sm text-muted-foreground">
            The send queues after {waitingUploads.length} file
            {waitingUploads.length === 1 ? "" : "s"} finish uploading.
          </p>
        )}
      </section>

      <div className="grid min-h-64 flex-1 gap-3 lg:grid-cols-2">
        <div className="flex min-h-48 flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label>Markdown source</Label>
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => setShowPreview((on) => !on)}
            >
              {showPreview ? (
                <>
                  <Pencil aria-hidden="true" className="size-4" />
                  Write
                </>
              ) : (
                <>
                  <Eye aria-hidden="true" className="size-4" />
                  Preview
                </>
              )}
            </Button>
          </div>
          <MarkdownEditor
            className="flex-1"
            value={fields.markdown}
            onChange={(markdown) => edit({ markdown })}
            readOnly={locked}
            label="Draft body in Markdown"
          />
        </div>
        <div className={cn("flex min-h-48 flex-col gap-1.5", !showPreview && "hidden lg:flex")}>
          <div className="flex items-center justify-between gap-2">
            <Label>Preview</Label>
            {preview.remoteImageCount > 0 && !allowRemoteImages && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAllowRemoteImages(true)}
              >
                Load images ({preview.remoteImageCount})
              </Button>
            )}
          </div>
          <SanitizedMessageFrame
            document={previewDocument}
            title="Markdown preview"
            className="min-h-48 flex-1 rounded-md border"
          />
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {draft.replyParentId !== null && "Reply context is frozen with this draft. "}
          Edited {formatListTime(draft.updatedAt)} · revision {autosaverRef.current?.revision ?? draft.revision}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={locked}
          onClick={() => void discard()}
          aria-label={discarding ? "Confirm discarding the draft" : "Discard the draft"}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          {discarding ? "Discard for good?" : "Discard"}
        </Button>
        <Button disabled={!canSend} onClick={() => void submitSend()}>
          Send
        </Button>
      </footer>

      {sendNote !== null && (
        <p role="status" className="text-sm text-muted-foreground" data-testid="send-note">
          {sendNote}
        </p>
      )}

      {uncertain !== null && (
        <section
          aria-label="Uncertain send request"
          className="flex flex-col gap-2 rounded-md border border-destructive bg-destructive-muted p-3 text-sm text-destructive-muted-foreground"
          data-testid="uncertain-send"
        >
          <p className="font-medium text-destructive">{uncertain}</p>
          <p>{DUPLICATE_SEND_WARNING}</p>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={duplicateAcknowledged}
              onCheckedChange={(checked) => setDuplicateAcknowledged(checked === true)}
            />
            I understand this may send a duplicate.
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void checkUncertain()}>
              Check the draft
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!duplicateAcknowledged}
              onClick={() => void submitSend()}
            >
              Send again with a new key
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

/** The identity as the From picker names it. */
function identityLabel(draft: DraftView, account: AccountSummary | null): string {
  const identity =
    account?.identities.find((entry) => entry.address === draft.identity.address) ??
    null;
  const name = identity?.name ?? draft.identity.name;
  return name === null || name.length === 0
    ? draft.identity.address
    : `${name} <${draft.identity.address}>`;
}

/** The invalid addresses across all three recipient fields. */
function invalidEntries(fields: DraftFields): string[] {
  return [
    ...invalidAddresses(parseRecipientList(fields.to)),
    ...invalidAddresses(parseRecipientList(fields.cc)),
    ...invalidAddresses(parseRecipientList(fields.bcc)),
  ];
}
