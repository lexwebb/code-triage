import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Checkbox } from "./ui/checkbox";
import { useAppStore } from "../store";

function TicketMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw]}
      components={{
        a: ({ children, href, ...props }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline" {...props}>{children}</a>
        ),
        code: ({ children, className, ...props }) => {
          const isBlock = className?.startsWith("language-");
          if (isBlock) return <code className={className} {...props}>{children}</code>;
          return <code className="bg-gray-800 px-1 py-0.5 rounded text-pink-300 text-sm" {...props}>{children}</code>;
        },
        pre: ({ children, ...props }) => (
          <pre className="bg-gray-800 rounded p-3 my-3 overflow-x-auto text-sm" {...props}>{children}</pre>
        ),
        p: ({ children, ...props }) => <p className="my-2" {...props}>{children}</p>,
        ul: ({ children, ...props }) => <ul className="list-disc list-inside my-2 space-y-1" {...props}>{children}</ul>,
        ol: ({ children, ...props }) => <ol className="list-decimal list-inside my-2 space-y-1" {...props}>{children}</ol>,
        blockquote: ({ children, ...props }) => (
          <blockquote className="border-l-2 border-gray-600 pl-3 my-2 text-gray-400 italic" {...props}>{children}</blockquote>
        ),
        h1: ({ children, ...props }) => <h1 className="text-xl font-bold mt-6 mb-2 text-white" {...props}>{children}</h1>,
        h2: ({ children, ...props }) => <h2 className="text-lg font-semibold mt-5 mb-2 text-white" {...props}>{children}</h2>,
        h3: ({ children, ...props }) => <h3 className="text-base font-semibold mt-4 mb-1 text-white" {...props}>{children}</h3>,
        hr: ({ ...props }) => <hr className="border-gray-700 my-4" {...props} />,
        table: ({ children, ...props }) => <table className="border-collapse my-3 text-sm w-full" {...props}>{children}</table>,
        th: ({ children, ...props }) => <th className="border border-gray-700 px-3 py-1.5 bg-gray-800 text-left font-medium" {...props}>{children}</th>,
        td: ({ children, ...props }) => <td className="border border-gray-700 px-3 py-1.5" {...props}>{children}</td>,
        img: ({ alt, src, ...props }) => <img alt={alt} src={src} className="max-w-full rounded my-2" {...props} />,
        input: ({ type, checked, ...props }) => {
          if (type === "checkbox") return <Checkbox checked={checked ?? false} disabled className="mr-1.5 inline-flex align-text-bottom" />;
          return <input type={type} {...props} />;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export function TicketIssueDetail() {
  const ticketDetail = useAppStore((s) => s.ticketDetail);
  const ticketDetailLoading = useAppStore((s) => s.ticketDetailLoading);
  const selectedTicket = useAppStore((s) => s.selectedTicket);
  const navigateToLinkedPR = useAppStore((s) => s.navigateToLinkedPR);

  if (!selectedTicket) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Select a ticket to view details
      </div>
    );
  }

  if (ticketDetailLoading || !ticketDetail) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading ticket…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <span className="font-mono">{ticketDetail.identifier}</span>
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: ticketDetail.state.color }}
          />
          <span>{ticketDetail.state.name}</span>
          <span className="mx-1">·</span>
          <span>{PRIORITY_LABELS[ticketDetail.priority] ?? "None"}</span>
          <a
            href={ticketDetail.providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-blue-400 hover:underline text-xs"
          >
            Open in Linear ↗
          </a>
        </div>
        <h1 className="text-lg font-semibold text-zinc-100 mt-1">{ticketDetail.title}</h1>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {ticketDetail.assignee && (
            <span className="text-xs text-zinc-400">
              {ticketDetail.assignee.name}
            </span>
          )}
          {ticketDetail.labels.map((label) => (
            <span
              key={label.name}
              className="px-1.5 py-0.5 text-xs rounded"
              style={{ backgroundColor: label.color + "20", color: label.color }}
            >
              {label.name}
            </span>
          ))}
        </div>
      </div>

      {/* Description */}
      {ticketDetail.description && (
        <div className="px-6 py-4 border-b border-zinc-800">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Description</h2>
          <div className="text-sm text-gray-300 leading-relaxed max-w-3xl markdown-body">
            <TicketMarkdown>{ticketDetail.description}</TicketMarkdown>
          </div>
        </div>
      )}

      {/* Linked PRs */}
      {ticketDetail.linkedPRs.length > 0 && (
        <div className="px-6 py-4 border-b border-zinc-800">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            Linked Pull Requests ({ticketDetail.linkedPRs.length})
          </h2>
          <div className="flex flex-col gap-1">
            {ticketDetail.linkedPRs.map((pr) => (
              <button
                key={`${pr.repo}#${pr.number}`}
                onClick={() => navigateToLinkedPR(pr.number, pr.repo)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left hover:bg-zinc-800 transition-colors"
              >
                <span className="text-blue-400 font-mono text-xs">{pr.repo}#{pr.number}</span>
                <span className="text-zinc-300 truncate">{pr.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Comments */}
      {ticketDetail.comments.length > 0 && (
        <div className="px-6 py-4">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
            Comments ({ticketDetail.comments.length})
          </h2>
          <div className="flex flex-col gap-4">
            {ticketDetail.comments.map((comment) => (
              <div key={comment.id} className="border-l-2 border-zinc-700 pl-3">
                <div className="flex items-center gap-2 text-xs text-zinc-400 mb-1">
                  <span className="font-medium text-zinc-300">{comment.author.name}</span>
                  <span>{new Date(comment.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="text-sm text-gray-300 leading-relaxed markdown-body">
                  <TicketMarkdown>{comment.body}</TicketMarkdown>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
