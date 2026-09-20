import { useState } from "react";
import type {
  AccountResponse,
  ConnectionTestResponse,
  FolderImportResponse,
} from "@mail-hub/contracts";
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
import { apiPost, ApiError, toApiError } from "@/lib/api";

/*
 * First-run mailbox enrollment (SPEC F1): the save flow is create, test both
 * protocols, then import the folders the IMAP test discovered. The test runs
 * against the stored settings, so a wrong host or password fails visibly
 * before any sync work is queued.
 */

const DEFAULT_COLOR = "#2563eb";

export function AddAccountCard({
  recoveryGeneration,
  onAccountsChanged,
  onFoldersChanged,
}: {
  recoveryGeneration: string | null;
  onAccountsChanged: () => void;
  onFoldersChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [senderName, setSenderName] = useState("");
  const [imapHost, setImapHost] = useState("imap.purelymail.com");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("smtp.purelymail.com");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpSecurity, setSmtpSecurity] = useState<"starttls_required" | "implicit_tls">(
    "starttls_required",
  );
  const [busy, setBusy] = useState<"saving" | "testing" | "importing" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const generationHeaders =
    recoveryGeneration === null ? undefined : { "x-recovery-generation": recoveryGeneration };

  function reset(): void {
    setLabel("");
    setUsername("");
    setPassword("");
    setSenderName("");
    setNote(null);
    setError(null);
  }

  async function addAccount(): Promise<void> {
    const address = username.trim();
    if (address.length === 0 || password.length === 0) {
      setError(new ApiError(400, "invalid_request", "Address and password are required."));
      return;
    }
    setBusy("saving");
    setError(null);
    setNote(null);
    try {
      const created = await apiPost<AccountResponse>(
        "/accounts",
        {
          label: label.trim().length > 0 ? label.trim() : address,
          color: DEFAULT_COLOR,
          username: address,
          password,
          imapHost: imapHost.trim(),
          imapPort: Number(imapPort),
          smtpHost: smtpHost.trim(),
          smtpPort: Number(smtpPort),
          smtpSecurity,
          identities: [
            {
              address,
              name: senderName.trim().length > 0 ? senderName.trim() : null,
              isDefault: true,
            },
          ],
        },
        { headers: generationHeaders },
      );

      // The connection test reads the stored settings, so it also verifies
      // what was just saved rather than the form state.
      setBusy("testing");
      const test = await apiPost<ConnectionTestResponse>(
        `/accounts/${created.account.id}/connection-test`,
        undefined,
        { headers: generationHeaders },
      );

      let imported = 0;
      if (test.imap.ok && test.imap.folders.length > 0) {
        setBusy("importing");
        const result = await apiPost<FolderImportResponse>(
          `/accounts/${created.account.id}/folders/import`,
          {
            folders: test.imap.folders.map((folder) => ({
              name: folder.name,
              specialUse: folder.specialUse,
            })),
          },
          { headers: generationHeaders },
        );
        imported = result.folders.length;
        onFoldersChanged();
      }
      onAccountsChanged();

      const halves = [
        test.imap.ok
          ? imported > 0
            ? `IMAP ok (${imported} folders imported)`
            : "IMAP ok (no folders reported)"
          : `IMAP failed: ${test.imap.error?.message ?? test.imap.stage}`,
        test.smtp.ok ? "SMTP ok" : `SMTP failed: ${test.smtp.error?.message ?? test.smtp.stage}`,
      ];
      reset();
      setNote(`Mailbox added. ${halves.join("; ")}.`);
      setOpen(false);
    } catch (cause: unknown) {
      setError(toApiError(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-3">
        {note !== null && <p role="status" className="text-sm">{note}</p>}
        <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
          Add mailbox
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-surface p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="account-address">Email address</Label>
        <Input
          id="account-address"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="you@example.com"
          disabled={busy !== null}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="account-password">Mailbox password</Label>
        <Input
          id="account-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy !== null}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-label">Label</Label>
          <Input
            id="account-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={addressLabel(username)}
            disabled={busy !== null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-name">Send-as name</Label>
          <Input
            id="account-name"
            value={senderName}
            onChange={(event) => setSenderName(event.target.value)}
            placeholder="Optional"
            disabled={busy !== null}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-imap-host">IMAP server</Label>
          <Input
            id="account-imap-host"
            value={imapHost}
            onChange={(event) => setImapHost(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy !== null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-imap-port">IMAP port</Label>
          <Input
            id="account-imap-port"
            inputMode="numeric"
            value={imapPort}
            onChange={(event) => setImapPort(event.target.value)}
            disabled={busy !== null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-smtp-host">SMTP server</Label>
          <Input
            id="account-smtp-host"
            value={smtpHost}
            onChange={(event) => setSmtpHost(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy !== null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-smtp-port">SMTP port</Label>
          <Input
            id="account-smtp-port"
            inputMode="numeric"
            value={smtpPort}
            onChange={(event) => setSmtpPort(event.target.value)}
            disabled={busy !== null}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="account-smtp-security">SMTP security</Label>
          <Select
            value={smtpSecurity}
            onValueChange={(value) => {
              const next = value as "starttls_required" | "implicit_tls";
              setSmtpSecurity(next);
              setSmtpPort(next === "implicit_tls" ? "465" : "587");
            }}
          >
            <SelectTrigger id="account-smtp-security" className="w-full" disabled={busy !== null}>
              <SelectValue>
                {smtpSecurity === "starttls_required" ? "STARTTLS (587)" : "Implicit TLS (465)"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="starttls_required">STARTTLS (587)</SelectItem>
              <SelectItem value="implicit_tls">Implicit TLS (465)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={() => void addAccount()} pending={busy !== null}>
          {busy === "saving" && "Saving…"}
          {busy === "testing" && "Testing the connection…"}
          {busy === "importing" && "Importing folders…"}
          {busy === null && "Add mailbox"}
        </Button>
        {busy === null && (
          <Button
            variant="outline"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        )}
        {error !== null && (
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        )}
      </div>
    </div>
  );
}

/** The placeholder label for an address, matching the API's own fallback. */
function addressLabel(username: string): string {
  const local = username.split("@")[0] ?? "";
  return local.length > 0 ? local : "you@example.com";
}
