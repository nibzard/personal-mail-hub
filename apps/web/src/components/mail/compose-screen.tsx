import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, Plus } from "lucide-react";
import type { AccountSummary, ReplyMode } from "@mail-hub/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { toApiError } from "@/lib/api";
import { formatListTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  createNewDraft,
  createReplyDraft,
  parseRecipientList,
  invalidAddresses,
  useDrafts,
  type ComposeSession,
  type ReplyDraftRequest,
} from "@/mail/compose-data";
import { DraftEditor } from "./draft-editor";

/*
 * The compose surface (SPEC F6 and F7): a dialog over the shell that opens
 * on an intent — a new message, a reply, one draft from the list, or the
 * list itself. The list doubles as the outbox view: a draft a queued send
 * locks stays here with its send status one click away.
 */

/** What one open of the compose surface acts on. */
export type ComposeIntent =
  | { kind: "new"; accountId: string }
  | { kind: "reply"; messageId: string; accountId?: string; mode: ReplyMode }
  | { kind: "draft"; draftId: string }
  | { kind: "list" };

/**
 * A choice the reply derivation could not make on its own (SPEC F6). Each
 * step repeats the same request with one explicit field filled in.
 */
type ReplyChoiceStep =
  | { kind: "account"; request: ReplyDraftRequest }
  | { kind: "identity"; request: ReplyDraftRequest; identities: AccountSummary["identities"] }
  | { kind: "recipients"; request: ReplyDraftRequest };

export interface ComposeScreenProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountSummary[];
  /** The generation every mutation here carries (SPEC section 10). */
  recoveryGeneration: string | null;
  /** The intent the opener named; consumed once per open. */
  intent: ComposeIntent | null;
  onSessionLost: () => void;
}

export function ComposeScreen({
  open,
  onOpenChange,
  accounts,
  recoveryGeneration,
  intent,
  onSessionLost,
}: ComposeScreenProps) {
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [choice, setChoice] = useState<ReplyChoiceStep | null>(null);
  const [recipientText, setRecipientText] = useState("");
  const [recipientNote, setRecipientNote] = useState<string | null>(null);
  const [pickingAccount, setPickingAccount] = useState(false);
  const drafts = useDrafts(open);
  const reloadDrafts = drafts.reload;

  const session = useMemo<ComposeSession>(() => ({ recoveryGeneration }), [recoveryGeneration]);

  // Every navigation — an intent, a draft click, a close — takes this number.
  // An in-flight creation captures the value it started with and may move the
  // surface only while that value is still the newest: a draft the user
  // clicked meanwhile opens and stays open, instead of being overrun by the
  // creation's own result.
  const navigationRef = useRef(0);

  /** Runs one reply request, mapping each choice code to its step. */
  const runReply = useCallback(
    async (request: ReplyDraftRequest) => {
      const run = ++navigationRef.current;
      setChoice(null);
      setCreateError(null);
      setCreating(true);
      try {
        const draft = await createReplyDraft(session, request);
        setCreating(false);
        reloadDrafts();
        if (navigationRef.current === run) {
          setActiveDraftId(draft.id);
        }
      } catch (error) {
        setCreating(false);
        const failure = toApiError(error);
        if (failure.unauthorized) {
          onSessionLost();
          return;
        }
        if (navigationRef.current !== run) {
          // The user moved on while the request was out; a choice or an
          // error from the abandoned attempt must not hijack the new view.
          return;
        }
        if (failure.code === "account_choice_required") {
          setChoice({ kind: "account", request });
          return;
        }
        if (failure.code === "identity_choice_required") {
          if (request.accountId === undefined) {
            // No account was named, so the client cannot tell which one
            // holds the parent. Offering another account's identities would
            // list From addresses the server must reject; ask for the
            // account first, and the repeat that names it gets the true list.
            setChoice({ kind: "account", request });
            return;
          }
          const account = accounts.find((entry) => entry.id === request.accountId) ?? null;
          setChoice({
            kind: "identity",
            request,
            identities: account?.identities ?? [],
          });
          return;
        }
        if (failure.code === "recipients_required") {
          setChoice({ kind: "recipients", request });
          return;
        }
        setCreateError(failure.message);
      }
    },
    [session, accounts, reloadDrafts, onSessionLost],
  );

  /** Consumes the intent one open named. */
  const startIntent = useCallback(
    async (named: ComposeIntent) => {
      if (named.kind === "draft") {
        navigationRef.current += 1;
        setChoice(null);
        setCreateError(null);
        setActiveDraftId(named.draftId);
        return;
      }
      if (named.kind === "list") {
        navigationRef.current += 1;
        setChoice(null);
        setCreateError(null);
        setActiveDraftId(null);
        return;
      }
      setActiveDraftId(null);
      if (named.kind === "new") {
        const run = ++navigationRef.current;
        setChoice(null);
        setCreateError(null);
        setCreating(true);
        try {
          const draft = await createNewDraft(session, named.accountId);
          setCreating(false);
          reloadDrafts();
          if (navigationRef.current === run) {
            setActiveDraftId(draft.id);
          }
        } catch (error) {
          setCreating(false);
          const failure = toApiError(error);
          if (failure.unauthorized) {
            onSessionLost();
            return;
          }
          if (navigationRef.current === run) {
            setCreateError(failure.message);
          }
        }
        return;
      }
      await runReply({
        messageId: named.messageId,
        ...(named.accountId === undefined ? {} : { accountId: named.accountId }),
        mode: named.mode,
      });
    },
    [session, reloadDrafts, onSessionLost, runReply],
  );

  // Each intent object runs once; the shell issues a fresh one per command.
  const handledRef = useRef<ComposeIntent | null>(null);
  useEffect(() => {
    if (!open || intent === null || handledRef.current === intent) {
      return;
    }
    handledRef.current = intent;
    void startIntent(intent);
  }, [open, intent, startIntent]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        // A closed surface starts clean; the drafts themselves persist.
        navigationRef.current += 1;
        setActiveDraftId(null);
        setChoice(null);
        setCreateError(null);
        setRecipientText("");
        setRecipientNote(null);
        setPickingAccount(false);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  /** Starts one new draft, straight through when one account exists. */
  const startNew = useCallback(
    (accountId: string) => {
      setPickingAccount(false);
      void startIntent({ kind: "new", accountId });
    },
    [startIntent],
  );

  // The last answer stays through a refresh: a reload keeps the list on
  // screen (SPEC F12), so the data alone decides what renders.
  const draftsList = drafts.data ?? null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden sm:max-w-5xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{activeDraftId === null ? "Drafts" : "Compose"}</DialogTitle>
          <DialogDescription>
            Drafts save as you edit. A queued send locks its draft until its outcome is certain.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[15rem_1fr] md:overflow-hidden">
          <aside
            aria-label="Drafts"
            className="flex max-h-48 flex-col gap-2 md:max-h-none md:overflow-y-auto md:pe-1"
          >
            {accounts.length > 1 ? (
              pickingAccount ? (
                <div className="flex flex-col gap-1" aria-label="Choose an account">
                  {accounts.map((account) => (
                    <Button
                      key={account.id}
                      variant="outline"
                      size="sm"
                      className="justify-start"
                      onClick={() => startNew(account.id)}
                    >
                      {account.label}
                    </Button>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => setPickingAccount(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button size="sm" className="justify-start" onClick={() => setPickingAccount(true)}>
                  <Plus aria-hidden="true" className="size-4" />
                  New message
                </Button>
              )
            ) : (
              <Button
                size="sm"
                className="justify-start"
                disabled={accounts.length === 0}
                onClick={() => accounts[0] !== undefined && startNew(accounts[0].id)}
              >
                <Plus aria-hidden="true" className="size-4" />
                New message
              </Button>
            )}

            {drafts.phase === "loading" && draftsList === null && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner aria-hidden="true" className="size-4" />
                Loading drafts.
              </p>
            )}
            {drafts.phase === "error" && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p>{drafts.error?.message ?? "The drafts cannot be read."}</p>
                <Button variant="outline" size="sm" onClick={reloadDrafts}>
                  Try again
                </Button>
              </div>
            )}
            {draftsList !== null && (
              <ul className="relative flex flex-col gap-1" data-testid="draft-list">
                {/* A refresh keeps the rows on screen; its spinner overlays
                    them instead of replacing them (SPEC F12). */}
                {drafts.phase === "loading" && (
                  <Spinner
                    aria-hidden="true"
                    data-testid="drafts-refreshing"
                    className="absolute end-1 top-1 z-10 size-4 text-muted-foreground"
                  />
                )}
                {draftsList.length === 0 && (
                  <li className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">
                    No drafts.
                  </li>
                )}
                {draftsList.map((draft) => (
                  <li key={draft.id}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-start text-sm",
                        draft.id === activeDraftId
                          ? "border-accent bg-accent-muted"
                          : "bg-surface hover:bg-muted",
                      )}
                      onClick={() => {
                        navigationRef.current += 1;
                        setChoice(null);
                        setCreateError(null);
                        setActiveDraftId(draft.id);
                      }}
                      aria-current={draft.id === activeDraftId || undefined}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {draft.subject ?? "(no subject)"}
                        </span>
                        {draft.lockedBySend !== null && (
                          <span
                            className="flex items-center gap-1 text-xs text-muted-foreground"
                            title="A queued send locks this draft"
                          >
                            <Lock aria-hidden="true" className="size-3" />
                            Locked
                          </span>
                        )}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        To {draft.recipients.to.map((entry) => entry.address).join(", ") || "nobody"}
                        {" · "}
                        {/* One fixed box keeps the row width stable as the clock
                            ticks, so the masked visual baseline cannot flake on
                            digit-count changes. */}
                        <time
                          dateTime={draft.updatedAt}
                          className="inline-block w-14 text-right tabular-nums"
                        >
                          {formatListTime(draft.updatedAt)}
                        </time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <div className="flex min-h-0 flex-col md:overflow-y-auto md:pe-1">
            {choice !== null ? (
              <ReplyChoice
                step={choice}
                accounts={accounts}
                recipientText={recipientText}
                recipientNote={recipientNote}
                onRecipientText={setRecipientText}
                onPickAccount={(accountId) =>
                  void runReply({ ...choice.request, accountId })
                }
                onPickIdentity={(address) =>
                  void runReply({ ...choice.request, identity: { address } })
                }
                onRecipients={() => {
                  const to = parseRecipientList(recipientText);
                  const invalid = invalidAddresses(to);
                  if (to.length === 0) {
                    setRecipientNote("The reply needs at least one recipient.");
                    return;
                  }
                  if (invalid.length > 0) {
                    setRecipientNote(`These addresses do not look valid: ${invalid.join(", ")}.`);
                    return;
                  }
                  setRecipientNote(null);
                  void runReply({ ...choice.request, recipients: { to } });
                }}
                onCancel={() => setChoice(null)}
              />
            ) : activeDraftId !== null ? (
              <DraftEditor
                session={session}
                accounts={accounts}
                draftId={activeDraftId}
                onDraftChanged={reloadDrafts}
                onDraftDiscarded={() => {
                  setActiveDraftId(null);
                  reloadDrafts();
                }}
                onSessionLost={onSessionLost}
                onOpenDraft={setActiveDraftId}
              />
            ) : creating ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner aria-hidden="true" className="size-4" />
                Starting the draft.
              </p>
            ) : createError !== null ? (
              <div className="flex flex-col items-start gap-2 text-sm">
                <p className="text-destructive">{createError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreateError(null)}
                >
                  Back to the drafts list
                </Button>
              </div>
            ) : (
              <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
                <p>Select a draft, or start a new message.</p>
              </div>
            )}
          </div>
        </div>

        <Separator className="mt-3 shrink-0 md:hidden" />
      </DialogContent>
    </Dialog>
  );
}

/** One derivation choice, phrased as the step the choice completes. */
function ReplyChoice({
  step,
  accounts,
  recipientText,
  recipientNote,
  onRecipientText,
  onPickAccount,
  onPickIdentity,
  onRecipients,
  onCancel,
}: {
  step: ReplyChoiceStep;
  accounts: AccountSummary[];
  recipientText: string;
  recipientNote: string | null;
  onRecipientText(text: string): void;
  onPickAccount(accountId: string): void;
  onPickIdentity(address: string): void;
  onRecipients(): void;
  onCancel(): void;
}) {
  return (
    <section
      aria-label="Complete the reply"
      className="flex flex-col gap-3 rounded-md border bg-surface p-3 text-sm"
    >
      {step.kind === "account" && (
        <>
          <p className="font-medium">Which account holds the message you reply to?</p>
          <div className="flex flex-col gap-1">
            {accounts.map((account) => (
              <Button
                key={account.id}
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => onPickAccount(account.id)}
              >
                {account.label}
              </Button>
            ))}
          </div>
        </>
      )}

      {step.kind === "identity" && (
        <>
          <p className="font-medium">Which identity sends this reply?</p>
          {step.identities.length === 0 ? (
            <p className="text-muted-foreground">
              The account lists no identity to choose from.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {step.identities.map((identity) => (
                <Button
                  key={identity.address}
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  onClick={() => onPickIdentity(identity.address)}
                >
                  {identity.name === null || identity.name.length === 0
                    ? identity.address
                    : `${identity.name} <${identity.address}>`}
                </Button>
              ))}
            </div>
          )}
        </>
      )}

      {step.kind === "recipients" && (
        <>
          <p className="font-medium">
            The reply has no recipient the server accepts. Name the recipients.
          </p>
          <div className="flex max-w-md flex-col gap-1.5">
            <Label htmlFor="reply-recipients">To</Label>
            <Input
              id="reply-recipients"
              value={recipientText}
              onChange={(event) => onRecipientText(event.target.value)}
              placeholder="name@example.com, other@example.com"
            />
          </div>
          {recipientNote !== null && <p className="text-destructive">{recipientNote}</p>}
          <div>
            <Button size="sm" onClick={onRecipients}>
              Continue
            </Button>
          </div>
        </>
      )}

      <div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
