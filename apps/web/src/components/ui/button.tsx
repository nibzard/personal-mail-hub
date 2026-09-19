import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

/*
 * States: default, hover, pressed, disabled, and pending. Selected state is
 * set by feature code through aria-pressed. Focus comes from the shared
 * :focus-visible outline in styles.css.
 */

const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md",
    "font-medium whitespace-nowrap text-interface",
    "transition-colors duration-control ease-out-quiet",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    "aria-busy:cursor-progress",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-accent text-accent-foreground shadow-xs hover:bg-accent/92 active:bg-accent/84",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/92 active:bg-destructive/84",
        outline:
          "border border-input bg-surface text-foreground shadow-xs hover:bg-muted active:bg-muted/70",
        ghost: "text-foreground hover:bg-muted active:bg-muted/70",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-control-sm gap-1 px-2.5",
        default: "h-control-md px-3.5",
        lg: "h-control-lg px-4",
        icon: "size-control-md p-0",
        "icon-sm": "size-control-sm p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner, disables the button, and keeps the label in place. */
  pending?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  pending = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-pending={pending || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={pending ? true : disabled}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? (
        <>
          <Spinner data-slot="button-spinner" />
          <span data-slot="button-label" className="inline-flex items-center gap-1.5">
            {children}
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
