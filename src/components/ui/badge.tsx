import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-none transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "bg-[var(--status-danger-bg)] text-[var(--status-danger-fg)]",
        outline: "border border-border text-foreground",
        "muted-success": "bg-[var(--status-ok-bg)] text-[var(--status-ok-fg)]",
        "muted-warning": "bg-[var(--status-warn-bg)] text-[var(--status-warn-fg)]",
        "muted-danger":  "bg-[var(--status-danger-bg)] text-[var(--status-danger-fg)]",
        "muted-info":    "bg-[var(--status-info-bg)] text-[var(--status-info-fg)]",
        "muted-neutral": "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-fg)]",
        "muted-active":  "bg-[var(--status-active-bg)] text-[var(--status-active-fg)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
