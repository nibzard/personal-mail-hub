import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "./settings-context";
import { readConfirmedHomeStartup } from "./home-startup";

/** Resolve startup once. Later settings updates never replace active work. */
export function HomeStartupGate({ children }: { children: (home: boolean) => ReactNode }) {
  const settings = useAppSettings();
  const [home, setHome] = useState<boolean | null>(null);
  useEffect(() => {
    if (home !== null) return;
    if (settings.phase === "ready") setHome(settings.settings.homeEnabled);
    else if (settings.phase === "error") setHome(readConfirmedHomeStartup());
  }, [home, settings.phase, settings.settings.homeEnabled]);

  if (home !== null) return children(home);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-foreground">
      <p role="status">
        {settings.phase === "error" ? "Startup settings cannot be loaded. You can still open Inbox." : "Loading your settings…"}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setHome(false)}>Open Inbox</Button>
        {settings.phase === "error" && <Button variant="outline" onClick={settings.reload}>Try again</Button>}
      </div>
    </main>
  );
}
