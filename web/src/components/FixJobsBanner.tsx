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

function JobModal({ job, onClose, onJobAction }: { job: FixJobStatus; onClose: () => void; onJobAction: () => void }) {
  const [acting, setActing] = useState(false);
  const repoShort = job.repo.split("/")[1] ?? job.repo;

  async function handleApply() {
    if (!job.branch) return;
    setActing(true);
    try {
      await api.fixApply(job.repo, job.commentId, job.prNumber, job.branch);
      onJobAction();
      onClose();
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
      onClose();
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Fix Job Details</h3>
            <span className="text-xs text-gray-500">{repoShort}#{job.prNumber} — {job.path}</span>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg px-2">✕</button>
        </div>

        {/* Info */}
        <div className="px-4 py-3 border-b border-gray-800 grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-gray-500">Status: </span>
            <span className={statusColors[job.status] ?? "text-gray-400"}>{job.status}</span>
          </div>
          <div>
            <span className="text-gray-500">Duration: </span>
            <span className="text-gray-300">{elapsed(job.startedAt)}</span>
          </div>
          <div>
            <span className="text-gray-500">Repository: </span>
            <span className="text-gray-300">{job.repo}</span>
          </div>
          <div>
            <span className="text-gray-500">Branch: </span>
            <span className="text-gray-300 font-mono">{job.branch ?? "—"}</span>
          </div>
          <div className="col-span-2">
            <span className="text-gray-500">File: </span>
            <span className="text-gray-300 font-mono">{job.path}</span>
          </div>
        </div>

        {/* Error */}
        {job.status === "failed" && job.error && (
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-xs text-gray-500 mb-1">Error</div>
            <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400 whitespace-pre-wrap">
              {job.error}
            </div>
          </div>
        )}

        {/* Diff */}
        {job.status === "completed" && job.diff && (
          <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
            <div className="text-xs text-gray-500 mb-1 flex items-center justify-between">
              <span>Proposed Changes</span>
              <button
                onClick={() => navigator.clipboard.writeText(job.diff!)}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
                title="Copy diff to clipboard"
              >
                Copy
              </button>
            </div>
            <div className="text-xs overflow-x-auto bg-gray-800 rounded font-mono border border-gray-700">
              {job.diff.split("\n").map((line, i) => {
                if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
                  return <div key={i} className="px-2 py-0.5 text-gray-500 bg-gray-850 border-b border-gray-700/50">{line}</div>;
                }
                if (line.startsWith("@@")) {
                  return <div key={i} className="px-2 py-0.5 text-blue-400 bg-blue-500/5 border-b border-gray-700/30">{line}</div>;
                }
                if (line.startsWith("+")) {
                  return <div key={i} className="px-2 py-0.5 text-green-400 bg-green-500/10">{line}</div>;
                }
                if (line.startsWith("-")) {
                  return <div key={i} className="px-2 py-0.5 text-red-400 bg-red-500/10">{line}</div>;
                }
                return <div key={i} className="px-2 py-0.5 text-gray-400">{line}</div>;
              })}
            </div>
          </div>
        )}

        {/* Claude output */}
        {job.claudeOutput && (
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-xs text-gray-500 mb-1">Claude Output</div>
            <pre className="p-2 text-xs overflow-x-auto max-h-48 overflow-y-auto bg-gray-800 rounded font-mono border border-gray-700 text-gray-300 whitespace-pre-wrap">
              {job.claudeOutput}
            </pre>
          </div>
        )}

        {/* Running spinner */}
        {job.status === "running" && (
          <div className="flex-1 flex items-center justify-center py-12 text-gray-500 text-sm">
            Claude is working on the fix...
          </div>
        )}

        {/* Actions */}
        {job.status === "completed" && (
          <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
            <button
              onClick={handleDiscard}
              disabled={acting}
              className="text-xs px-4 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-gray-300 rounded transition-colors"
            >
              Discard
            </button>
            <button
              onClick={handleApply}
              disabled={acting}
              className="text-xs px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:text-gray-400 text-white rounded transition-colors"
            >
              {acting ? "Pushing..." : "Apply & Push"}
            </button>
          </div>
        )}

        {job.status === "failed" && (
          <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
            {job.originalComment && job.branch && (
              <button
                onClick={async () => {
                  if (!job.branch || !job.originalComment) return;
                  setActing(true);
                  try {
                    await api.fixWithClaude(job.repo, job.commentId, job.prNumber, job.branch, job.originalComment);
                    onJobAction();
                    onClose();
                  } catch (err) {
                    console.error("Retry failed:", err);
                  } finally {
                    setActing(false);
                  }
                }}
                disabled={acting}
                className="text-xs px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-orange-800 disabled:text-gray-400 text-white rounded transition-colors"
              >
                {acting ? "Retrying..." : "Retry Fix"}
              </button>
            )}
            <button
              onClick={onClose}
              className="text-xs px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ job, onSelect }: { job: FixJobStatus; onSelect: () => void }) {
  const repoShort = job.repo.split("/")[1] ?? job.repo;

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
    <button
      onClick={onSelect}
      className="w-full flex items-center gap-3 px-4 py-1.5 text-xs hover:bg-gray-800/50 transition-colors text-left"
    >
      <span className={statusColors[job.status] ?? "text-gray-400"}>
        {statusIcons[job.status] ?? "?"} {job.status}
      </span>
      <span className="text-gray-400 font-mono">{repoShort}#{job.prNumber}</span>
      <span className="text-gray-500 truncate flex-1">{job.path}</span>
      <span className="text-gray-600">{elapsed(job.startedAt)}</span>
    </button>
  );
}

export default function FixJobsBanner({ fixJobs, onJobAction }: FixJobsBannerProps) {
  const [selectedJob, setSelectedJob] = useState<FixJobStatus | null>(null);

  if (fixJobs.length === 0) return null;

  const running = fixJobs.filter((j) => j.status === "running").length;
  const completed = fixJobs.filter((j) => j.status === "completed").length;
  const failed = fixJobs.filter((j) => j.status === "failed").length;

  return (
    <>
      <div className="border-t border-gray-800 bg-gray-900/80 shrink-0">
        <div className="px-4 py-1 text-xs text-gray-500 flex items-center gap-3 border-b border-gray-800/50">
          <span className="uppercase tracking-wide">Fix Jobs</span>
          {running > 0 && <span className="text-yellow-400">{running} running</span>}
          {completed > 0 && <span className="text-green-400">{completed} ready</span>}
          {failed > 0 && <span className="text-red-400">{failed} failed</span>}
        </div>
        <div className="max-h-40 overflow-y-auto">
          {fixJobs.map((job) => (
            <JobRow key={job.commentId} job={job} onSelect={() => setSelectedJob(job)} />
          ))}
        </div>
      </div>
      {selectedJob && (
        <JobModal
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onJobAction={onJobAction}
        />
      )}
    </>
  );
}
