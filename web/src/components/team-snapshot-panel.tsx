import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type { TeamOverviewResponse } from "../api";
import { teamManualRefreshAllowed, TEAM_MANUAL_REFRESH_COOLDOWN_MS } from "../lib/team-manual-refresh-cooldown";
import { cn } from "../lib/utils";

interface TeamSnapshotPanelProps {
  data?: TeamOverviewResponse;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

function formatCooldownMs(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return `${seconds}s`;
}

function formatUpdatedAt(updatedAtMs: number | null | undefined): string {
  if (updatedAtMs == null) return "No snapshot yet";
  const minutesAgo = Math.floor((Date.now() - updatedAtMs) / 60_000);
  if (minutesAgo <= 0) return "Updated just now";
  if (minutesAgo < 60) return `Updated ${minutesAgo}m ago`;
  return `Updated ${new Date(updatedAtMs).toLocaleString()}`;
}

function emptyState(label: string) {
  return <li className="text-xs text-zinc-600">{label}</li>;
}

export function TeamSnapshotPanel({ data, loading, error, onRefresh }: TeamSnapshotPanelProps) {
  const [lastManualRefreshMs, setLastManualRefreshMs] = useState<number | null>(null);
  const [cooldownNowMs, setCooldownNowMs] = useState<number>(() => Date.now());
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const snapshot = data?.snapshot ?? null;
  const summary = snapshot?.summaryCounts;
  const allowed = teamManualRefreshAllowed(lastManualRefreshMs, cooldownNowMs);
  const remainingCooldownMs = lastManualRefreshMs == null
    ? 0
    : Math.max(0, TEAM_MANUAL_REFRESH_COOLDOWN_MS - (cooldownNowMs - lastManualRefreshMs));

  useEffect(() => {
    if (allowed) return;
    const timeout = window.setTimeout(() => {
      setCooldownNowMs(Date.now());
    }, Math.min(remainingCooldownMs, 1_000));
    return () => window.clearTimeout(timeout);
  }, [allowed, remainingCooldownMs]);

  const summaryLine = useMemo(() => {
    if (!summary) return "No team data yet";
    return `${summary.stuck} stuck · ${summary.awaitingReview} awaiting review · ${summary.recentlyMerged} recently merged`;
  }, [summary]);

  async function handleManualRefresh() {
    if (refreshing || !allowed) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await onRefresh();
      const now = Date.now();
      setLastManualRefreshMs(now);
      setCooldownNowMs(now);
    } catch (e) {
      setRefreshError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40">
      <header className="border-b border-zinc-800 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-zinc-100">Team snapshot</h2>
            <p className="mt-1 text-xs text-zinc-500">{summaryLine}</p>
            <p className="mt-1 text-[10px] text-zinc-600">{formatUpdatedAt(data?.updatedAtMs)}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={refreshing || !allowed}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors",
              "hover:border-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-100",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            title={allowed ? "Refresh team snapshot" : `Try again in ${formatCooldownMs(remainingCooldownMs)}`}
          >
            {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
        {!allowed && !refreshing && (
          <p className="mt-2 text-[10px] text-zinc-600">
            Manual refresh available in {formatCooldownMs(remainingCooldownMs)}.
          </p>
        )}
        <div className="mt-2 text-xs">
          <Link to={"/team" as never} className="text-blue-300 hover:text-blue-200 hover:underline">
            Open team radar
          </Link>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {(error || refreshError || data?.refreshError) && (
          <div className="mb-3 flex items-start gap-2 rounded border border-red-900/80 bg-red-950/30 px-2 py-1.5 text-xs text-red-200">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            <span>{error ?? refreshError ?? data?.refreshError}</span>
          </div>
        )}

        {loading && (
          <div className="mb-3 flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 size={12} className="animate-spin" />
            Loading team snapshot...
          </div>
        )}

        {!loading && snapshot == null && (
          <p className="text-xs text-zinc-500">
            Team snapshot is enabled, but no cached snapshot is available yet.
          </p>
        )}

        {snapshot && (
          <div className="space-y-4">
            <div>
              <h3 className="text-xs font-medium text-zinc-300">Stuck ({summary?.stuck ?? snapshot.stuck.length})</h3>
              <ul className="mt-1 space-y-1">
                {snapshot.stuck.length === 0
                  ? emptyState("No stuck work")
                  : snapshot.stuck.map((item) => (
                    <li key={`${item.entityKind}:${item.entityIdentifier}`} className="text-xs text-zinc-400">
                      <span className="font-mono text-zinc-500">{item.entityIdentifier}</span>
                      {" — "}
                      {item.title}
                    </li>
                  ))}
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-medium text-zinc-300">
                Awaiting review ({summary?.awaitingReview ?? snapshot.awaitingReview.length})
              </h3>
              <ul className="mt-1 space-y-1">
                {snapshot.awaitingReview.length === 0
                  ? emptyState("No PRs waiting for review")
                  : snapshot.awaitingReview.map((pr) => (
                    <li key={`${pr.repo}#${pr.number}`} className="text-xs text-zinc-400">
                      <span className="font-mono text-zinc-500">{pr.repo}#{pr.number}</span>
                      {" — "}
                      {pr.title}
                      <span className="text-zinc-600"> ({Math.round(pr.waitHours)}h)</span>
                    </li>
                  ))}
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-medium text-zinc-300">
                Recently merged ({summary?.recentlyMerged ?? snapshot.recentlyMerged.length})
              </h3>
              <ul className="mt-1 space-y-1">
                {snapshot.recentlyMerged.length === 0
                  ? emptyState("No recent merges")
                  : snapshot.recentlyMerged.map((pr) => (
                    <li key={`${pr.repo}#${pr.number}`} className="text-xs text-zinc-400">
                      <span className="font-mono text-zinc-500">{pr.repo}#{pr.number}</span>
                      {" — "}
                      {pr.title}
                    </li>
                  ))}
              </ul>
            </div>

            <div>
              <h3 className="text-xs font-medium text-zinc-300">
                Unlinked work ({(summary?.unlinkedPrs ?? snapshot.unlinkedPrs.length) + (summary?.unlinkedTickets ?? snapshot.unlinkedTickets.length)})
              </h3>
              <ul className="mt-1 space-y-1">
                {snapshot.unlinkedPrs.map((pr) => (
                  <li key={`${pr.repo}#${pr.number}`} className="text-xs text-zinc-400">
                    <span className="font-mono text-zinc-500">PR {pr.repo}#{pr.number}</span>
                    {" — "}
                    {pr.title}
                  </li>
                ))}
                {snapshot.unlinkedTickets.map((ticket) => (
                  <li key={ticket.identifier} className="text-xs text-zinc-400">
                    <span className="font-mono text-zinc-500">Ticket {ticket.identifier}</span>
                    {" — "}
                    {ticket.title}
                  </li>
                ))}
                {snapshot.unlinkedPrs.length + snapshot.unlinkedTickets.length === 0
                  ? emptyState("Everything appears linked")
                  : null}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
