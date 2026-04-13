import type { PullRequestDetail } from "../types";

interface PRDetailProps {
  pr: PullRequestDetail;
}

export default function PRDetail({ pr }: PRDetailProps) {
  return (
    <div className="px-6 py-4 border-b border-gray-800">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {pr.title}
            <span className="text-gray-500 font-normal ml-2">#{pr.number}</span>
          </h2>
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
            <span className="font-mono text-xs bg-gray-800 px-2 py-0.5 rounded">
              {pr.branch} &larr; {pr.baseBranch}
            </span>
            <span className="text-green-400">+{pr.additions}</span>
            <span className="text-red-400">-{pr.deletions}</span>
            <span>{pr.changedFiles} files</span>
          </div>
        </div>
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-400 hover:text-blue-300"
        >
          View on GitHub &rarr;
        </a>
      </div>
    </div>
  );
}
