import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Layout-matched placeholder for uncached content. The global
 * prefers-reduced-motion rule stops the pulse and leaves a static block.
 */

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
