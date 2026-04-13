import { useState } from "react";
import type { ReviewComment } from "../types";
import { api } from "../api";
import Comment from "./Comment";

interface CommentThreadsProps {
  comments: ReviewComment[];
  onSelectFile: (filename: string) => void;
  repo: string;
  prNumber: number;
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

function ThreadItem({ thread, onSelectFile, repo, prNumber, onCommentAction }: {
  thread: Thread;
  onSelectFile: (f: string) => void;
  repo: string;
  prNumber: number;
  onCommentAction: () => void;
}) {
  const eval_ = thread.root.evaluation;
  const status = thread.root.crStatus;
  const isActedOn = status === "replied" || status === "dismissed" || status === "fixed";
  const [expanded, setExpanded] = useState(!thread.isResolved && !isActedOn);
  const [acting, setActing] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);

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

          {eval_ && !isActedOn && !thread.isResolved && (
            <div className="flex items-center gap-2 mx-1 mt-2 pt-2 border-t border-gray-800">
              {eval_.action === "reply" && eval_.reply && (
                <button
                  onClick={() => handleAction("reply")}
                  disabled={acting}
                  className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-gray-400 text-white rounded transition-colors"
                >
                  {acting ? "Sending..." : "Send Reply"}
                </button>
              )}
              {eval_.action === "fix" && (
                <button
                  disabled
                  className="text-xs px-3 py-1 bg-gray-700 text-gray-500 rounded cursor-not-allowed"
                  title="Coming soon"
                >
                  Apply Fix
                </button>
              )}
              <button
                onClick={() => handleAction("resolve")}
                disabled={acting}
                className="text-xs px-3 py-1 bg-green-600/80 hover:bg-green-500/80 disabled:bg-green-800/50 disabled:text-gray-400 text-white rounded transition-colors"
              >
                Resolve
              </button>
              <button
                onClick={() => handleAction("dismiss")}
                disabled={acting}
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

export default function CommentThreads({ comments, onSelectFile, repo, prNumber, onCommentAction }: CommentThreadsProps) {
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
              onCommentAction={onCommentAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
