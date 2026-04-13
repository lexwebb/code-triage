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

  const threads: Thread[] = rootComments.map((root) => ({
    root,
    replies: (replyMap.get(root.id) ?? []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    ),
  }));

  threads.sort(
    (a, b) => new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime(),
  );

  return threads;
}

export default function CommentThreads({ comments, onSelectFile }: CommentThreadsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const threads = buildThreads(comments);

  if (threads.length === 0) return null;

  return (
    <div className="border-b border-gray-800">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30"
      >
        <span>Review Threads ({threads.length})</span>
        <span className="text-gray-600">{collapsed ? "▶" : "▼"}</span>
      </button>
      {!collapsed && (
        <div className="px-6 pb-3 max-h-80 overflow-y-auto space-y-3">
          {threads.map((thread) => (
            <div key={thread.root.id} className="border border-gray-800 rounded-lg overflow-hidden">
              <button
                onClick={() => onSelectFile(thread.root.path)}
                className="w-full px-3 py-1.5 bg-gray-800/50 text-left text-xs font-mono text-blue-400 hover:text-blue-300 hover:bg-gray-800/80 transition-colors"
              >
                {thread.root.path}:{thread.root.line}
              </button>
              <div className="p-2 space-y-0">
                <Comment comment={thread.root} compact />
                {thread.replies.map((reply) => (
                  <Comment key={reply.id} comment={reply} compact />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
