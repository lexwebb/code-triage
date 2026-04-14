import ReactMarkdown from "react-markdown";
import { cn } from "../lib/utils";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { PullRequestDetail } from "../types";
import { Checkbox } from "./ui/checkbox";

interface PROverviewProps {
  pr: PullRequestDetail;
}

export default function PROverview({ pr }: PROverviewProps) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      {pr.body ? (
        <div className="text-sm text-gray-300 leading-relaxed max-w-3xl markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={{
            a: ({ children, href, ...props }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline" {...props}>{children}</a>
            ),
            code: ({ children, className, ...props }) => {
              const isBlock = className?.startsWith("language-");
              if (isBlock) return <code className={cn(className, "text-sm")} {...props}>{children}</code>;
              return <code className="bg-gray-800 px-1 py-0.5 rounded text-pink-300 text-sm" {...props}>{children}</code>;
            },
            pre: ({ children, ...props }) => (
              <pre className="bg-gray-800 rounded p-3 my-3 overflow-x-auto text-sm" {...props}>{children}</pre>
            ),
            p: ({ children, ...props }) => (
              <p className="my-2" {...props}>{children}</p>
            ),
            ul: ({ children, ...props }) => (
              <ul className="list-disc list-inside my-2 space-y-1" {...props}>{children}</ul>
            ),
            ol: ({ children, ...props }) => (
              <ol className="list-decimal list-inside my-2 space-y-1" {...props}>{children}</ol>
            ),
            blockquote: ({ children, ...props }) => (
              <blockquote className="border-l-2 border-gray-600 pl-3 my-2 text-gray-400 italic" {...props}>{children}</blockquote>
            ),
            h1: ({ children, ...props }) => (
              <h1 className="text-xl font-bold mt-6 mb-2 text-white" {...props}>{children}</h1>
            ),
            h2: ({ children, ...props }) => (
              <h2 className="text-lg font-semibold mt-5 mb-2 text-white" {...props}>{children}</h2>
            ),
            h3: ({ children, ...props }) => (
              <h3 className="text-base font-semibold mt-4 mb-1 text-white" {...props}>{children}</h3>
            ),
            hr: ({ ...props }) => (
              <hr className="border-gray-700 my-4" {...props} />
            ),
            table: ({ children, ...props }) => (
              <table className="border-collapse my-3 text-sm w-full" {...props}>{children}</table>
            ),
            th: ({ children, ...props }) => (
              <th className="border border-gray-700 px-3 py-1.5 bg-gray-800 text-left font-medium" {...props}>{children}</th>
            ),
            td: ({ children, ...props }) => (
              <td className="border border-gray-700 px-3 py-1.5" {...props}>{children}</td>
            ),
            img: ({ alt, src, ...props }) => (
              <img alt={alt} src={src} className="max-w-full rounded my-2" {...props} />
            ),
            input: ({ type, checked, ...props }) => {
              if (type === "checkbox") return <Checkbox checked={checked ?? false} disabled className="mr-1.5 inline-flex align-text-bottom" />;
              return <input type={type} {...props} />;
            },
            details: ({ children, ...props }) => (
              <details className="my-2 border border-gray-700 rounded bg-gray-800/50 open:pb-2" {...props}>{children}</details>
            ),
            summary: ({ children, ...props }) => (
              <summary className="cursor-pointer px-3 py-1.5 text-gray-300 hover:text-white font-medium select-none" {...props}>{children}</summary>
            ),
          }}>
            {pr.body}
          </ReactMarkdown>
        </div>
      ) : (
        <div className="text-gray-500 text-center mt-12">No description provided.</div>
      )}
    </div>
  );
}
