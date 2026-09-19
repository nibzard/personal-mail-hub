import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        [
          "flex h-control-md w-full min-w-0 items-center justify-between gap-2",
          "rounded-md border border-input bg-surface px-3 py-1",
          "text-interface text-foreground",
          "transition-[border-color] duration-control ease-out-quiet",
          "focus-visible:border-ring",
          "aria-invalid:border-destructive",
          "data-placeholder:text-muted-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "[&_svg]:size-4 [&_svg]:shrink-0",
          "*:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center",
          "*:data-[slot=select-value]:gap-2 *:data-[slot=select-value]:truncate",
        ].join(" "),
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="opacity-50" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          [
            "relative z-50 max-h-(--radix-select-content-available-height)",
            "min-w-32 overflow-y-auto overflow-x-hidden",
            "rounded-md border bg-surface-raised text-surface-raised-foreground",
            "shadow-md duration-control ease-out-quiet",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            "data-[side=bottom]:slide-in-from-top-1",
            "data-[side=top]:slide-in-from-bottom-1",
            position === "popper" &&
              "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
            "pointer-coarse:max-h-72",
          ].filter(Boolean).join(" "),
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-slot="select-viewport"
          className={cn(
            "p-1",
            position === "popper" &&
              "h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width)",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(
        "px-2 py-1.5 text-interface font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        [
          "relative flex w-full cursor-default items-center gap-2 rounded-sm",
          "py-1.5 pr-8 pl-2 text-interface text-surface-raised-foreground select-none",
          "outline-none data-highlighted:bg-accent-muted",
          "data-highlighted:text-accent-muted-foreground",
          "data-disabled:pointer-events-none data-disabled:opacity-50",
          "[&_svg]:size-4 [&_svg]:shrink-0",
          "*:data-[slot=select-item-text]:truncate",
          "pointer-coarse:min-h-touch pointer-coarse:py-3",
        ].join(" "),
        className,
      )}
      {...props}
    >
      <span
        data-slot="select-item-text"
        className="flex min-w-0 items-center gap-2"
      >
        {children}
      </span>
      <SelectPrimitive.ItemIndicator
        data-slot="select-item-indicator"
        className="absolute right-2 flex items-center justify-center"
      >
        <Check className="size-4" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronUp className="size-4" aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronDown className="size-4" aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
