import { RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import type { AccountSummary, FolderSummary } from "@mail-hub/contracts";
import { useAppSettings } from "@/settings/settings-context";
import { useSyncStatus } from "@/settings/data";
import { formatAge, formatCount, formatFullTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { AccountSettingsCard } from "./account-settings";

/*
 * The settings screen (SPEC F10): density, shortcuts, the clean-view default,
 * classification guardrails, account folders and identities, and the visible
 * per-account synchronization and queue status. Preference changes save as
 * they are made; one stable footer line states where each save stands
 * (SPEC F12).
 */

/** The theme choices as the select shows them. */
const THEME_LABELS = {
  system: "Follow the system",
  light: "Light",
  dark: "Dark",
} as const;

/** The density choices as the select shows them. */
const DENSITY_LABELS = { compact: "Compact", comfortable: "Comfortable" } as const;

export function SettingsScreen({
  open,
  onOpenChange,
  accounts,
  folders,
  recoveryGeneration,
  onAccountsChanged,
  onFoldersChanged,
  onSessionLost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountSummary[];
  /** The folder index of the shell, keyed by account id. */
  folders: Map<string, FolderSummary[]> | null;
  recoveryGeneration: string | null;
  onAccountsChanged: () => void;
  onFoldersChanged: () => void;
  /** Re-probes the session after it ended, opening sign-in when needed. */
  onSessionLost: () => void;
}) {
  const settings = useAppSettings();
  const sync = useSyncStatus(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] gap-4 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Preferences save as you change them and follow your account to every device.
          </DialogDescription>
        </DialogHeader>

        {settings.phase === "loading" ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner aria-hidden="true" className="size-4" />
            Loading settings.
          </p>
        ) : settings.phase === "error" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1">
              {settings.error?.unauthorized === true
                ? "Your session ended."
                : (settings.error?.message ?? "Settings cannot be loaded.")}
            </p>
            {settings.error?.unauthorized === true ? (
              <Button size="sm" onClick={onSessionLost}>
                Sign in again
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={settings.reload}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <>
            <section aria-label="Appearance" className="flex flex-col gap-3">
              <h3 className="font-medium">Appearance</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="settings-theme">Theme</Label>
                  <Select
                    value={settings.settings.theme}
                    onValueChange={(theme) => settings.update({ theme: theme as "system" | "light" | "dark" })}
                  >
                    <SelectTrigger id="settings-theme" className="w-full">
                      {/* The label is explicit, because Radix only mirrors the
                          item text after its list has mounted once. */}
                      <SelectValue>{THEME_LABELS[settings.settings.theme]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">{THEME_LABELS.system}</SelectItem>
                      <SelectItem value="light">{THEME_LABELS.light}</SelectItem>
                      <SelectItem value="dark">{THEME_LABELS.dark}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="settings-density">Reading density</Label>
                  <Select
                    value={settings.settings.density}
                    onValueChange={(density) =>
                      settings.update({ density: density as "compact" | "comfortable" })
                    }
                  >
                    <SelectTrigger id="settings-density" className="w-full">
                      <SelectValue>{DENSITY_LABELS[settings.settings.density]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="compact">{DENSITY_LABELS.compact}</SelectItem>
                      <SelectItem value="comfortable">{DENSITY_LABELS.comfortable}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-muted-foreground">
                    Compact is the default. Comfortable adds room between rows.
                  </p>
                </div>
              </div>
            </section>

            <Separator />

            <section aria-label="Keyboard and reading" className="flex flex-col gap-3">
              <h3 className="font-medium">Keyboard and reading</h3>
              <div className="flex items-center justify-between gap-3">
                <span>
                  Single-key shortcuts
                  <span className="block text-muted-foreground">
                    j and k move, o opens. They stay inactive inside inputs and dialogs.
                  </span>
                </span>
                <Switch
                  checked={settings.settings.singleKeyShortcuts}
                  onCheckedChange={(on) => settings.update({ singleKeyShortcuts: on })}
                  aria-label="Single-key shortcuts"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>
                  Clean view by default
                  <span className="block text-muted-foreground">
                    Open every message with the extracted reading view first.
                  </span>
                </span>
                <Switch
                  checked={settings.settings.cleanViewDefault}
                  onCheckedChange={(on) => settings.update({ cleanViewDefault: on })}
                  aria-label="Clean view by default"
                />
              </div>
            </section>

            <Separator />

            <ClassificationSection />
            <Separator />

            <section aria-label="Accounts" className="flex flex-col gap-3">
              <h3 className="font-medium">Accounts</h3>
              {accounts.length === 0 ? (
                <p className="text-muted-foreground">No accounts are configured yet.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {accounts.map((account) => (
                    <AccountSettingsCard
                      key={account.id}
                      account={account}
                      folders={folders === null ? null : (folders.get(account.id) ?? undefined)}
                      sync={
                        sync.report?.accounts.find((entry) => entry.accountId === account.id) ??
                        null
                      }
                      recoveryGeneration={recoveryGeneration}
                      onAccountsChanged={onAccountsChanged}
                      onFoldersChanged={onFoldersChanged}
                      onSessionLost={onSessionLost}
                    />
                  ))}
                </ul>
              )}
            </section>

            <Separator />

            <SyncQueueSection sync={sync} />
          </>
        )}

        <SaveStateFooter onSessionLost={onSessionLost} />
      </DialogContent>
    </Dialog>
  );
}

/** Classification guardrails (SPEC F8): enablement, cost cap, backfill. */
function ClassificationSection() {
  const settings = useAppSettings();
  const { classificationEnabled, classificationMonthlyCostCapUsd, backfillClassification } =
    settings.settings;
  const [capText, setCapText] = useState<string>(
    classificationMonthlyCostCapUsd === null ? "" : String(classificationMonthlyCostCapUsd),
  );
  // A saved change replaces the field text, so the field never drifts from
  // the stored value while it is not being edited.
  const adoptedCap = useRef(classificationMonthlyCostCapUsd);
  if (adoptedCap.current !== classificationMonthlyCostCapUsd) {
    adoptedCap.current = classificationMonthlyCostCapUsd;
    setCapText(
      classificationMonthlyCostCapUsd === null ? "" : String(classificationMonthlyCostCapUsd),
    );
  }

  const commitCap = () => {
    const trimmed = capText.trim();
    const parsed = trimmed.length === 0 ? null : Number(trimmed);
    if (parsed !== null && !Number.isFinite(parsed)) {
      return;
    }
    const rounded = parsed === null ? null : Math.round(parsed * 100) / 100;
    if (rounded !== classificationMonthlyCostCapUsd) {
      settings.update({ classificationMonthlyCostCapUsd: rounded });
    }
  };

  return (
    <section aria-label="Classification" className="flex flex-col gap-3">
      <h3 className="font-medium">Classification</h3>
      <div className="flex items-center justify-between gap-3">
        <span>
          Classify messages
          <span className="block text-muted-foreground">
            Jev answers bounded questions in shadow mode: hints appear as suggestions and route
            nothing. Message content never leaves the server.
          </span>
        </span>
        <Switch
          checked={classificationEnabled}
          onCheckedChange={(on) => settings.update({ classificationEnabled: on })}
          aria-label="Classify messages"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-cost-cap">Monthly cost cap, US dollars</Label>
        <Input
          id="settings-cost-cap"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          placeholder="No limit"
          value={capText}
          disabled={!classificationEnabled}
          aria-label="Monthly classification cost cap in US dollars"
          className="max-w-48"
          onChange={(event) => setCapText(event.target.value)}
          onBlur={commitCap}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        <p className="text-muted-foreground">
          Classification pauses when the month crosses this ceiling. Leave it empty for no limit.
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>
          Backfill classification
          <span className="block text-muted-foreground">
            Also classify the mail that arrived before classification was enabled.
          </span>
        </span>
        <Switch
          checked={backfillClassification}
          disabled={!classificationEnabled}
          onCheckedChange={(on) => settings.update({ backfillClassification: on })}
          aria-label="Backfill classification"
        />
      </div>
    </section>
  );
}

/** The queue and outbound counters, plus the refresh control (SPEC F11 area). */
function SyncQueueSection({ sync }: { sync: ReturnType<typeof useSyncStatus> }) {
  const circuitNote =
    sync.report?.classification.circuit === "open"
      ? "Classification is paused: repeated errors opened the circuit breaker."
      : sync.report?.classification.description ?? null;

  return (
    <section aria-label="Synchronization and queues" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Synchronization and queues</h3>
        <Button variant="outline" size="sm" disabled={sync.phase === "loading"} onClick={sync.reload}>
          {sync.phase === "loading" ? (
            <Spinner aria-hidden="true" className="size-3.5" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>
      {sync.phase === "error" ? (
        <p role="alert" className="rounded bg-destructive-muted px-2 py-1.5 text-destructive-muted-foreground">
          {sync.error?.message ?? "The synchronization status cannot be loaded."}
        </p>
      ) : sync.report === null ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner aria-hidden="true" className="size-4" />
          Reading the synchronization status.
        </p>
      ) : (
        <div className="flex flex-col gap-1 text-muted-foreground">
          <p>
            <span className="text-foreground">Queue:</span>{" "}
            {sync.report.queue.depth === null
              ? "depth unreadable"
              : `${formatCount(sync.report.queue.depth)} jobs waiting`}
            {sync.report.queue.oldestJobAgeSeconds !== null &&
              ` · oldest ${formatAge(sync.report.queue.oldestJobAgeSeconds)} old`}
          </p>
          {sync.report.queue.oldestPendingWorkAgeSeconds !== null && (
            <p>
              <span className="text-foreground">Oldest queued send:</span>{" "}
              {formatAge(sync.report.queue.oldestPendingWorkAgeSeconds)} old
            </p>
          )}
          <p>
            <span className="text-foreground">Outbound:</span>{" "}
            {formatCount(sync.report.sends.queued)} queued ·{" "}
            {formatCount(sync.report.sends.failed)} failed ·{" "}
            {formatCount(sync.report.sends.outcomeUnknown)} outcome unknown
          </p>
          {circuitNote !== null && <p>{circuitNote}</p>}
          <p>Checked {formatFullTime(sync.report.checkedAt)}.</p>
        </div>
      )}
    </section>
  );
}

/** One stable line for where each preference save stands (SPEC F12). */
function SaveStateFooter({ onSessionLost }: { onSessionLost: () => void }) {
  const settings = useAppSettings();
  // An ended session has the same recovery path the list and reader offer:
  // signing back in, not another request that cannot succeed (SPEC F9).
  const sessionEnded =
    settings.savePhase === "error" && settings.saveError?.unauthorized === true;
  return (
    <footer
      role="status"
      aria-live="polite"
      className="flex min-h-9 flex-wrap items-center gap-2 border-t pt-3 text-muted-foreground"
    >
      {settings.savePhase === "saving" && (
        <>
          <Spinner aria-hidden="true" className="size-3.5" />
          Saving…
        </>
      )}
      {settings.savePhase === "saved" && "Saved."}
      {settings.savePhase === "error" && (
        <>
          <span className="min-w-0 flex-1 text-destructive-muted-foreground">
            Could not save:{" "}
            {sessionEnded
              ? "your session ended."
              : (settings.saveError?.message ?? "the mail service cannot be reached.")}
          </span>
          {sessionEnded ? (
            <Button size="sm" onClick={onSessionLost}>
              Sign in again
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={settings.retry}>
              Try again
            </Button>
          )}
        </>
      )}
    </footer>
  );
}
