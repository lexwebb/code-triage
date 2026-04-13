interface RepoFilterProps {
  filter: string;
  onFilterChange: (filter: string) => void;
}

export default function RepoFilter({ filter, onFilterChange }: RepoFilterProps) {
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
