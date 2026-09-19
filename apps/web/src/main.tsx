import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/mail/app-shell";
import { SignInScreen } from "@/components/mail/sign-in";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OfflineSyncProvider } from "@/offline/sync-context.tsx";
import { SettingsProvider } from "@/settings/settings-context";
import { useAuthStatus, useSession } from "@/mail/data";
import "./styles.css";

/*
 * Entry point. One probe decides between the mail shell and the sign-in
 * screen: the account list reads only with a live session (SPEC section 9).
 * A live session also carries the settings record, so appearance choices
 * follow the account onto this device (SPEC F10).
 */

function App() {
  const session = useSession();
  const status = useAuthStatus();
  const refreshSession = session.refresh;

  // A cold offline start serves cached session data; when connectivity
  // returns, re-probe so the shell does not wait for a manual refresh.
  useEffect(() => {
    const onOnline = () => refreshSession();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [refreshSession]);

  if (session.state.phase === "loading") {
    return <SplashScreen />;
  }
  if (session.state.phase === "signed-in") {
    return (
      <OfflineSyncProvider probeGeneration={session.state.recoveryGeneration}>
        <SettingsProvider recoveryGeneration={session.state.recoveryGeneration}>
          <AppShell
            accounts={session.state.accounts}
            recoveryGeneration={session.state.recoveryGeneration}
            onSessionLost={session.refresh}
            onAccountsChanged={session.refresh}
          />
        </SettingsProvider>
      </OfflineSyncProvider>
    );
  }
  if (session.state.phase === "signed-out") {
    return (
      <SignInScreen
        status={status.data}
        statusFailed={status.phase === "error"}
        onRetryStatus={status.reload}
        onSignedIn={session.refresh}
      />
    );
  }
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground [padding-bottom:env(safe-area-inset-bottom)]">
      <p className="font-medium">The mail service cannot be reached.</p>
      <p className="max-w-sm text-muted-foreground">{session.state.message}</p>
      <Button variant="outline" onClick={session.refresh}>
        Try again
      </Button>
    </main>
  );
}

function SplashScreen() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
      <Spinner aria-hidden="true" className="size-5" />
      <p>Loading your mail.</p>
    </main>
  );
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("The root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <TooltipProvider delayDuration={300} skipDelayDuration={200}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);

/*
 * The offline shell (SPEC section 6 and F9): register the worker the build
 * emits. It precaches the shell, so an offline reload or an installed launch
 * still opens the app. A registration failure stays silent; the app works
 * through the network whenever the network is there.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
