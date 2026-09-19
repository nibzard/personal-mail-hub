import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Spinning loader icon. Decorative by default; label the control instead. */
export function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <LoaderCircle
      data-slot="spinner"
      aria-hidden="true"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}
