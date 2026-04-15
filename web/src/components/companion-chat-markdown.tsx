import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "../lib/utils";
import { Checkbox } from "./ui/checkbox";

/** Renders PR assistant / user chat bubbles as GitHub-flavored markdown (no raw HTML — safer for model output). */
export function CompanionChatMarkdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("text-xs leading-relaxed markdown-body", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ children, href, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline" {...props}>
              {children}
            </a>
          ),
          code: ({ children, className: codeClassName, ...props }) => {
            const isBlock = codeClassName?.startsWith("hljs") || codeClassName?.startsWith("language-");
            if (isBlock) {
              return (
                <code className={cn(codeClassName, "text-xs")} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code className="bg-black/25 px-1 py-0.5 rounded text-pink-200/90 text-[0.8em]" {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...props }) => (
            <pre className="bg-black/30 rounded p-2 my-2 overflow-x-auto text-[11px]" {...props}>
              {children}
            </pre>
          ),
          p: ({ children, ...props }) => (
            <p className="my-1.5 first:mt-0 last:mb-0" {...props}>
              {children}
            </p>
          ),
          ul: ({ children, ...props }) => (
            <ul className="list-disc list-inside my-1.5 space-y-0.5" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="list-decimal list-inside my-1.5 space-y-0.5" {...props}>
              {children}
            </ol>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote className="border-l-2 border-gray-500/60 pl-2 my-1.5 text-gray-400/95 italic" {...props}>
              {children}
            </blockquote>
          ),
          table: ({ children, ...props }) => (
            <table className="border-collapse my-2 text-[11px] w-full" {...props}>
              {children}
            </table>
          ),
          th: ({ children, ...props }) => (
            <th className="border border-gray-600/80 px-2 py-1 bg-black/20 text-left font-medium" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="border border-gray-600/80 px-2 py-1" {...props}>
              {children}
            </td>
          ),
          h1: ({ children, ...props }) => (
            <h1 className="text-sm font-bold mt-2 mb-1 first:mt-0" {...props}>
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2 className="text-sm font-semibold mt-2 mb-1 first:mt-0" {...props}>
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 className="text-xs font-semibold mt-2 mb-1 first:mt-0" {...props}>
              {children}
            </h3>
          ),
          hr: ({ ...props }) => <hr className="border-gray-600/50 my-2" {...props} />,
          input: ({ type, checked, ...props }) => {
            if (type === "checkbox") {
              return <Checkbox checked={checked ?? false} disabled className="mr-1 inline-flex align-text-bottom" />;
            }
            return <input type={type} {...props} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
