import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";
import { cn } from "@/lib/utils";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        [
          "inline-flex h-5 w-9 shrink-0 items-center rounded-full border",
          "border-transparent bg-input p-0.5",
          "transition-colors duration-control ease-out-quiet",
          "data-[state=checked]:bg-accent",
          "disabled:cursor-not-allowed disabled:opacity-50",
        ].join(" "),
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          [
            "pointer-events-none block size-4 rounded-full bg-background shadow-sm",
            "transition-transform duration-control ease-out-quiet",
            "data-[state=checked]:translate-x-4",
          ].join(" "),
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
