import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        [
          "peer size-4 shrink-0 rounded-sm border border-input bg-surface",
          "transition-[background-color,border-color] duration-control ease-out-quiet",
          "hover:border-ring",
          "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
          "data-[state=checked]:text-accent-foreground",
          "data-[state=indeterminate]:border-accent",
          "data-[state=indeterminate]:bg-accent",
          "data-[state=indeterminate]:text-accent-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
        ].join(" "),
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" aria-hidden="true" />
        ) : (
          <Check className="size-3" strokeWidth={3} aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
