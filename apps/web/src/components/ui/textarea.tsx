import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        [
          "min-h-16 w-full rounded-md border border-input",
          "bg-surface px-3 py-2 text-reading text-foreground",
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

export { Textarea };
