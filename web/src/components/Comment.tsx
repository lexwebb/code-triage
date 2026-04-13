import type { ReviewComment } from "../types";

interface CommentProps {
  comment: ReviewComment;
}

export default function Comment({ comment }: CommentProps) {
  const isBot = comment.author.includes("[bot]");
  const timeAgo = getTimeAgo(comment.createdAt);

  return (
    <div className="my-2 ml-8 border border-gray-700 rounded-lg bg-gray-900/80 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/50 text-xs">
        <img
          src={comment.authorAvatar}
          alt={comment.author}
          className="w-4 h-4 rounded-full"
        />
        <span className={`font-medium ${isBot ? "text-purple-400" : "text-gray-300"}`}>
          {comment.author}
        </span>
        <span className="text-gray-500">{timeAgo}</span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
        {comment.body}
      </div>
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHrs > 0) return `${diffHrs}h ago`;
  if (diffMin > 0) return `${diffMin}m ago`;
  return "just now";
}
