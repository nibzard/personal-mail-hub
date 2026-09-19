import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Focus visibility comes from the shared :focus-visible outline; the border
 * also darkens so the field itself signals focus. Set aria-invalid to switch
 * to the destructive border for error states.
 */

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        [
          "h-control-md w-full min-w-0 rounded-md border border-input",
          "bg-surface px-3 py-1 text-interface text-foreground",
          "transition-[border-color] duration-control ease-out-quiet",
          "focus-visible:border-ring",
          "placeholder:text-muted-foreground",
          "aria-invalid:border-destructive",
          "disabled:cursor-not-allowed disabled:opacity-50",
        ].join(" "),
        className,
      )}
      {...props}
    />
  );
}

export { Input };
