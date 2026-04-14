import type { PullRequest } from "../types";
import { cn } from "../lib/utils";
import { Check, X, Circle } from "lucide-react";
import { StatusBadge } from "./ui/status-badge";

interface PRListProps {
  pulls: PullRequest[];
  selectedPR: { number: number; repo: string } | null;
  onSelectPR: (number: number, repo: string) => void;
  showRepo: boolean;
}

function prKey(pr: PullRequest): string {
  return `${pr.repo}:${pr.number}`;
}

function StatusIcon({ pr }: { pr: PullRequest }) {
  const mergeReady = pr.checksStatus === "success" && pr.openComments === 0 && pr.hasHumanApproval;
  const failed = pr.checksStatus === "failure";
  const pending = pr.checksStatus === "pending";

  return (
    <span className="flex items-center gap-1">
      {mergeReady && (
        <StatusBadge color="green" icon={<Check size={12} />} title="Ready to merge">merge</StatusBadge>
      )}
      {failed && (
        <StatusBadge color="red" icon={<X size={12} />} title="CI checks failed">CI</StatusBadge>
      )}
      {pending && (
        <StatusBadge color="yellow" icon={<Circle size={10} fill="currentColor" />} title="CI checks running">CI</StatusBadge>
      )}
      {!mergeReady && pr.hasHumanApproval && (
        <StatusBadge color="green" icon={<Check size={12} />} title="Approved">approved</StatusBadge>
      )}
    </span>
  );
}

export default function PRList({ pulls, selectedPR, onSelectPR, showRepo }: PRListProps) {
  if (pulls.length === 0) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        No open pull requests found.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {pulls.map((pr) => {
        const key = prKey(pr);
        const isSelected = selectedPR?.number === pr.number && selectedPR?.repo === pr.repo;
        const mergeReady = pr.checksStatus === "success" && pr.openComments === 0 && pr.hasHumanApproval;
        const failed = pr.checksStatus === "failure";
        const pendingTriage = pr.pendingTriage ?? 0;

        let bgClass = "";
        if (isSelected) {
          bgClass = "bg-gray-800 border-l-2 border-l-blue-500";
        } else if (mergeReady) {
          bgClass = "bg-green-500/5";
        } else if (failed) {
          bgClass = "bg-red-500/5";
        }

        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelectPR(pr.number, pr.repo)}
            className={cn("text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors rounded-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset", bgClass)}
          >
            <div className="flex items-center justify-between">
              <span className="text-gray-500 text-xs font-mono">#{pr.number}</span>
              <span className="flex items-center gap-1.5">
                {pr.openComments > 0 && (
                  <StatusBadge color="orange" title={`${pr.openComments} open thread${pr.openComments !== 1 ? "s" : ""} (GitHub)`}>
                    {pr.openComments}
                  </StatusBadge>
                )}
                {pendingTriage > 0 && (
                  <StatusBadge
                    color="amber"
                    className="tabular-nums"
                    title={`${pendingTriage} pending in local triage (not dismissed / replied / fixed)`}
                  >
                    {pendingTriage}
                  </StatusBadge>
                )}
                <StatusIcon pr={pr} />
              </span>
            </div>
            <div className="text-sm text-gray-200 mt-0.5 line-clamp-2">{pr.title}</div>
            <div className="text-xs text-gray-500 mt-1">
              {showRepo && <span className="text-gray-600 mr-1">{pr.repo.split("/")[1]}</span>}
              {pr.branch}
            </div>
          </button>
        );
      })}
    </div>
  );
}
