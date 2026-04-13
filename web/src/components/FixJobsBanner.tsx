import { useState } from "react";
import type { FixJobStatus } from "../api";
import { api } from "../api";

interface FixJobsBannerProps {
  fixJobs: FixJobStatus[];
  onJobAction: () => void;
}

function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

function JobRow({ job, onJobAction }: { job: FixJobStatus; onJobAction: () => void }) {
  const [acting, setActing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const repoShort = job.repo.split("/")[1] ?? job.repo;

  async function handleApply() {
    if (!job.branch) return;
    setActing(true);
    try {
      await api.fixApply(job.repo, job.commentId, job.prNumber, job.branch);
      onJobAction();
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      setActing(false);
    }
  }

  async function handleDiscard() {
    if (!job.branch) return;
    setActing(true);
    try {
      await api.fixDiscard(job.branch, job.commentId);
      onJobAction();
    } catch (err) {
      console.error("Discard failed:", err);
    } finally {
      setActing(false);
    }
  }

  const statusColors: Record<string, string> = {
    running: "text-yellow-400",
    completed: "text-green-400",
    failed: "text-red-400",
  };

  const statusIcons: Record<string, string> = {
    running: "⏳",
    completed: "✓",
    failed: "✗",
  };

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 text-xs">
      <span className={statusColors[job.status] ?? "text-gray-400"}>
        {statusIcons[job.status] ?? "?"} {job.status}
      </span>
      <span className="text-gray-400 font-mono">{repoShort}#{job.prNumber}</span>
      <span className="text-gray-500 truncate flex-1">{job.path}</span>
      <span className="text-gray-600">{elapsed(job.startedAt)}</span>

      {job.status === "completed" && job.diff && (
        <>
          <button
            onClick={() => setShowDiff(!showDiff)}
            className="text-blue-400 hover:text-blue-300"
          >
            {showDiff ? "hide diff" : "view diff"}
          </button>
          <button
            onClick={handleApply}
            disabled={acting}
            className="px-2 py-0.5 bg-green-600 hover:bg-green-500 disabled:bg-green-800 text-white rounded"
          >
            {acting ? "..." : "Apply"}
          </button>
          <button
            onClick={handleDiscard}
            disabled={acting}
            className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
          >
            Discard
          </button>
        </>
      )}

      {job.status === "failed" && (
        <span className="text-red-400 truncate max-w-48">{job.error}</span>
      )}
    </div>
  );
}

export default function FixJobsBanner({ fixJobs, onJobAction }: FixJobsBannerProps) {
  if (fixJobs.length === 0) return null;

  const running = fixJobs.filter((j) => j.status === "running").length;
  const completed = fixJobs.filter((j) => j.status === "completed").length;
  const failed = fixJobs.filter((j) => j.status === "failed").length;

  return (
    <div className="border-t border-gray-800 bg-gray-900/80 shrink-0">
      <div className="px-4 py-1 text-xs text-gray-500 flex items-center gap-3 border-b border-gray-800/50">
        <span className="uppercase tracking-wide">Fix Jobs</span>
        {running > 0 && <span className="text-yellow-400">{running} running</span>}
        {completed > 0 && <span className="text-green-400">{completed} ready</span>}
        {failed > 0 && <span className="text-red-400">{failed} failed</span>}
      </div>
      <div className="max-h-40 overflow-y-auto">
        {fixJobs.map((job) => (
          <JobRow key={job.commentId} job={job} onJobAction={onJobAction} />
        ))}
      </div>
    </div>
  );
}
