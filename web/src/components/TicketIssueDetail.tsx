import { useAppStore } from "../store";

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
          <div className="prose prose-invert prose-sm max-w-none text-zinc-300 whitespace-pre-wrap">
            {ticketDetail.description}
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
                <div className="text-sm text-zinc-300 whitespace-pre-wrap">{comment.body}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
