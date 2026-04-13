import type { PullRequest } from "../types";

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
        <span className="bg-green-500/15 text-green-400 text-xs px-1.5 py-0.5 rounded-full" title="Ready to merge">
          ✓ merge
        </span>
      )}
      {failed && (
        <span className="bg-red-500/15 text-red-400 text-xs px-1.5 py-0.5 rounded-full" title="CI checks failed">
          ✗ CI
        </span>
      )}
      {pending && (
        <span className="bg-yellow-500/15 text-yellow-400 text-xs px-1.5 py-0.5 rounded-full" title="CI checks running">
          ● CI
        </span>
      )}
      {!mergeReady && pr.hasHumanApproval && (
        <span className="bg-green-500/10 text-green-500 text-xs px-1.5 py-0.5 rounded-full" title="Approved">
          ✓ approved
        </span>
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
            onClick={() => onSelectPR(pr.number, pr.repo)}
            className={`text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors ${bgClass}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-gray-500 text-xs font-mono">#{pr.number}</span>
              <span className="flex items-center gap-1.5">
                {pr.openComments > 0 && (
                  <span className="bg-orange-500/20 text-orange-400 text-xs px-1.5 py-0.5 rounded-full" title={`${pr.openComments} open comment${pr.openComments !== 1 ? "s" : ""}`}>
                    {pr.openComments}
                  </span>
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
