import { useAppStore } from "../store";
import { cn } from "../lib/utils";

function GitPullRequestIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function TicketIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3.5a1.5 1.5 0 1 0 0 3V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V9.5a1.5 1.5 0 0 0 0-3Zm11 1H4v1h8Zm-8 3h6v1H4Zm6 3H4v1h6Z" />
    </svg>
  );
}

export function IconRail() {
  const activeMode = useAppStore((s) => s.activeMode);
  const setActiveMode = useAppStore((s) => s.setActiveMode);
  const hasLinearApiKey = useAppStore((s) => s.config?.hasLinearApiKey ?? false);

  return (
    <div className="flex flex-col items-center w-12 shrink-0 bg-zinc-900 border-r border-zinc-800 py-3 gap-2">
      <button
        onClick={() => setActiveMode("code-review")}
        className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
          activeMode === "code-review"
            ? "bg-zinc-700 text-white"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
        )}
        title="Code Review"
      >
        <GitPullRequestIcon />
      </button>
      {hasLinearApiKey && (
        <button
          onClick={() => setActiveMode("tickets")}
          className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
            activeMode === "tickets"
              ? "bg-zinc-700 text-white"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          )}
          title="Tickets"
        >
          <TicketIcon />
        </button>
      )}
    </div>
  );
}
