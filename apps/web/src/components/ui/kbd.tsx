import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Keyboard hint, for example the platform shortcut on the Commands button.
 * Purely decorative: the command itself carries the accessible label.
 */

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        [
          "inline-flex h-5 min-w-5 items-center justify-center rounded-sm",
          "border border-border bg-muted px-1",
          "font-sans text-xs leading-none font-medium text-muted-foreground",
        ].join(" "),
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
