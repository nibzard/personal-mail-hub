import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Small status and scope labels. Status color never carries meaning alone:
 * pair every status badge with text or an accessible label.
 */

const badgeVariants = cva(
  [
    "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
    "text-xs leading-4 font-medium whitespace-nowrap",
    "transition-colors duration-feedback",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent-muted text-accent-muted-foreground",
        solid: "border-transparent bg-accent text-accent-foreground",
        outline: "border-border text-muted-foreground",
        success:
          "border-transparent bg-success-muted text-success-muted-foreground",
        warning:
          "border-transparent bg-warning-muted text-warning-muted-foreground",
        destructive:
          "border-transparent bg-destructive-muted text-destructive-muted-foreground",
        info: "border-transparent bg-info-muted text-info-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
