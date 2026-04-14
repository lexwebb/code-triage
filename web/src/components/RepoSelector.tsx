import { useAppStore } from "../store";

export default function RepoFilter() {
  const filter = useAppStore((s) => s.repoFilter);
  const onFilterChange = useAppStore((s) => s.setRepoFilter);
  return (
    <div className="px-4 py-2 border-b border-gray-800">
      <input
        type="text"
        value={filter}
        onChange={(e) => onFilterChange(e.target.value)}
        placeholder="Filter repos..."
        className="w-full bg-gray-800 text-gray-200 text-sm rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none placeholder-gray-600"
      />
    </div>
  );
}
