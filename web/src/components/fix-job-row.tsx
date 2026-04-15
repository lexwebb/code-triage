import React from "react";
import { cn } from "../lib/utils";
import type { FixJobStatus } from "../api";
import { Clock, Check, X, HelpCircle } from "lucide-react";

// eslint-disable-next-line react-refresh/only-export-components
export function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

// eslint-disable-next-line react-refresh/only-export-components
export const statusColors: Record<string, string> = {
  running: "text-yellow-400",
  completed: "text-green-400",
  failed: "text-red-400",
  no_changes: "text-blue-400",
  awaiting_response: "text-indigo-400",
};

// eslint-disable-next-line react-refresh/only-export-components
export const statusIcons: Record<string, React.ReactNode> = {
  running: <Clock size={12} />,
  completed: <Check size={12} />,
  failed: <X size={12} />,
  no_changes: <HelpCircle size={12} />,
  awaiting_response: <HelpCircle size={12} />,
};

export function FixJobRow({ job, onSelect }: { job: FixJobStatus; onSelect: () => void }) {
  const repoShort = job.repo.split("/")[1] ?? job.repo;

  return (
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-3 px-4 py-1.5 text-xs hover:bg-gray-800/50 transition-colors text-left"
    >
      <span className={cn("flex items-center gap-1", statusColors[job.status] ?? "text-gray-400")}>
        {statusIcons[job.status] ?? null} {job.status === "no_changes" ? "no changes" : job.status}
      </span>
      <span className="text-gray-400 font-mono">{repoShort}#{job.prNumber}</span>
      <span className="text-gray-500 truncate flex-1">{job.path}</span>
      <span className="text-gray-600">{elapsed(job.startedAt)}</span>
    </button>
  );
}
