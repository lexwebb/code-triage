import { useState } from "react";
import type { ReviewComment } from "../types";
import { api } from "../api";
import Comment from "./Comment";

interface CommentThreadsProps {
  comments: ReviewComment[];
  onSelectFile: (filename: string) => void;
  repo: string;
  prNumber: number;
  branch: string;
  onCommentAction: () => void;
}

interface Thread {
  root: ReviewComment;
  replies: ReviewComment[];
  isResolved: boolean;
}

function buildThreads(comments: ReviewComment[]): Thread[] {
  const rootComments = comments.filter((c) => c.inReplyToId === null);
  const replyMap = new Map<number, ReviewComment[]>();

  for (const c of comments) {
    if (c.inReplyToId !== null) {
      const existing = replyMap.get(c.inReplyToId) ?? [];
      existing.push(c);
      replyMap.set(c.inReplyToId, existing);
    }
  }

  const threads: Thread[] = rootComments.map((root) => {
    const replies = (replyMap.get(root.id) ?? []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const isResolved = root.isResolved || replies.some((r) => r.isResolved);
    return { root, replies, isResolved };
  });

  threads.sort((a, b) => {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
    return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
  });

  return threads;
}

function EvalBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    resolve: "bg-green-500/20 text-green-400",
    reply: "bg-blue-500/20 text-blue-400",
    fix: "bg-orange-500/20 text-orange-400",
  };
  const labels: Record<string, string> = {
    resolve: "Can Resolve",
    reply: "Suggest Reply",
    fix: "Needs Fix",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-sans ${styles[action] ?? "bg-gray-500/20 text-gray-400"}`}>
      {labels[action] ?? action}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "replied") return <span className="text-xs text-green-400">Replied ✓</span>;
  if (status === "dismissed") return <span className="text-xs text-gray-500">Dismissed</span>;
  if (status === "fixed") return <span className="text-xs text-blue-400">Fixed ✓</span>;
  return null;
}

function FixDiffPreview({ diff, onApply, onDiscard, applying }: {
  diff: string;
  onApply: () => void;
  onDiscard: () => void;
  applying: boolean;
}) {
  return (
    <div className="mx-1 mt-2 border border-orange-500/30 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-orange-500/10 text-xs text-orange-400 font-medium flex items-center justify-between">
        <span>Proposed Changes</span>
        <span className="flex items-center gap-2">
          <button
            onClick={onApply}
            disabled={applying}
            className="px-2 py-0.5 bg-green-600 hover:bg-green-500 disabled:bg-green-800 disabled:text-gray-400 text-white rounded text-xs transition-colors"
          >
            {applying ? "Pushing..." : "Apply & Push"}
          </button>
          <button
            onClick={onDiscard}
            disabled={applying}
            className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-gray-300 rounded text-xs transition-colors"
          >
            Discard
          </button>
        </span>
      </div>
      <pre className="p-2 text-xs overflow-x-auto max-h-64 overflow-y-auto bg-gray-900 font-mono">
        {diff.split("\n").map((line, i) => {
          let cls = "text-gray-400";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-400";
          else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-400";
          else if (line.startsWith("@@")) cls = "text-blue-400";
          return <div key={i} className={cls}>{line}</div>;
        })}
      </pre>
    </div>
  );
}

function ThreadItem({ thread, onSelectFile, repo, prNumber, branch, onCommentAction }: {
  thread: Thread;
  onSelectFile: (f: string) => void;
  repo: string;
  prNumber: number;
  branch: string;
  onCommentAction: () => void;
}) {
  const eval_ = thread.root.evaluation;
  const status = thread.root.crStatus;
  const isActedOn = status === "replied" || status === "dismissed" || status === "fixed";
  const [expanded, setExpanded] = useState(!thread.isResolved && !isActedOn);
  const [acting, setActing] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);

  // Fix with Claude state
  const [fixing, setFixing] = useState(false);
  const [fixDiff, setFixDiff] = useState<string | null>(null);
  const [fixBranch, setFixBranch] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  async function handleAction(action: "reply" | "resolve" | "dismiss") {
    setActing(true);
    try {
      if (action === "reply") {
        await api.replyToComment(repo, thread.root.id, prNumber);
      } else if (action === "resolve") {
        await api.resolveComment(repo, thread.root.id, prNumber);
      } else {
        await api.dismissComment(repo, thread.root.id, prNumber);
      }
      onCommentAction();
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setActing(false);
    }
  }

  async function handleFixWithClaude() {
    setFixing(true);
    setFixError(null);
    setFixDiff(null);
    try {
      const result = await api.fixWithClaude(repo, thread.root.id, prNumber, branch, {
        path: thread.root.path,
        line: thread.root.line,
        body: thread.root.body,
        diffHunk: thread.root.diffHunk,
      });
      if (result.success && result.diff) {
        setFixDiff(result.diff);
        setFixBranch(result.branch ?? branch);
      } else {
        setFixError(result.error ?? "Claude made no changes");
      }
    } catch (err) {
      setFixError((err as Error).message);
    } finally {
      setFixing(false);
    }
  }

  async function handleFixApply() {
    if (!fixBranch) return;
    setApplying(true);
    try {
      await api.fixApply(repo, thread.root.id, prNumber, fixBranch);
      setFixDiff(null);
      setFixBranch(null);
      onCommentAction();
    } catch (err) {
      setFixError((err as Error).message);
    } finally {
      setApplying(false);
    }
  }

  async function handleFixDiscard() {
    if (fixBranch) {
      try { await api.fixDiscard(fixBranch); } catch { /* ignore */ }
    }
    setFixDiff(null);
    setFixBranch(null);
    setFixError(null);
  }

  return (
    <div className={`border rounded-lg overflow-hidden ${
      thread.isResolved || isActedOn ? "border-gray-800/50 opacity-70" : "border-gray-800"
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 bg-gray-800/50 text-left text-xs font-mono flex items-center justify-between hover:bg-gray-800/80 transition-colors"
      >
        <span
          onClick={(e) => { e.stopPropagation(); onSelectFile(thread.root.path); }}
          className="text-blue-400 hover:text-blue-300"
        >
          {thread.root.path}:{thread.root.line}
        </span>
        <span className="flex items-center gap-2">
          {isActedOn && <StatusBadge status={status!} />}
          {!isActedOn && eval_ && <EvalBadge action={eval_.action} />}
          {thread.isResolved && <span className="text-green-500/70 text-xs font-sans">Resolved</span>}
          <span className="text-gray-600 text-xs">{expanded ? "▼" : "▶"}</span>
        </span>
      </button>
      {expanded && (
        <div className="p-2 space-y-0">
          <Comment comment={thread.root} compact />
          {thread.replies.map((reply) => (
            <Comment key={reply.id} comment={reply} compact />
          ))}

          {eval_ && !isActedOn && (
            <div className="mx-1 mt-2">
              <button
                onClick={() => setShowSuggestion(!showSuggestion)}
                className="text-xs text-gray-400 hover:text-gray-300 flex items-center gap-1"
              >
                <span>{showSuggestion ? "▼" : "▶"}</span>
                <span>
                  {eval_.action === "fix" ? "Suggested fix" : "Suggested response"}
                  {eval_.summary && <span className="text-gray-600 ml-1">— {eval_.summary}</span>}
                </span>
              </button>
              {showSuggestion && (
                <div className="mt-1 p-2 bg-gray-800/50 rounded text-xs text-gray-300 whitespace-pre-wrap border border-gray-700">
                  {eval_.action === "fix" ? (eval_.fixDescription || eval_.summary) : (eval_.reply || eval_.summary)}
                </div>
              )}
            </div>
          )}

          {/* Fix diff preview */}
          {fixDiff && fixBranch && (
            <FixDiffPreview
              diff={fixDiff}
              onApply={handleFixApply}
              onDiscard={handleFixDiscard}
              applying={applying}
            />
          )}

          {/* Fix error */}
          {fixError && (
            <div className="mx-1 mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
              {fixError}
              <button onClick={() => setFixError(null)} className="ml-2 text-gray-500 hover:text-gray-300">dismiss</button>
            </div>
          )}

          {/* Action buttons */}
          {!isActedOn && !thread.isResolved && (
            <div className="flex items-center gap-2 mx-1 mt-2 pt-2 border-t border-gray-800">
              {eval_?.action === "reply" && eval_.reply && (
                <button
                  onClick={() => handleAction("reply")}
                  disabled={acting || fixing}
                  className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-gray-400 text-white rounded transition-colors"
                >
                  {acting ? "Sending..." : "Send Reply"}
                </button>
              )}
              <button
                onClick={handleFixWithClaude}
                disabled={acting || fixing || !!fixDiff}
                className="text-xs px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:bg-orange-800 disabled:text-gray-400 text-white rounded transition-colors"
              >
                {fixing ? "Claude is fixing..." : "Fix with Claude"}
              </button>
              <button
                onClick={() => handleAction("resolve")}
                disabled={acting || fixing}
                className="text-xs px-3 py-1 bg-green-600/80 hover:bg-green-500/80 disabled:bg-green-800/50 disabled:text-gray-400 text-white rounded transition-colors"
              >
                Resolve
              </button>
              <button
                onClick={() => handleAction("dismiss")}
                disabled={acting || fixing}
                className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-400 text-gray-300 rounded transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CommentThreads({ comments, onSelectFile, repo, prNumber, branch, onCommentAction }: CommentThreadsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const threads = buildThreads(comments);

  if (threads.length === 0) return null;

  const openCount = threads.filter((t) => !t.isResolved).length;
  const resolvedCount = threads.filter((t) => t.isResolved).length;

  return (
    <div className="border-b border-gray-800 flex-1 overflow-y-auto">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30 sticky top-0 bg-gray-950 z-10"
      >
        <span>
          Review Threads ({threads.length})
          {resolvedCount > 0 && (
            <span className="normal-case ml-2 text-gray-600">
              {openCount} open, {resolvedCount} resolved
            </span>
          )}
        </span>
        <span className="text-gray-600">{collapsed ? "▶" : "▼"}</span>
      </button>
      {!collapsed && (
        <div className="px-6 pb-3 space-y-3">
          {threads.map((thread) => (
            <ThreadItem
              key={thread.root.id}
              thread={thread}
              onSelectFile={onSelectFile}
              repo={repo}
              prNumber={prNumber}
              branch={branch}
              onCommentAction={onCommentAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
