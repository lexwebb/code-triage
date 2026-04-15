/* Re-exports mirror the CLI module; keep a single source of truth in repo src/lifecycle-stage.ts. */
/* eslint-disable react-refresh/only-export-components */
import { cn } from "../lib/utils";
export type {
  LifecycleStage,
  OpenPullLike,
  TicketIssueDetailLike,
  TicketIssueLike,
} from "../../../src/lifecycle-stage.js";
export {
  coerceLifecycleStage,
  deriveLifecycleStage,
  deriveTicketIssueLifecycleStage,
  resolveAttentionLifecycleStage,
} from "../../../src/lifecycle-stage.js";
import type { LifecycleStage } from "../../../src/lifecycle-stage.js";

const STAGES: { key: LifecycleStage; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "branch", label: "Branch" },
  { key: "pr-open", label: "PR" },
  { key: "review-requested", label: "Review" },
  { key: "approved", label: "Approved" },
  { key: "merged", label: "Merged" },
  { key: "closed", label: "Closed" },
];

interface LifecycleBarProps {
  currentStage?: LifecycleStage;
  stuck?: boolean;
  compact?: boolean;
  className?: string;
}

function stageIndex(stage: LifecycleStage): number {
  return STAGES.findIndex((s) => s.key === stage);
}

export function LifecycleBar({ currentStage, stuck, compact = true, className }: LifecycleBarProps) {
  if (!currentStage) return null;
  const currentIdx = stageIndex(currentStage);
  const currentLabel = STAGES[currentIdx]?.label ?? "Unknown";

  return (
    <div className={cn("flex items-center gap-0.5", className)} title={`Stage: ${currentLabel}`}>
      {STAGES.map((stage, i) => {
        const isCurrent = i === currentIdx;
        const isCompleted = i < currentIdx;
        const isFuture = i > currentIdx;
        return (
          <div
            key={stage.key}
            className={cn(
              "h-1.5 w-1.5 rounded-full transition-colors",
              isCompleted && "bg-green-500",
              isCurrent && !stuck && "bg-blue-400",
              isCurrent && stuck && "bg-amber-400",
              isFuture && "bg-zinc-700",
            )}
            title={stage.label}
          />
        );
      })}
      {!compact && (
        <span className={cn("ml-1 text-[10px]", stuck ? "text-amber-400" : "text-zinc-500")}>
          {currentLabel}
        </span>
      )}
    </div>
  );
}
