import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import type { ReviewComment } from "../types";

interface CommentProps {
  comment: ReviewComment;
  compact?: boolean;
}

export default function Comment({ comment, compact }: CommentProps) {
  const isBot = comment.author.includes("[bot]");
  const timeAgo = getTimeAgo(comment.createdAt);

  return (
    <div className={`${compact ? "my-1" : "my-2 ml-8"} border border-gray-700 rounded-lg bg-gray-900/80 overflow-hidden`}>
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
      <div className="px-3 py-2 text-xs text-gray-300 leading-relaxed markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeHighlight]}
          components={{
            a: ({ children, href, ...props }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline" {...props}>{children}</a>
            ),
            code: ({ children, className, ...props }) => {
              const isBlock = className?.startsWith("hljs") || className?.startsWith("language-");
              if (isBlock) {
                return <code className={`${className ?? ""} text-xs`} {...props}>{children}</code>;
              }
              return <code className="bg-gray-800 px-1 py-0.5 rounded text-pink-300 text-xs" {...props}>{children}</code>;
            },
            pre: ({ children, ...props }) => (
              <pre className="bg-gray-800 rounded p-2 my-2 overflow-x-auto text-xs" {...props}>{children}</pre>
            ),
            p: ({ children, ...props }) => (
              <p className="my-1.5" {...props}>{children}</p>
            ),
            ul: ({ children, ...props }) => (
              <ul className="list-disc list-inside my-1.5 space-y-0.5" {...props}>{children}</ul>
            ),
            ol: ({ children, ...props }) => (
              <ol className="list-decimal list-inside my-1.5 space-y-0.5" {...props}>{children}</ol>
            ),
            blockquote: ({ children, ...props }) => (
              <blockquote className="border-l-2 border-gray-600 pl-2 my-1.5 text-gray-400 italic" {...props}>{children}</blockquote>
            ),
            table: ({ children, ...props }) => (
              <table className="border-collapse my-2 text-xs w-full" {...props}>{children}</table>
            ),
            th: ({ children, ...props }) => (
              <th className="border border-gray-700 px-2 py-1 bg-gray-800 text-left font-medium" {...props}>{children}</th>
            ),
            td: ({ children, ...props }) => (
              <td className="border border-gray-700 px-2 py-1" {...props}>{children}</td>
            ),
            h1: ({ children, ...props }) => (
              <h1 className="text-sm font-bold mt-3 mb-1 text-white" {...props}>{children}</h1>
            ),
            h2: ({ children, ...props }) => (
              <h2 className="text-sm font-semibold mt-2 mb-1 text-white" {...props}>{children}</h2>
            ),
            h3: ({ children, ...props }) => (
              <h3 className="text-xs font-semibold mt-2 mb-1 text-white" {...props}>{children}</h3>
            ),
            img: ({ alt, src, ...props }) => (
              <img alt={alt} src={src} className="max-w-full rounded my-1" {...props} />
            ),
            hr: ({ ...props }) => (
              <hr className="border-gray-700 my-2" {...props} />
            ),
            input: ({ type, checked, ...props }) => {
              if (type === "checkbox") {
                return <input type="checkbox" checked={checked} readOnly className="mr-1" {...props} />;
              }
              return <input type={type} {...props} />;
            },
            del: ({ children, ...props }) => (
              <del className="text-gray-500" {...props}>{children}</del>
            ),
            details: ({ children, ...props }) => (
              <details className="my-2 border border-gray-700 rounded bg-gray-800/50 open:pb-1" {...props}>{children}</details>
            ),
            summary: ({ children, ...props }) => (
              <summary className="cursor-pointer px-2 py-1 text-gray-300 hover:text-white font-medium select-none" {...props}>{children}</summary>
            ),
          }}
        >
          {comment.body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

export function getTimeAgo(dateStr: string): string {
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
