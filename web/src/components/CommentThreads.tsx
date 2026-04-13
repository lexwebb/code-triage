import { useState } from "react";
import type { ReviewComment } from "../types";
import Comment from "./Comment";

interface CommentThreadsProps {
  comments: ReviewComment[];
  onSelectFile: (filename: string) => void;
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
    // Thread is resolved if root or any comment in it is marked resolved
    const isResolved = root.isResolved || replies.some((r) => r.isResolved);
    return { root, replies, isResolved };
  });

  // Sort: open threads first, then resolved
  threads.sort((a, b) => {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
    return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
  });

  return threads;
}

function ThreadItem({ thread, onSelectFile }: { thread: Thread; onSelectFile: (f: string) => void }) {
  const [expanded, setExpanded] = useState(!thread.isResolved);

  return (
    <div className={`border rounded-lg overflow-hidden ${thread.isResolved ? "border-gray-800/50 opacity-70" : "border-gray-800"}`}>
      <button
        onClick={() => thread.isResolved ? setExpanded(!expanded) : onSelectFile(thread.root.path)}
        className="w-full px-3 py-1.5 bg-gray-800/50 text-left text-xs font-mono flex items-center justify-between hover:bg-gray-800/80 transition-colors"
      >
        <span className={thread.isResolved ? "text-gray-500" : "text-blue-400 hover:text-blue-300"}>
          {thread.root.path}:{thread.root.line}
        </span>
        <span className="flex items-center gap-2">
          {thread.isResolved && (
            <span className="text-green-500/70 text-xs font-sans">Resolved</span>
          )}
          {thread.isResolved && (
            <span className="text-gray-600 text-xs">{expanded ? "▼" : "▶"}</span>
          )}
        </span>
      </button>
      {!thread.isResolved && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-3 py-0.5 bg-gray-800/30 text-right text-xs text-gray-600 hover:text-gray-400"
        >
          {expanded ? "collapse" : "expand"}
        </button>
      )}
      {expanded && (
        <div className="p-2 space-y-0">
          <Comment comment={thread.root} compact />
          {thread.replies.map((reply) => (
            <Comment key={reply.id} comment={reply} compact />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CommentThreads({ comments, onSelectFile }: CommentThreadsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const threads = buildThreads(comments);

  if (threads.length === 0) return null;

  const openCount = threads.filter((t) => !t.isResolved).length;
  const resolvedCount = threads.filter((t) => t.isResolved).length;

  return (
    <div className="border-b border-gray-800">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30"
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
        <div className="px-6 pb-3 max-h-80 overflow-y-auto space-y-3">
          {threads.map((thread) => (
            <ThreadItem
              key={thread.root.id}
              thread={thread}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
