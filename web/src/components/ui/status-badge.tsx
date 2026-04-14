import * as React from "react";
import { cn } from "@/lib/utils";

const colorStyles = {
  green: "bg-green-500/15 text-green-400",
  red: "bg-red-500/15 text-red-400",
  yellow: "bg-yellow-500/15 text-yellow-400",
  orange: "bg-orange-500/20 text-orange-400",
  amber: "bg-amber-500/20 text-amber-300",
  blue: "bg-blue-500/20 text-blue-400",
  gray: "bg-gray-500/20 text-gray-400",
} as const;

interface StatusBadgeProps extends React.ComponentProps<"span"> {
  color?: keyof typeof colorStyles;
  icon?: React.ReactNode;
}

export function StatusBadge({
  color = "gray",
  icon,
  className,
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full",
        colorStyles[color],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}
