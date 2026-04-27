import { useMemo, useState } from "react";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import { Button } from "./ui/button";
import { useAppStore } from "../store";
import type { FixJobStatus } from "../api";
import { elapsed, statusColors } from "./fix-job-row";

function parseJobDiff(job: FixJobStatus) {
  if (!job.diff) return null;
  const parsed = parseDiff(job.diff, { nearbySequences: "zip" });
  if (parsed.length === 0) return null;
  return parsed;
}

export function FixJobInlineReview({
  job,
  ownerCommentId,
}: {
  job: FixJobStatus;
  ownerCommentId: number;
}) {
  const acting = useAppStore((s) => s.acting[job.commentId] ?? false);
  const fixApplyPhase = useAppStore((s) => s.fixApplyPhase[job.commentId]);
  const applyFix = useAppStore((s) => s.apply);
  const discardFix = useAppStore((s) => s.discard);
  const retryFix = useAppStore((s) => s.retryFix);
  const reloadComments = useAppStore((s) => s.reloadComments);
  const [adjustments, setAdjustments] = useState("");
  const [requestingAdjustments, setRequestingAdjustments] = useState(false);

  const parsedDiffs = useMemo(() => parseJobDiff(job), [job]);
  const canRequestAdjustments = !!job.branch && !!job.originalComment;
  const isOwnerJob = job.commentId === ownerCommentId;

  async function handleApprove() {
    if (!job.branch) return;
    await applyFix(job.repo, job.commentId, job.prNumber, job.branch);
  }

  async function handleUnapprove() {
    if (!job.branch) return;
    await discardFix(job.branch, job.commentId);
  }

  async function handleRequestAdjustments() {
    if (!job.branch || !job.originalComment || requestingAdjustments || !adjustments.trim()) return;
    setRequestingAdjustments(true);
    try {
      await retryFix(
        job.repo,
        job.commentId,
        job.prNumber,
        job.branch,
        job.originalComment,
        adjustments.trim(),
      );
      setAdjustments("");
      await reloadComments();
    } finally {
      setRequestingAdjustments(false);
    }
  }

  return (
    <div className="mx-1 mt-2 rounded border border-gray-700/70 bg-gray-900/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-800 text-xs flex items-center gap-2">
        <span className="text-gray-500 uppercase tracking-wide">Suggested fix</span>
        <span className={statusColors[job.status] ?? "text-gray-400"}>{job.status === "no_changes" ? "no changes" : job.status}</span>
        {!isOwnerJob && <span className="text-purple-300/90">from related thread</span>}
        <span className="text-gray-600 ml-auto">{elapsed(job.startedAt)}</span>
      </div>

      {job.status === "failed" && job.error && (
        <div className="px-3 py-2 text-xs text-red-300 bg-red-500/10 border-b border-red-500/20 whitespace-pre-wrap">
          {job.error}
        </div>
      )}

      {job.status === "completed" && parsedDiffs && (
        <div className="diff-dark max-h-80 overflow-auto">
          {parsedDiffs.map((fileDiff, idx) => (
            <Diff key={`${fileDiff.newPath ?? fileDiff.oldPath ?? idx}-${idx}`} viewType="unified" diffType={fileDiff.type} hunks={fileDiff.hunks}>
              {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
            </Diff>
          ))}
        </div>
      )}
      {job.status === "completed" && !parsedDiffs && (
        <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-800">No diff available.</div>
      )}

      {job.status === "completed" && (
        <div className="px-3 py-2 border-t border-gray-800 space-y-2">
          <div className="flex items-center gap-2">
            <Button variant="green" size="xs" onClick={() => void handleApprove()} disabled={acting || !job.branch} className="gap-1.5">
              {acting ? (fixApplyPhase === "extended" ? "Approving (pushing)..." : "Approving...") : "Approve"}
            </Button>
            <Button variant="gray" size="xs" onClick={() => void handleUnapprove()} disabled={acting || !job.branch}>
              Un-approve
            </Button>
          </div>

          {canRequestAdjustments && (
            <div className="space-y-2">
              <textarea
                value={adjustments}
                onChange={(e) => setAdjustments(e.target.value)}
                rows={2}
                placeholder="Ask Claude for adjustments to this suggested fix..."
                className="w-full text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
              />
              <div className="flex justify-end">
                <Button
                  variant="blue"
                  size="xs"
                  onClick={() => void handleRequestAdjustments()}
                  disabled={acting || requestingAdjustments || !adjustments.trim()}
                >
                  {requestingAdjustments ? "Requesting..." : "Request adjustments"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
