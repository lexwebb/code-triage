import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleSectionProps {
  title: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  chevronClassName?: string;
  children: React.ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = false,
  className,
  chevronClassName,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "w-full flex items-center justify-between text-xs uppercase tracking-wide hover:bg-gray-800/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-inset",
          className,
        )}
      >
        <span>{title}</span>
        <span className={cn("text-gray-600", chevronClassName)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open && children}
    </>
  );
}
