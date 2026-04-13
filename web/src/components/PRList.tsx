import type { PullRequest } from "../types";

interface PRListProps {
  pulls: PullRequest[];
  selectedPR: number | null;
  onSelectPR: (number: number) => void;
  commentCounts: Record<number, number>;
}

export default function PRList({ pulls, selectedPR, onSelectPR, commentCounts }: PRListProps) {
  if (pulls.length === 0) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        No open pull requests found.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {pulls.map((pr) => (
        <button
          key={pr.number}
          onClick={() => onSelectPR(pr.number)}
          className={`text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors ${
            selectedPR === pr.number ? "bg-gray-800 border-l-2 border-l-blue-500" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-gray-500 text-xs font-mono">#{pr.number}</span>
            {(commentCounts[pr.number] ?? 0) > 0 && (
              <span className="bg-blue-500/20 text-blue-400 text-xs px-1.5 py-0.5 rounded-full">
                {commentCounts[pr.number]}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-200 mt-0.5 line-clamp-2">{pr.title}</div>
          <div className="text-xs text-gray-500 mt-1">{pr.branch}</div>
        </button>
      ))}
    </div>
  );
}
