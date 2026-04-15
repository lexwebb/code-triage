import { Link, useMatchRoute } from "@tanstack/react-router";
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

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z" />
      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319Zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.421 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.421-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.318Z" />
    </svg>
  );
}

export function IconRail() {
  const hasLinearApiKey = useAppStore((s) => s.config?.hasLinearApiKey ?? false);
  const matchRoute = useMatchRoute();

  const isCodeReview = !!matchRoute({ to: "/reviews", fuzzy: true });
  const isTickets = !!matchRoute({ to: "/tickets", fuzzy: true });
  const isSettings = !!matchRoute({ to: "/settings" });

  return (
    <div className="flex flex-col items-center w-12 shrink-0 bg-zinc-900 border-r border-zinc-800 py-3 gap-2">
      <Link
        to="/reviews"
        className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
          isCodeReview
            ? "bg-zinc-700 text-white"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
        )}
        title="Code Review"
      >
        <GitPullRequestIcon />
      </Link>
      {hasLinearApiKey && (
        <Link
          to="/tickets"
          className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
            isTickets
              ? "bg-zinc-700 text-white"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          )}
          title="Tickets"
        >
          <TicketIcon />
        </Link>
      )}
      <div className="flex-1" />
      <Link
        to="/settings"
        className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
          isSettings
            ? "bg-zinc-700 text-white"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
        )}
        title="Settings"
      >
        <GearIcon />
      </Link>
    </div>
  );
}
