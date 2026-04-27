import { useAppStore } from "../store";
import { ListOrdered } from "lucide-react";
import { FixJobRow } from "./fix-job-row";
import { FixJobModal } from "./fix-job-modal";

export default function FixJobsBanner() {
  const fixJobs = useAppStore((s) => s.jobs);
  const selectedJobId = useAppStore((s) => s.selectedJobId);
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId);
  const queue = useAppStore((s) => s.queue);
  const cancelQueued = useAppStore((s) => s.cancelQueued);

  if (fixJobs.length === 0 && queue.length === 0) return null;

  const running = fixJobs.filter((j) => j.status === "running").length;
  const awaiting = fixJobs.filter((j) => j.status === "awaiting_response").length;
  const completed = fixJobs.filter((j) => j.status === "completed").length;
  const failed = fixJobs.filter((j) => j.status === "failed").length;
  const noChanges = fixJobs.filter((j) => j.status === "no_changes").length;

  return (
    <>
      <div className="border-t border-gray-800 bg-gray-900/80 shrink-0">
        <div className="px-4 py-1 text-xs text-gray-500 flex items-center gap-3 border-b border-gray-800/50">
          <span className="uppercase tracking-wide">Fix Jobs</span>
          {running > 0 && <span className="text-yellow-400">{running} running</span>}
          {awaiting > 0 && <span className="text-indigo-400">{awaiting} awaiting reply</span>}
          {completed > 0 && <span className="text-green-400">{completed} ready</span>}
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
          {noChanges > 0 && <span className="text-blue-400">{noChanges} no changes</span>}
          {queue.length > 0 && <span className="text-gray-400">{queue.length} queued</span>}
          <span className="ml-auto text-gray-600">Review in thread; use Details for modal</span>
        </div>
        <div className="max-h-40 overflow-y-auto">
          {fixJobs.map((job) => (
            <FixJobRow key={job.commentId} job={job} onSelect={() => setSelectedJobId(job.commentId)} />
          ))}
          {queue.map((q) => (
            <div
              key={`q-${q.commentId}`}
              className="flex items-center gap-3 px-4 py-1.5 text-xs text-gray-400"
            >
              <span className="flex items-center gap-1 text-gray-500">
                <ListOrdered size={12} /> queued
              </span>
              <span className="text-gray-400 font-mono">{q.repo.split("/")[1]}#{q.prNumber}</span>
              <span className="text-gray-500 truncate flex-1">{q.path}</span>
              <button
                className="text-gray-600 hover:text-red-400 transition-colors"
                onClick={(e) => { e.stopPropagation(); cancelQueued(q.commentId); }}
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      </div>
      {selectedJobId != null && (
        <FixJobModal commentId={selectedJobId} />
      )}
    </>
  );
}
