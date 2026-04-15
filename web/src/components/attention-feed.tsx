import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Clock, ExternalLink, PanelRightOpen, Pin, X } from "lucide-react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { githubPullRequestUrl } from "../lib/github-url";
import { linearIssueBrowserUrl } from "../lib/linear-url";
import type { AttentionItem } from "../api";
import type { TicketIssue } from "../types";
import { LifecycleBar, resolveAttentionLifecycleStage } from "./lifecycle-bar";
import { IconButton } from "./ui/icon-button";
import { Skeleton } from "./ui/skeleton";

const INDEFINITE_SNOOZE_UNTIL = "9999-12-31T23:59:59.999Z";

function priorityColor(priority: string): string {
  switch (priority) {
    case "high":
      return "text-red-400";
    case "medium":
      return "text-amber-400";
    case "low":
      return "text-zinc-500";
    default:
      return "text-zinc-500";
  }
}

function priorityDot(priority: string): string {
  switch (priority) {
    case "high":
      return "bg-red-400";
    case "medium":
      return "bg-amber-400";
    case "low":
      return "bg-zinc-600";
    default:
      return "bg-zinc-600";
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function parsePrEntityId(entityIdentifier: string): { owner: string; repo: string; number: string } | null {
  const match = entityIdentifier.match(/^(.+?)\/(.+?)#(\d+)$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: match[3]! };
}

function externalUrlForAttentionItem(
  item: AttentionItem,
  myTickets: TicketIssue[],
  repoLinkedTickets: TicketIssue[],
): string | null {
  if (item.entityKind === "pr") {
    const pr = parsePrEntityId(item.entityIdentifier);
    if (!pr) return null;
    return githubPullRequestUrl(`${pr.owner}/${pr.repo}`, Number(pr.number));
  }
  const ticket = [...myTickets, ...repoLinkedTickets].find((t) => t.identifier === item.entityIdentifier);
  return linearIssueBrowserUrl({ providerUrl: ticket?.providerUrl, identifier: item.entityIdentifier });
}

function SnoozeMenu({ onSnooze }: { onSnooze: (hours: number | "forever") => void }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 4, 24, 72].map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => onSnooze(h)}
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
        >
          {h < 24 ? `${h}h` : `${h / 24}d`}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onSnooze("forever")}
        className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
        title="Snooze indefinitely"
      >
        ∞
      </button>
    </div>
  );
}

function AttentionItemRow({ item }: { item: AttentionItem }) {
  const navigate = useNavigate();
  const snooze = useAppStore((s) => s.snoozeAttention);
  const dismiss = useAppStore((s) => s.dismissAttention);
  const pin = useAppStore((s) => s.pinAttention);
  const authored = useAppStore((s) => s.authored);
  const reviewRequested = useAppStore((s) => s.reviewRequested);
  const myTickets = useAppStore((s) => s.myTickets);
  const repoLinkedTickets = useAppStore((s) => s.repoLinkedTickets);
  const prToTickets = useAppStore((s) => s.prToTickets);

  const displayStage = resolveAttentionLifecycleStage(item, {
    prToTickets,
    openPulls: [...authored, ...reviewRequested],
    myTickets,
    repoLinkedTickets,
  });

  const handleOpenInApp = () => {
    if (item.entityKind === "pr") {
      const pr = parsePrEntityId(item.entityIdentifier);
      if (!pr) return;
      void navigate({
        to: "/reviews/$owner/$repo/pull/$number",
        params: { owner: pr.owner, repo: pr.repo, number: pr.number },
        search: { tab: "threads", file: undefined },
      });
      return;
    }
    void navigate({ to: "/tickets/$ticketId", params: { ticketId: item.entityIdentifier } });
  };

  const externalHref = externalUrlForAttentionItem(item, myTickets, repoLinkedTickets);

  const handleSnooze = (hours: number | "forever") => {
    const until = hours === "forever"
      ? INDEFINITE_SNOOZE_UNTIL
      : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    void snooze(item.id, until);
  };

  const entityTitle = (() => {
    if (item.entityKind === "pr") {
      const pr = [...authored, ...reviewRequested].find(
        (p) => `${p.repo}#${p.number}` === item.entityIdentifier,
      );
      return pr?.title;
    }
    const ticket = [...myTickets, ...repoLinkedTickets].find(
      (t) => t.identifier === item.entityIdentifier,
    );
    return ticket?.title;
  })();

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-zinc-800 px-4 py-3 transition-colors hover:bg-zinc-900/50",
        item.pinned && "border-l-2 border-l-blue-500 bg-zinc-900/30",
      )}
    >
      <div className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", priorityDot(item.priority))} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={handleOpenInApp}
          className="text-left text-sm text-zinc-200 transition-colors hover:text-white"
        >
          {item.title}
        </button>
        <div className="mt-1 flex items-center gap-2">
          <span className={cn("font-mono text-[10px]", priorityColor(item.priority))}>{item.entityIdentifier}</span>
          <span className="text-[10px] text-zinc-600">{timeAgo(item.firstSeenAt)}</span>
          {displayStage && (
            <LifecycleBar
              currentStage={displayStage}
              stuck={Boolean(item.stuckSince)}
              compact
            />
          )}
        </div>
        {entityTitle && (
          <div className="mt-1 truncate text-xs text-zinc-500">
            {entityTitle}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <SnoozeMenu onSnooze={handleSnooze} />
        <IconButton
          description={item.pinned ? "Unpin" : "Pin"}
          icon={<Pin size={12} className={item.pinned ? "fill-blue-400 text-blue-400" : ""} />}
          onClick={() => void pin(item.id)}
          size="sm"
        />
        <IconButton
          description="Dismiss"
          icon={<X size={12} />}
          onClick={() => void dismiss(item.id)}
          size="sm"
        />
        <IconButton
          description="Open in app"
          icon={<PanelRightOpen size={12} />}
          onClick={handleOpenInApp}
          size="sm"
        />
        {externalHref ? (
          <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "inline-flex cursor-pointer items-center justify-center rounded p-1 transition-colors",
              "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
            )}
            title="Open in browser"
            aria-label="Open in browser"
          >
            <ExternalLink size={12} />
            <span className="sr-only">Open in browser</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function AttentionFeed() {
  const items = useAppStore((s) => s.attentionItems);
  const loading = useAppStore((s) => s.attentionLoading);
  const error = useAppStore((s) => s.attentionError);
  const fetchAttention = useAppStore((s) => s.fetchAttention);

  useEffect(() => {
    void fetchAttention();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && items.length === 0) {
    return (
      <div className="flex h-full w-full flex-1 flex-col overflow-y-auto">
        <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-2 h-3 w-16" />
        </div>
        <div className="space-y-2 px-4 py-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-400">
        Error: {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-500">
        <Clock size={32} className="text-zinc-700" />
        <span className="text-sm">Nothing needs your attention right now</span>
      </div>
    );
  }

  const pinned = items.filter((i) => i.pinned);
  const unpinned = items.filter((i) => !i.pinned);

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-y-auto">
      <div className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-200">Needs Your Attention</h2>
        <span className="text-[10px] text-zinc-600">
          {items.length} item{items.length !== 1 ? "s" : ""}
        </span>
      </div>
      {loading && (
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/30 px-4 py-2">
          <Skeleton className="h-2 w-full rounded-full" />
        </div>
      )}
      {pinned.length > 0 && (
        <>
          <div className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-1 text-[10px] uppercase tracking-wide text-zinc-600">
            Pinned
          </div>
          {pinned.map((item) => (
            <AttentionItemRow key={item.id} item={item} />
          ))}
        </>
      )}
      {unpinned.map((item) => (
        <AttentionItemRow key={item.id} item={item} />
      ))}
    </div>
  );
}
