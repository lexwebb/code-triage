import * as React from "react";
import { cn } from "@/lib/utils";

interface IconButtonProps extends Omit<React.ComponentProps<"button">, "children"> {
  /** Accessible label shown as tooltip and read by screen readers. Required. */
  description: string;
  icon: React.ReactNode;
  size?: "sm" | "default";
}

export function IconButton({
  description,
  icon,
  size = "default",
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={description}
      aria-label={description}
      className={cn(
        "inline-flex items-center justify-center rounded cursor-pointer transition-colors",
        "text-gray-500 hover:text-gray-300 hover:bg-gray-800",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
        "disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "p-1" : "p-1.5",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="sr-only">{description}</span>
    </button>
  );
}
