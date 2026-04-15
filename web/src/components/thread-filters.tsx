import { useAppStore } from "../store";
import { HelpCircle } from "lucide-react";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "../lib/utils";

interface ThreadFiltersProps {
  actionableCount: number;
  allSelected: boolean;
  selectedCount: number;
  batching: boolean;
  onToggleSelectAll: () => void;
  onBatchAction: (action: "reply" | "resolve" | "dismiss") => void;
}

export function ThreadFilters({
  actionableCount,
  allSelected,
  selectedCount,
  batching,
  onToggleSelectAll,
  onBatchAction,
}: ThreadFiltersProps) {
  const filterText = useAppStore((s) => s.threadFilterText);
  const filterAction = useAppStore((s) => s.threadFilterAction);
  const showSnoozed = useAppStore((s) => s.threadShowSnoozed);
  const setFilterText = useAppStore((s) => s.setThreadFilterText);
  const setFilterAction = useAppStore((s) => s.setThreadFilterAction);
  const setShowSnoozed = useAppStore((s) => s.setThreadShowSnoozed);
  const toggleShortcuts = useAppStore((s) => s.toggleShortcuts);

  return (
    <>
      {/* Search/filter bar */}
      <div className="px-6 py-1.5 flex items-center gap-2 border-b border-gray-800/50 bg-gray-900/20">
        <input
          type="text"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by file or text..."
          className="flex-1 text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
        />
        {(["all", "fix", "reply", "resolve"] as const).map((a) => (
          <button
            key={a}
            onClick={() => setFilterAction(a)}
            className={cn("text-xs px-2 py-0.5 rounded transition-colors", filterAction === a
                ? a === "fix" ? "bg-orange-500/30 text-orange-300"
                  : a === "reply" ? "bg-blue-500/30 text-blue-300"
                  : a === "resolve" ? "bg-green-500/30 text-green-300"
                  : "bg-gray-600 text-gray-200"
                : "bg-gray-800 text-gray-500 hover:text-gray-300")}
          >
            {a === "all" ? "All" : a.charAt(0).toUpperCase() + a.slice(1)}
          </button>
        ))}
        <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0 ml-1 cursor-pointer select-none">
          <Checkbox
            checked={showSnoozed}
            onCheckedChange={(v) => setShowSnoozed(v === true)}
          />
          Snoozed
        </label>
        <div className="flex items-center gap-1 shrink-0 text-xs text-gray-600">
          <IconButton
            description="All keyboard shortcuts"
            icon={<HelpCircle size={14} />}
            onClick={() => toggleShortcuts()}
            size="sm"
            className="text-blue-400/90 hover:text-blue-300"
          />
          <details className="text-xs">
            <summary className="cursor-pointer hover:text-gray-400 select-none">Keys</summary>
            <div className="mt-1 pl-2 text-[10px] text-gray-500 space-y-0.5 font-sans normal-case tracking-normal">
              <div>j / k — focus thread</div>
              <div>Enter / Space — expand or collapse</div>
              <div>r reply · x resolve · d dismiss · f fix · e re-evaluate</div>
            </div>
          </details>
        </div>
      </div>
      {/* Bulk action toolbar */}
      {actionableCount > 0 && (
        <div className="px-6 py-1.5 flex items-center gap-3 border-b border-gray-800/50 bg-gray-900/30">
          <Checkbox
            checked={allSelected}
            onCheckedChange={onToggleSelectAll}
            title="Select all"
          />
          {selectedCount > 0 ? (
            <>
              <span className="text-xs text-gray-400">{selectedCount} selected</span>
              <Button variant="gray" size="xs" onClick={() => onBatchAction("dismiss")} disabled={batching}>
                Dismiss all
              </Button>
              <Button variant="green" size="xs" onClick={() => onBatchAction("resolve")} disabled={batching}>
                Resolve all
              </Button>
              <Button variant="blue" size="xs" onClick={() => onBatchAction("reply")} disabled={batching}>
                Reply all
              </Button>
            </>
          ) : (
            <span className="text-xs text-gray-600">Select threads for bulk actions</span>
          )}
        </div>
      )}
    </>
  );
}
