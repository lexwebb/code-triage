import React from "react";
import { cn } from "../lib/utils";
import { useAppStore } from "../store";
import { Loader2, X } from "lucide-react";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { elapsed, statusColors } from "./fix-job-row";

export function FixJobModal({ commentId }: { commentId: number }) {
  const job = useAppStore((s) => s.jobs.find((j) => j.commentId === commentId));
  const acting = useAppStore((s) => s.acting[commentId] ?? false);
  const fixApplyPhase = useAppStore((s) => s.fixApplyPhase[commentId]);
  const replyText = useAppStore((s) => s.replyText[commentId] ?? "");
  const noChangesReply = useAppStore((s) => s.noChangesReply[commentId] ?? "");
  const setReplyText = useAppStore((s) => s.setReplyText);
  const setNoChangesReply = useAppStore((s) => s.setNoChangesReply);
  const applyFix = useAppStore((s) => s.apply);
  const discardFix = useAppStore((s) => s.discard);
  const sendReply = useAppStore((s) => s.sendReply);
  const sendReplyAndResolve = useAppStore((s) => s.sendReplyAndResolve);
  const retryFix = useAppStore((s) => s.retryFix);
  const close = useAppStore((s) => s.setSelectedJobId);
  const reloadComments = useAppStore((s) => s.reloadComments);

  if (!job) return null;

  const onClose = () => close(null);
  const repoShort = job.repo.split("/")[1] ?? job.repo;

  async function handleApply() {
    if (!job || !job.branch) return;
    try {
      await applyFix(job.repo, job.commentId, job.prNumber, job.branch);
      close(null);
    } catch (err) {
      console.error("Apply failed:", err);
    }
  }

  async function handleDiscard() {
    if (!job || !job.branch) return;
    try {
      await discardFix(job.branch, job.commentId);
      close(null);
    } catch (err) {
      console.error("Discard failed:", err);
    }
  }

  async function handleSendReply() {
    if (!job || !replyText.trim() || acting) return;
    try {
      await sendReply(job.repo, job.commentId, replyText.trim());
      setReplyText(job.commentId, "");
      await reloadComments();
    } catch (err) {
      console.error("Reply failed:", err);
    }
  }

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
          <IconButton description="Close" icon={<X size={16} />} onClick={onClose} size="sm" />
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

        {/* Conversation */}
        {job.conversation && job.conversation.length > 0 && (
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-xs text-gray-500 mb-1">Conversation</div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {job.conversation.map((msg, i) => (
                <div key={i} className={cn("text-xs p-2 rounded whitespace-pre-wrap", msg.role === "claude" ? "bg-gray-800/60 text-gray-300 mr-8" : "bg-indigo-900/30 text-indigo-200 ml-8")}>
                  <span className="text-[10px] text-gray-500 block mb-0.5">
                    {msg.role === "claude" ? "Claude" : "You"}
                  </span>
                  {msg.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {job.status === "failed" && job.error && (
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-xs text-gray-500 mb-1">Error</div>
            <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400 whitespace-pre-wrap">
              {job.error}
            </div>
          </div>
        )}

        {/* No changes — suggested reply */}
        {job.status === "no_changes" && job.suggestedReply && (
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-xs text-gray-500 mb-1">Claude determined no code changes are needed</div>
            <div className="text-xs text-gray-500 mb-2">Review and optionally edit the reply before sending:</div>
            <textarea
              value={noChangesReply}
              onChange={(e) => setNoChangesReply(commentId, e.target.value)}
              rows={4}
              className="w-full text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
            />
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

        {job.status === "running" && (
          <div className="flex-1 space-y-3 px-4 py-8">
            <Skeleton className="mx-auto h-4 w-full max-w-md" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {/* Awaiting response reply */}
        {job.status === "awaiting_response" && (
          <div className="px-4 py-3 border-t border-gray-800">
            <div className="flex gap-2 items-end">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(commentId, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    void handleSendReply();
                  }
                }}
                placeholder="Reply to Claude's questions..."
                disabled={acting}
                rows={2}
                autoFocus
                className="flex-1 text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
              />
              <Button
                variant="blue"
                size="xs"
                onClick={() => void handleSendReply()}
                disabled={acting || !replyText.trim()}
              >
                {acting ? "Sending..." : "Send Reply"}
              </Button>
            </div>
          </div>
        )}

        {/* Actions */}
        {job.status === "completed" && (
          <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
            <Button variant="gray" size="xs" onClick={handleDiscard} disabled={acting}>
              Discard
            </Button>
            <Button variant="green" size="xs" onClick={handleApply} disabled={acting} className="gap-1.5">
              {acting ? (
                <>
                  <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                  <span>
                    {fixApplyPhase === "extended"
                      ? "Restoring worktree & pushing…"
                      : "Pushing…"}
                  </span>
                </>
              ) : (
                "Apply & Push"
              )}
            </Button>
          </div>
        )}

        {job.status === "failed" && (
          <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
            {job.originalComment && job.branch && (
              <Button
                variant="orange"
                size="xs"
                onClick={async () => {
                  if (!job.branch || !job.originalComment) return;
                  try {
                    await retryFix(job.repo, job.commentId, job.prNumber, job.branch, job.originalComment);
                    await reloadComments();
                    close(null);
                  } catch (err) {
                    console.error("Retry failed:", err);
                  }
                }}
                disabled={acting}
              >
                {acting ? "Retrying..." : "Retry Fix"}
              </Button>
            )}
            <Button variant="gray" size="xs" onClick={onClose}>
              Close
            </Button>
          </div>
        )}

        {job.status === "no_changes" && (
          <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
            <Button
              variant="blue"
              size="xs"
              onClick={async () => {
                if (!noChangesReply.trim()) return;
                try {
                  await sendReplyAndResolve(job.repo, job.commentId, job.prNumber, noChangesReply.trim());
                  await reloadComments();
                  close(null);
                } catch (err) {
                  console.error("Reply failed:", err);
                }
              }}
              disabled={acting || !noChangesReply.trim()}
            >
              {acting ? "Sending..." : "Send Reply & Resolve"}
            </Button>
            <Button variant="gray" size="xs" onClick={onClose}>
              Dismiss
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
