import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { useState } from "react";
import type { AuthStatusResponse } from "@mail-hub/contracts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { apiPost, ApiError } from "@/lib/api";

/*
 * The passkey sign-in screen (SPEC sections 9 and 10). It stays available
 * while mail work is blocked, and it names the operator commands instead of
 * hiding the bootstrap path. Enrollment grants stay in the operator console.
 */

export interface SignInScreenProps {
  status: AuthStatusResponse | null;
  /** True when the status read itself failed. */
  statusFailed: boolean;
  onRetryStatus: () => void;
  onSignedIn: () => void;
}

export function SignInScreen({
  status,
  statusFailed,
  onRetryStatus,
  onSignedIn,
}: SignInScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const start = await apiPost<{ options: object }>("/auth/login/start");
      const assertion = await startAuthentication({
        optionsJSON: start.options as PublicKeyCredentialRequestOptionsJSON,
      });
      await apiPost("/auth/login/complete", { response: assertion });
      onSignedIn();
    } catch (failure) {
      if (failure instanceof ApiError) {
        setError(failure.message);
      } else if (failure instanceof DOMException && failure.name === "NotAllowedError") {
        setError("The passkey check was cancelled or timed out. Try again.");
      } else {
        setError("Sign-in did not complete. Try again.");
      }
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background px-4 text-foreground [padding-bottom:env(safe-area-inset-bottom)]">
      <div className="w-full max-w-sm rounded-lg border bg-surface p-6 shadow-xs">
        <h1 className="text-reading font-semibold">Personal mail hub</h1>
        <p className="mt-1 text-muted-foreground">One owner account protects this hub.</p>

        <div className="mt-5">
          {statusFailed ? (
            <>
              <p className="font-medium">The mail service cannot be reached.</p>
              <Button variant="outline" className="mt-3 w-full" onClick={onRetryStatus}>
                Try again
              </Button>
            </>
          ) : status === null ? null : !status.ownerRegistered ? (
            <>
              <p className="font-medium">No owner is registered yet.</p>
              <p className="mt-1 text-muted-foreground">
                On the server, print the one-time enrollment token, set{" "}
                <span className="font-medium">BASE_URL</span> to this origin first:
              </p>
              <p className="mt-2">
                <Kbd className="max-w-full break-all">npm run admin -- auth bootstrap</Kbd>
              </p>
              <Button variant="outline" className="mt-3 w-full" onClick={onRetryStatus}>
                Refresh status
              </Button>
            </>
          ) : status.login !== "available" ? (
            <>
              <p className="font-medium">Sign-in is unavailable right now.</p>
              <p className="mt-1 text-muted-foreground">
                Recovery control state: {status.control}. Use the operator recovery commands
                on the server.
              </p>
              <Button variant="outline" className="mt-3 w-full" onClick={onRetryStatus}>
                Check again
              </Button>
            </>
          ) : (
            <>
              <Button className="w-full" onClick={() => void signIn()} pending={busy}>
                Sign in with a passkey
              </Button>
              {error !== null && (
                <p role="alert" className="mt-3 text-destructive">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
