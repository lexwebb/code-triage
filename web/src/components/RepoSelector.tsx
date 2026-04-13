import type { RepoInfo } from "../types";

interface RepoSelectorProps {
  repos: RepoInfo[];
  selectedRepo: string | null;
  onSelectRepo: (repo: string | null) => void;
}

export default function RepoSelector({ repos, selectedRepo, onSelectRepo }: RepoSelectorProps) {
  return (
    <div className="px-4 py-2 border-b border-gray-800">
      <select
        value={selectedRepo ?? ""}
        onChange={(e) => onSelectRepo(e.target.value || null)}
        className="w-full bg-gray-800 text-gray-200 text-sm rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
      >
        <option value="">All repos ({repos.length})</option>
        {repos.map((r) => (
          <option key={r.repo} value={r.repo}>
            {r.repo}
          </option>
        ))}
      </select>
    </div>
  );
}
