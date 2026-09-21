import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type {
  AccountResponse,
  AccountSummary,
  FolderSummary,
  FolderRole,
  HealthzAccount,
  HealthzSyncLag,
} from "@mail-hub/contracts";
import { apiDelete, apiPatch, apiPut, toApiError, type ApiError } from "@/lib/api";
import { formatAge, formatCount } from "@/lib/format";
import { orderFolders } from "@/mail/view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

/*
 * Per-account settings (SPEC F1 and F8): folder role destinations, send
 * identities, the classification toggle, and this account's share of the
 * synchronization status. Every mutation passes the recovery gate, and a
 * failure stays visible next to the control that caused it (SPEC F12).
 */

/** One editable send identity. */
interface IdentityDraft {
  address: string;
  name: string;
  isDefault: boolean;
}

const FOLDER_ROLES: FolderRole[] = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  "trash",
  "junk",
];

/** The roles folder-bound actions need before they run (SPEC section 8). */
const REQUIRED_ROLES: FolderRole[] = ["inbox", "sent", "archive"];

export function AccountSettingsCard({
  account,
  folders,
  sync,
  recoveryGeneration,
  onAccountsChanged,
  onFoldersChanged,
  onSessionLost,
}: {
  account: AccountSummary;
  /** `null` while the folder index loads; `undefined` when the read failed. */
  folders: FolderSummary[] | null | undefined;
  sync: HealthzAccount | null;
  recoveryGeneration: string | null;
  onAccountsChanged: () => void;
  onFoldersChanged: () => void;
  /** Re-probes the session after it ended, opening sign-in when needed. */
  onSessionLost: () => void;
}) {
  const generationHeaders =
    recoveryGeneration === null
      ? undefined
      : { "x-recovery-generation": recoveryGeneration };

  // One busy marker and one message per card, so each failure stays next to
  // the account that caused it.
  const [busy, setBusy] = useState<"classify" | "role" | "identities" | null>(
    null,
  );
  const [error, setError] = useState<ApiError | null>(null);

  const [identities, setIdentities] = useState<IdentityDraft[]>(() =>
    account.identities.map((identity) => ({
      address: identity.address,
      name: identity.name ?? "",
      isDefault: identity.isDefault,
    })),
  );
  // A refetch replaces the identities array; adopt it only when the stored
  // set really changed, so unsaved edits survive unrelated refreshes.
  const identitySignature = JSON.stringify(account.identities);
  const adoptedSignature = useRef(identitySignature);
  if (adoptedSignature.current !== identitySignature) {
    adoptedSignature.current = identitySignature;
    setIdentities(
      account.identities.map((identity) => ({
        address: identity.address,
        name: identity.name ?? "",
        isDefault: identity.isDefault,
      })),
    );
  }

  const run = async (
    marker: "classify" | "role" | "identities",
    action: () => Promise<void>,
  ) => {
    setBusy(marker);
    setError(null);
    try {
      await action();
    } catch (cause: unknown) {
      setError(toApiError(cause));
    } finally {
      setBusy(null);
    }
  };

  const setClassify = (on: boolean) =>
    void run("classify", async () => {
      await apiPatch<AccountResponse>(
        `/accounts/${account.id}`,
        { classifyEnabled: on },
        { headers: generationHeaders },
      );
      onAccountsChanged();
    });

  const setFolderRole = (folder: FolderSummary, role: string) =>
    void run("role", async () => {
      if (role === "none") {
        await apiDelete<FolderSummary>(
          `/accounts/${account.id}/folders/${folder.id}/role`,
          {
            headers: generationHeaders,
          },
        );
      } else {
        await apiPut<FolderSummary>(
          `/accounts/${account.id}/folders/${folder.id}/role`,
          { role: role as FolderRole },
          { headers: generationHeaders },
        );
      }
      // The reload also snaps the Select back to the stored role when the
      // change failed.
      onFoldersChanged();
    });

  const saveIdentities = () =>
    void run("identities", async () => {
      await apiPut<AccountResponse>(
        `/accounts/${account.id}/identities`,
        {
          identities: identities.map((identity) => ({
            address: identity.address.trim(),
            name:
              identity.name.trim().length === 0 ? null : identity.name.trim(),
            isDefault: identity.isDefault,
          })),
        },
        { headers: generationHeaders },
      );
      onAccountsChanged();
    });

  const missingRoles = REQUIRED_ROLES.filter(
    (role) => !(folders ?? []).some((folder) => folder.role === role),
  );

  return (
    <li className="rounded-lg border bg-surface p-3">
      <section aria-label={account.label} className="flex flex-col">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full ring-1 ring-border"
            style={{ backgroundColor: account.color }}
          />
          <p className="min-w-0 flex-1 truncate font-medium">{account.label}</p>
          <div className="flex items-center gap-2">
            <Switch
              checked={account.classifyEnabled}
              disabled={busy === "classify"}
              onCheckedChange={setClassify}
              aria-label={`Classify messages of ${account.label}`}
            />
            {busy === "classify" && (
              <Spinner aria-hidden="true" className="size-3.5" />
            )}
          </div>
        </div>
        <p className="truncate text-muted-foreground">{account.username}</p>

        {error !== null && (
          <div
            role="alert"
            className="mt-2 flex flex-wrap items-center gap-2 rounded bg-destructive-muted px-2 py-1.5 text-destructive-muted-foreground"
          >
            {/* An ended session recovers through sign-in, the same path the
                list and reader offer (SPEC F9). */}
            <span className="min-w-0 flex-1">
              {error.unauthorized ? "Your session ended." : error.message}
            </span>
            {error.unauthorized && (
              <Button size="sm" onClick={onSessionLost}>
                Sign in again
              </Button>
            )}
          </div>
        )}

        <AccountSyncLines sync={sync} />

        <Separator className="my-3" />

        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-sm font-medium">Folder destinations</h4>
          </div>
          {folders === null ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner aria-hidden="true" className="size-3.5" />
              Loading folders.
            </p>
          ) : folders === undefined ? (
            <p className="text-muted-foreground">
              The folder list cannot be loaded.
            </p>
          ) : (
            <>
              {missingRoles.length > 0 && (
                <p className="text-muted-foreground">
                  Choose a destination for {missingRoles.join(", ")}.
                  Folder-bound actions wait until every required role has one.
                </p>
              )}
              <ul className="mt-1 flex flex-col gap-1.5">
                {orderFolders(folders).map((folder) => (
                  <li key={folder.id} className="flex items-center gap-2">
                    <Label
                      htmlFor={`role-${account.id}-${folder.id}`}
                      className="min-w-0 flex-1 truncate text-interface font-normal"
                    >
                      {folder.name}
                    </Label>
                    <Select
                      value={folder.role ?? "none"}
                      onValueChange={(role) => setFolderRole(folder, role)}
                      disabled={busy === "role"}
                    >
                      <SelectTrigger
                        id={`role-${account.id}-${folder.id}`}
                        className="h-control-md w-36 shrink-0"
                        aria-label={`Role of ${folder.name}`}
                      >
                        {/* The label is explicit, because Radix only mirrors the
                          item text after its list has mounted once. */}
                        <SelectValue>{folder.role ?? "No role"}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No role</SelectItem>
                        {FOLDER_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <Separator className="my-3" />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Send identities</legend>
          <p className="text-muted-foreground">
            Address pairs this account can send from. Mark exactly one as the
            default.
          </p>
          {identities.length === 0 ? (
            <p className="text-muted-foreground">No identities yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {identities.map((identity, index) => (
                <li key={index} className="flex flex-wrap items-center gap-2">
                  <Input
                    value={identity.address}
                    aria-label={`Address of identity ${index + 1}`}
                    autoComplete="off"
                    className="h-control-md min-w-40 flex-1"
                    onChange={(event) =>
                      setIdentities((current) =>
                        current.map((entry, position) =>
                          position === index
                            ? { ...entry, address: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <Input
                    value={identity.name}
                    aria-label={`Display name of identity ${index + 1}`}
                    autoComplete="off"
                    placeholder="Name"
                    className="h-control-md w-36"
                    onChange={(event) =>
                      setIdentities((current) =>
                        current.map((entry, position) =>
                          position === index
                            ? { ...entry, name: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name={`default-identity-${account.id}`}
                      checked={identity.isDefault}
                      onChange={() =>
                        setIdentities((current) =>
                          current.map((entry, position) => ({
                            ...entry,
                            isDefault: position === index,
                          })),
                        )
                      }
                      aria-label={`Make identity ${index + 1} the default`}
                      className="size-4 accent-accent"
                    />
                    Default
                  </label>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove identity ${index + 1}`}
                    disabled={busy === "identities"}
                    onClick={() =>
                      setIdentities((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy === "identities" || identities.length >= 64}
              onClick={() =>
                setIdentities((current) => [
                  ...current,
                  { address: "", name: "", isDefault: current.length === 0 },
                ])
              }
            >
              <Plus aria-hidden="true" className="size-3.5" />
              Add identity
            </Button>
            <Button
              size="sm"
              disabled={busy === "identities"}
              onClick={saveIdentities}
            >
              {busy === "identities" && (
                <Spinner aria-hidden="true" className="size-3.5" />
              )}
              Save identities
            </Button>
          </div>
        </fieldset>
      </section>
    </li>
  );
}

/** This account's share of the synchronization status (SPEC section 11). */
function AccountSyncLines({ sync }: { sync: HealthzAccount | null }) {
  if (sync === null) {
    return (
      <p className="mt-2 text-muted-foreground">
        Sync status is unavailable for this account.
      </p>
    );
  }
  const parts = [
    syncStateLine(sync.sync),
    sync.sync.lastCycleAt === null
      ? null
      : `Last cycle ${formatAge(sync.sync.cycleAgeSeconds)} ago`,
    `${formatCount(sync.sync.pendingBodies)} bodies pending`,
    sync.sync.backfillPendingFolders === null
      ? "Backfill progress unknown"
      : sync.sync.backfillPendingFolders === 0
        ? "Backfill complete"
        : `${formatCount(sync.sync.backfillPendingFolders)} folders still backfilling`,
  ].filter((part) => part !== null);
  return (
    <p className="mt-1.5 text-muted-foreground">
      {parts.join(" · ")}
      {" · "}
      {formatCount(sync.metrics.messagesSynced)} messages kept,{" "}
      {formatCount(sync.metrics.bodiesFetched)} bodies fetched
    </p>
  );
}

/**
 * One line for the derived sync state. Pending work is normal progress; a
 * degraded cycle names what failed and the approved failure codes, never
 * folder names or mail text.
 */
function syncStateLine(sync: HealthzSyncLag): string {
  switch (sync.state) {
    case "degraded": {
      const failed = [
        sync.folderErrors ? `${formatCount(sync.folderErrors)} folders` : null,
        sync.bodyErrors ? `${formatCount(sync.bodyErrors)} bodies` : null,
        sync.threadErrors ? `${formatCount(sync.threadErrors)} threads` : null,
      ].filter((part) => part !== null);
      const kinds = [
        ...(sync.folderFailureKinds ?? []),
        ...(sync.bodyFailureKinds ?? []),
        ...(sync.threadFailureKinds ?? []),
      ];
      const kindsText = kinds.length > 0 ? ` (${kinds.join(", ")})` : "";
      return failed.length > 0
        ? `Sync failed for ${failed.join(", ")}${kindsText}`
        : `Sync reported failures${kindsText}`;
    }
    case "stale":
      return "No sync cycle recently";
    case "syncing":
      return "Sync in progress";
    case "ok":
      return "Sync up to date";
    default:
      return sync.lastCycleAt === null ? "No sync cycle yet" : "Sync state unknown";
  }
}
