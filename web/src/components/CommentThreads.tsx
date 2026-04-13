import { useState } from "react";
import type { ReviewComment } from "../types";
import { api } from "../api";
import type { FixJobStatus } from "../api";
import Comment from "./Comment";

interface CommentThreadsProps {
  comments: ReviewComment[];
  onSelectFile: (filename: string) => void;
  repo: string;
  prNumber: number;
  branch: string;
  fixJobs: FixJobStatus[];
  onCommentAction: () => void;
  onFixStarted: (job: FixJobStatus) => void;
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

function ThreadItem({ thread, onSelectFile, repo, prNumber, branch, fixBlocked, onCommentAction, onFixStarted }: {
  thread: Thread;
  onSelectFile: (f: string) => void;
  repo: string;
  prNumber: number;
  branch: string;
  fixBlocked: boolean;
  onCommentAction: () => void;
  onFixStarted: (job: FixJobStatus) => void;
}) {
  const eval_ = thread.root.evaluation;
  const status = thread.root.crStatus;
  const isActedOn = status === "replied" || status === "dismissed" || status === "fixed";
  const [expanded, setExpanded] = useState(!thread.isResolved && !isActedOn);
  const [acting, setActing] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);

  // Fix with Claude state
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [reEvaluating, setReEvaluating] = useState(false);

  async function handleReEvaluate() {
    setReEvaluating(true);
    try {
      await api.reEvaluate(repo, thread.root.id, prNumber);
      onCommentAction();
    } catch (err) {
      console.error("Re-evaluate failed:", err);
    } finally {
      setReEvaluating(false);
    }
  }

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

    // Optimistic update — immediately show as running
    onFixStarted({
      commentId: thread.root.id,
      repo,
      prNumber,
      path: thread.root.path,
      startedAt: Date.now(),
      status: "running",
      branch,
      originalComment: {
        path: thread.root.path,
        line: thread.root.line,
        body: thread.root.body,
        diffHunk: thread.root.diffHunk,
      },
    });

    try {
      const result = await api.fixWithClaude(repo, thread.root.id, prNumber, branch, {
        path: thread.root.path,
        line: thread.root.line,
        body: thread.root.body,
        diffHunk: thread.root.diffHunk,
      });
      if (!result.success) {
        setFixError(result.error ?? "Failed to start fix");
      }
    } catch (err) {
      setFixError((err as Error).message);
    } finally {
      setFixing(false);
    }
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
                disabled={acting || fixing || fixBlocked}
                className="text-xs px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:bg-orange-800 disabled:text-gray-400 text-white rounded transition-colors"
                title={fixBlocked ? "A fix is already running on this PR" : undefined}
              >
                {fixing ? "Starting fix..." : fixBlocked ? "Fix running..." : "Fix with Claude"}
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
              <button
                onClick={handleReEvaluate}
                disabled={acting || fixing || reEvaluating}
                className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-400 text-gray-400 rounded transition-colors ml-auto"
                title="Re-run Claude evaluation on this comment"
              >
                {reEvaluating ? "Evaluating..." : "Re-evaluate"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CommentThreads({ comments, onSelectFile, repo, prNumber, branch, fixJobs, onCommentAction, onFixStarted }: CommentThreadsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batching, setBatching] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterAction, setFilterAction] = useState<"all" | "fix" | "reply" | "resolve">("all");
  const allThreads = buildThreads(comments);

  const threads = allThreads.filter((t) => {
    if (filterText) {
      const q = filterText.toLowerCase();
      if (!t.root.path.toLowerCase().includes(q) && !t.root.body.toLowerCase().includes(q)) return false;
    }
    if (filterAction !== "all" && t.root.evaluation?.action !== filterAction) return false;
    return true;
  });

  if (threads.length === 0) return null;

  const openCount = threads.filter((t) => !t.isResolved).length;
  const resolvedCount = threads.filter((t) => t.isResolved).length;
  const hasRunningFix = fixJobs.some((j) => j.repo === repo && j.prNumber === prNumber && j.status === "running");

  const actionableThreads = threads.filter((t) => !t.isResolved && !(t.root.crStatus === "replied" || t.root.crStatus === "dismissed" || t.root.crStatus === "fixed"));
  const allSelected = actionableThreads.length > 0 && actionableThreads.every((t) => selected.has(t.root.id));

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(actionableThreads.map((t) => t.root.id)));
    }
  }

  async function handleBatchAction(action: "reply" | "resolve" | "dismiss") {
    const items = threads
      .filter((t) => selected.has(t.root.id))
      .map((t) => ({ repo, commentId: t.root.id, prNumber }));
    if (items.length === 0) return;
    setBatching(true);
    try {
      await api.batchAction(action, items);
      setSelected(new Set());
      onCommentAction();
    } catch (err) {
      console.error("Batch action failed:", err);
    } finally {
      setBatching(false);
    }
  }

  const filteredCount = threads.length;
  const totalCount = allThreads.length;
  const isFiltered = filterText !== "" || filterAction !== "all";

  return (
    <div className="border-b border-gray-800 flex-1 overflow-y-auto">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30 sticky top-0 bg-gray-950 z-10"
      >
        <span>
          Review Threads ({isFiltered ? `${filteredCount} of ${totalCount}` : totalCount})
          {resolvedCount > 0 && !isFiltered && (
            <span className="normal-case ml-2 text-gray-600">
              {openCount} open, {resolvedCount} resolved
            </span>
          )}
        </span>
        <span className="text-gray-600">{collapsed ? "▶" : "▼"}</span>
      </button>
      {!collapsed && (
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
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  filterAction === a
                    ? a === "fix" ? "bg-orange-500/30 text-orange-300"
                      : a === "reply" ? "bg-blue-500/30 text-blue-300"
                      : a === "resolve" ? "bg-green-500/30 text-green-300"
                      : "bg-gray-600 text-gray-200"
                    : "bg-gray-800 text-gray-500 hover:text-gray-300"
                }`}
              >
                {a === "all" ? "All" : a.charAt(0).toUpperCase() + a.slice(1)}
              </button>
            ))}
          </div>
          {/* Bulk action toolbar */}
          {actionableThreads.length > 0 && (
            <div className="px-6 py-1.5 flex items-center gap-3 border-b border-gray-800/50 bg-gray-900/30">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 cursor-pointer"
                title="Select all"
              />
              {selected.size > 0 ? (
                <>
                  <span className="text-xs text-gray-400">{selected.size} selected</span>
                  <button onClick={() => handleBatchAction("dismiss")} disabled={batching} className="text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded disabled:opacity-50">
                    Dismiss all
                  </button>
                  <button onClick={() => handleBatchAction("resolve")} disabled={batching} className="text-xs px-2 py-0.5 bg-green-700/60 hover:bg-green-600/60 text-green-300 rounded disabled:opacity-50">
                    Resolve all
                  </button>
                  <button onClick={() => handleBatchAction("reply")} disabled={batching} className="text-xs px-2 py-0.5 bg-blue-700/60 hover:bg-blue-600/60 text-blue-300 rounded disabled:opacity-50">
                    Reply all
                  </button>
                </>
              ) : (
                <span className="text-xs text-gray-600">Select threads for bulk actions</span>
              )}
            </div>
          )}
          <div className="px-6 pb-3 space-y-3 pt-3">
            {threads.map((thread) => {
              const isActionable = actionableThreads.some((t) => t.root.id === thread.root.id);
              return (
                <div key={thread.root.id} className="flex items-start gap-2">
                  {isActionable && (
                    <input
                      type="checkbox"
                      checked={selected.has(thread.root.id)}
                      onChange={() => toggleSelect(thread.root.id)}
                      className="mt-2 rounded border-gray-600 bg-gray-800 text-blue-500 cursor-pointer shrink-0"
                    />
                  )}
                  <div className={isActionable ? "flex-1 min-w-0" : "flex-1 min-w-0 pl-5"}>
                    <ThreadItem
                      thread={thread}
                      onSelectFile={onSelectFile}
                      repo={repo}
                      prNumber={prNumber}
                      branch={branch}
                      fixBlocked={hasRunningFix}
                      onCommentAction={onCommentAction}
                      onFixStarted={onFixStarted}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
