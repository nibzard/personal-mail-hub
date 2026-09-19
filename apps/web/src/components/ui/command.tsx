import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * cmdk inside the shared command dialog (SPEC section 6 and F11). The
 * wrappers map cmdk's roles onto the design tokens so the palette, and any
 * later menu built on the same registry, share one look.
 */

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-surface-raised text-surface-raised-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2 border-b px-3">
      <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-control-lg w-full min-w-0 bg-transparent text-reading text-foreground",
          "outline-none placeholder:text-muted-foreground disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        // The bounded height keeps the dialog usable above the on-screen
        // keyboard on phones (SPEC F12).
        "max-h-[min(24rem,50dvh)] overflow-y-auto overscroll-contain px-1.5 pb-1.5",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-muted-foreground"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden py-1",
        "[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5",
        "[&>[cmdk-group-heading]]:font-medium [&>[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1.5 border-b border-border", className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2",
        // Every palette action stays reachable by touch (SPEC F12).
        "max-md:min-h-11",
        "text-left outline-none transition-colors duration-feedback ease-out-quiet",
        "data-[selected=true]:bg-selection data-[selected=true]:text-foreground",
        // Unavailable commands stay readable: their reason is the point.
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:cursor-not-allowed",
        "data-[disabled=true]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
};
