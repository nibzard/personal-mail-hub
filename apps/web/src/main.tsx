import { API_VERSION } from "@mail-hub/contracts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeToggle } from "@/components/theme-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./styles.css";

/*
 * Placeholder screen while the interface tasks land. It exercises the
 * shared tokens, the theme manager, and the TooltipProvider mount that the
 * application shell will keep.
 */

function App() {
  return (
    <main className="mx-auto max-w-[48rem] px-6 py-16">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-reading font-semibold">Personal mail hub</h1>
        <ThemeToggle />
      </div>
      <p className="mt-2 text-muted-foreground">
        The interface foundation is ready.
      </p>
      <small className="text-muted-foreground">API {API_VERSION}</small>
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
  </StrictMode>
);
