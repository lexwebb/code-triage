import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Link2Off,
  Loader2,
  OctagonAlert,
  PanelRightOpen,
  RefreshCw,
  Ticket,
  TriangleAlert,
} from "lucide-react";
import type { TeamOverviewResponse, TeamOverviewSnapshot } from "../api";
import { githubPullRequestUrl } from "../lib/github-url";
import { linearIssueBrowserUrl } from "../lib/linear-url";
import { teamManualRefreshAllowed, TEAM_MANUAL_REFRESH_COOLDOWN_MS } from "../lib/team-manual-refresh-cooldown";
import { cn } from "../lib/utils";
import { LifecycleBar, coerceLifecycleStage, type LifecycleStage } from "./lifecycle-bar";

interface TeamSnapshotPanelProps {
  data?: TeamOverviewResponse;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  /** When false, hides the link to the full-page team radar (e.g. on `/team`). Default true. */
  showRadarLink?: boolean;
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

/** Human-readable wait; caps absurd server values so the UI stays sane. */
function formatWaitHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "Waiting";
  if (h > 24 * 90) return "90d+";
  if (h >= 72) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return "<1h";
}

function mergedAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const ms = Date.now() - t;
  if (ms < 0) return "just now";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function parseStuckPrId(entityIdentifier: string): { repo: string; number: number } | null {
  const m = entityIdentifier.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

const accentStyles = {
  amber: {
    bar: "border-l-amber-500",
    icon: "text-amber-400",
    dot: "bg-amber-400",
    pill: "bg-amber-500/15 text-amber-200/95 ring-1 ring-amber-500/25",
  },
  sky: {
    bar: "border-l-sky-500",
    icon: "text-sky-400",
    dot: "bg-sky-400",
    pill: "bg-sky-500/15 text-sky-200/95 ring-1 ring-sky-500/25",
  },
  emerald: {
    bar: "border-l-emerald-500",
    icon: "text-emerald-400",
    dot: "bg-emerald-400",
    pill: "bg-emerald-500/15 text-emerald-200/95 ring-1 ring-emerald-500/25",
  },
  violet: {
    bar: "border-l-violet-500",
    icon: "text-violet-400",
    dot: "bg-violet-400",
    pill: "bg-violet-500/15 text-violet-200/95 ring-1 ring-violet-500/25",
  },
} as const;

type Accent = keyof typeof accentStyles;

function snapshotLifecycleStage(raw?: string): LifecycleStage | undefined {
  if (!raw) return undefined;
  return coerceLifecycleStage(raw) ?? (raw as LifecycleStage);
}

function RowMeta({
  lifecycleStage,
  lifecycleStuck,
  actorKind,
  actorLabel,
}: {
  lifecycleStage?: string;
  lifecycleStuck?: boolean;
  actorKind?: "author" | "assignee";
  actorLabel?: string;
}) {
  const stage = snapshotLifecycleStage(lifecycleStage);
  const showActor = Boolean(actorKind && actorLabel);
  if (!stage && !showActor) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
      {stage ? (
        <LifecycleBar
          currentStage={stage}
          stuck={Boolean(lifecycleStuck)}
          compact
          className="shrink-0"
        />
      ) : null}
      {showActor ? (
        <span className="text-[10px] text-zinc-500">
          {actorKind === "assignee" ? "Assignee" : "Author"}
          <span className="text-zinc-600"> · </span>
          <span className="text-zinc-400">{actorLabel}</span>
        </span>
      ) : null}
    </div>
  );
}

function SnapshotSection({
  title,
  count,
  icon: Icon,
  accent,
  children,
}: {
  title: string;
  count: number;
  icon: typeof GitMerge;
  accent: Accent;
  children: ReactNode;
}) {
  const a = accentStyles[accent];
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-zinc-800/90 bg-zinc-950/50",
        "border-l-[3px]",
        a.bar,
      )}
    >
      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/20 px-3 py-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", a.icon)} strokeWidth={2.25} />
        <h3 className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
          {title}
        </h3>
        <span className="shrink-0 rounded-full bg-zinc-800/90 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-300">
          {count}
        </span>
      </div>
      <div className="px-1.5 py-1">{children}</div>
    </section>
  );
}

const rowActionBtn =
  "mt-0.5 shrink-0 rounded p-1 text-zinc-500 opacity-50 transition-all hover:bg-zinc-800 hover:text-zinc-300 hover:opacity-100 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-zinc-600";

function RowChrome({
  accent,
  children,
  footer,
  externalHref,
  externalLabel = "Open on GitHub",
  onOpenInApp,
  inAppLabel = "Open in app",
}: {
  accent: Accent;
  children: ReactNode;
  footer?: ReactNode;
  externalHref?: string | null;
  externalLabel?: string;
  onOpenInApp?: (() => void) | null;
  inAppLabel?: string;
}) {
  const dot = accentStyles[accent].dot;
  const showActions = Boolean(onOpenInApp || externalHref);
  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-zinc-900/55">
      <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        {onOpenInApp ? (
          <button
            type="button"
            onClick={onOpenInApp}
            className="w-full rounded-sm text-left outline-none transition-colors hover:bg-zinc-900/50 focus-visible:ring-1 focus-visible:ring-zinc-600"
          >
            {children}
          </button>
        ) : (
          children
        )}
        {footer}
      </div>
      <div className={cn("flex shrink-0 items-start gap-0.5", !showActions && "w-7")}>
        {onOpenInApp ? (
          <button
            type="button"
            onClick={onOpenInApp}
            className={rowActionBtn}
            title={inAppLabel}
            aria-label={inAppLabel}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {externalHref ? (
          <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            className={rowActionBtn}
            title={externalLabel}
            aria-label={externalLabel}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function emptyRow(label: string) {
  return (
    <p className="px-2 py-3 text-center text-xs text-zinc-600">{label}</p>
  );
}

export function TeamSnapshotPanel({
  data,
  loading,
  error,
  onRefresh,
  showRadarLink = true,
}: TeamSnapshotPanelProps) {
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
    const u = summary.unlinkedPrs + summary.unlinkedTickets;
    return `${summary.stuck} stuck · ${summary.awaitingReview} review · ${summary.recentlyMerged} merged · ${u} unlinked`;
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
      <header className="shrink-0 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight text-zinc-100">Team snapshot</h2>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{summaryLine}</p>
            {summary && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span className={cn("rounded-md px-2 py-0.5 text-[10px] font-medium", accentStyles.amber.pill)}>
                  {summary.stuck} stuck
                </span>
                <span className={cn("rounded-md px-2 py-0.5 text-[10px] font-medium", accentStyles.sky.pill)}>
                  {summary.awaitingReview} review
                </span>
                <span className={cn("rounded-md px-2 py-0.5 text-[10px] font-medium", accentStyles.emerald.pill)}>
                  {summary.recentlyMerged} merged
                </span>
                {(summary.unlinkedPrs + summary.unlinkedTickets) > 0 && (
                  <span className={cn("rounded-md px-2 py-0.5 text-[10px] font-medium", accentStyles.violet.pill)}>
                    {summary.unlinkedPrs + summary.unlinkedTickets} unlinked
                  </span>
                )}
              </div>
            )}
            <p className="mt-2 text-[10px] text-zinc-600">{formatUpdatedAt(data?.updatedAtMs)}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={refreshing || !allowed}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors",
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
        {showRadarLink && (
          <div className="mt-2 text-xs">
            <Link to="/team" className="text-blue-300 hover:text-blue-200 hover:underline">
              Open team radar
            </Link>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {(error || refreshError || data?.refreshError) && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-red-900/80 bg-red-950/30 px-2.5 py-2 text-xs text-red-200">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
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
          <SnapshotBody snapshot={snapshot} summary={summary} />
        )}
      </div>
    </section>
  );
}

function SnapshotBody({
  snapshot,
  summary,
}: {
  snapshot: TeamOverviewSnapshot;
  summary: TeamOverviewSnapshot["summaryCounts"] | undefined;
}) {
  const navigate = useNavigate();

  const openPrInApp = (repo: string, number: number) => {
    const idx = repo.indexOf("/");
    if (idx <= 0) return;
    const owner = repo.slice(0, idx);
    const repoName = repo.slice(idx + 1);
    void navigate({
      to: "/reviews/$owner/$repo/pull/$number",
      params: { owner, repo: repoName, number: String(number) },
      search: { tab: "threads", file: undefined },
    });
  };

  const openTicketInApp = (identifier: string) => {
    void navigate({ to: "/tickets/$ticketId", params: { ticketId: identifier } });
  };

  return (
    <div className="flex flex-col gap-3">
      <SnapshotSection
        title="Stuck"
        count={summary?.stuck ?? snapshot.stuck.length}
        icon={OctagonAlert}
        accent="amber"
      >
        {snapshot.stuck.length === 0
          ? emptyRow("No stuck work")
          : (
            <ul className="divide-y divide-zinc-800/60">
              {snapshot.stuck.map((item) => {
                const pr = item.entityKind === "pr" ? parseStuckPrId(item.entityIdentifier) : null;
                const gh = pr ? githubPullRequestUrl(pr.repo, pr.number) : null;
                const linearHref =
                  item.entityKind === "ticket"
                    ? linearIssueBrowserUrl({ providerUrl: item.providerUrl, identifier: item.entityIdentifier })
                    : null;
                const externalHref = gh ?? linearHref;
                const externalLabel = gh
                  ? `Open ${item.entityIdentifier} on GitHub`
                  : linearHref
                    ? "Open in Linear"
                    : "Open externally";
                return (
                  <li key={`${item.entityKind}:${item.entityIdentifier}`} className="list-none">
                    <RowChrome
                      accent="amber"
                      externalHref={externalHref}
                      externalLabel={externalLabel}
                      onOpenInApp={
                        item.entityKind === "pr" && pr
                          ? () => openPrInApp(pr.repo, pr.number)
                          : item.entityKind === "ticket"
                            ? () => openTicketInApp(item.entityIdentifier)
                            : null
                      }
                      footer={
                        <RowMeta
                          lifecycleStage={item.lifecycleStage}
                          lifecycleStuck={item.lifecycleStuck}
                          actorKind={item.entityKind === "ticket" ? "assignee" : "author"}
                          actorLabel={item.actorLabel}
                        />
                      }
                    >
                      <p className="text-sm font-medium leading-snug text-zinc-200">{item.title}</p>
                      <p className="mt-1 font-mono text-[11px] text-zinc-500">{item.entityIdentifier}</p>
                    </RowChrome>
                  </li>
                );
              })}
            </ul>
          )}
      </SnapshotSection>

      <SnapshotSection
        title="Awaiting review"
        count={summary?.awaitingReview ?? snapshot.awaitingReview.length}
        icon={GitPullRequest}
        accent="sky"
      >
        {snapshot.awaitingReview.length === 0
          ? emptyRow("No PRs waiting for review")
          : (
            <ul className="divide-y divide-zinc-800/60">
              {snapshot.awaitingReview.map((pr) => {
                const gh = githubPullRequestUrl(pr.repo, pr.number);
                const wait = formatWaitHours(pr.waitHours);
                return (
                  <li key={`${pr.repo}#${pr.number}`} className="list-none">
                    <RowChrome
                      accent="sky"
                      externalHref={gh}
                      externalLabel={gh ? `Open ${pr.repo}#${pr.number} on GitHub` : "Open on GitHub"}
                      onOpenInApp={() => openPrInApp(pr.repo, pr.number)}
                      footer={
                        <RowMeta
                          lifecycleStage={pr.lifecycleStage}
                          lifecycleStuck={pr.lifecycleStuck}
                          actorKind="author"
                          actorLabel={pr.actorLabel}
                        />
                      }
                    >
                      <p className="text-sm font-medium leading-snug text-zinc-200">{pr.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-mono text-[11px] text-zinc-500">
                          {pr.repo}
                          <span className="text-zinc-600">#{pr.number}</span>
                        </span>
                        <span className="rounded bg-zinc-800/90 px-1.5 py-px text-[10px] font-medium text-zinc-400">
                          {wait}
                        </span>
                      </div>
                    </RowChrome>
                  </li>
                );
              })}
            </ul>
          )}
      </SnapshotSection>

      <SnapshotSection
        title="Recently merged"
        count={summary?.recentlyMerged ?? snapshot.recentlyMerged.length}
        icon={GitMerge}
        accent="emerald"
      >
        {snapshot.recentlyMerged.length === 0
          ? emptyRow("No recent merges")
          : (
            <ul className="divide-y divide-zinc-800/60">
              {snapshot.recentlyMerged.map((pr) => {
                const gh = githubPullRequestUrl(pr.repo, pr.number);
                const when = mergedAgo(pr.mergedAt);
                return (
                  <li key={`${pr.repo}#${pr.number}`} className="list-none">
                    <RowChrome
                      accent="emerald"
                      externalHref={gh}
                      externalLabel={gh ? `Open ${pr.repo}#${pr.number} on GitHub` : "Open on GitHub"}
                      onOpenInApp={() => openPrInApp(pr.repo, pr.number)}
                      footer={
                        <RowMeta
                          lifecycleStage={pr.lifecycleStage}
                          lifecycleStuck={pr.lifecycleStuck}
                          actorKind="author"
                          actorLabel={pr.actorLabel}
                        />
                      }
                    >
                      <p className="text-sm font-medium leading-snug text-zinc-200">{pr.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-mono text-[11px] text-zinc-500">
                          {pr.repo}
                          <span className="text-zinc-600">#{pr.number}</span>
                        </span>
                        {when ? (
                          <span className="text-[10px] text-zinc-600">{when}</span>
                        ) : null}
                      </div>
                    </RowChrome>
                  </li>
                );
              })}
            </ul>
          )}
      </SnapshotSection>

      <SnapshotSection
        title="Unlinked work"
        count={(summary?.unlinkedPrs ?? snapshot.unlinkedPrs.length) + (summary?.unlinkedTickets ?? snapshot.unlinkedTickets.length)}
        icon={Link2Off}
        accent="violet"
      >
        {snapshot.unlinkedPrs.length + snapshot.unlinkedTickets.length === 0
          ? emptyRow("Everything appears linked")
          : (
            <ul className="divide-y divide-zinc-800/60">
              {snapshot.unlinkedPrs.map((pr) => {
                const gh = githubPullRequestUrl(pr.repo, pr.number);
                return (
                  <li key={`${pr.repo}#${pr.number}`} className="list-none">
                    <RowChrome
                      accent="violet"
                      externalHref={gh}
                      externalLabel={gh ? "Open PR on GitHub" : "Open on GitHub"}
                      onOpenInApp={() => openPrInApp(pr.repo, pr.number)}
                      footer={
                        <RowMeta
                          lifecycleStage={pr.lifecycleStage}
                          lifecycleStuck={pr.lifecycleStuck}
                          actorKind="author"
                          actorLabel={pr.actorLabel}
                        />
                      }
                    >
                      <p className="text-sm font-medium leading-snug text-zinc-200">{pr.title}</p>
                      <p className="mt-1 font-mono text-[11px] text-zinc-500">
                        PR {pr.repo}#{pr.number}
                      </p>
                    </RowChrome>
                  </li>
                );
              })}
              {snapshot.unlinkedTickets.map((ticket) => {
                const linearHref = linearIssueBrowserUrl({
                  providerUrl: ticket.providerUrl,
                  identifier: ticket.identifier,
                });
                return (
                  <li key={ticket.identifier} className="list-none">
                    <RowChrome
                      accent="violet"
                      externalHref={linearHref}
                      externalLabel={linearHref ? "Open in Linear" : "Open externally"}
                      onOpenInApp={() => openTicketInApp(ticket.identifier)}
                      footer={
                        <RowMeta
                          lifecycleStage={ticket.lifecycleStage}
                          lifecycleStuck={ticket.lifecycleStuck}
                          actorKind="assignee"
                          actorLabel={ticket.actorLabel}
                        />
                      }
                    >
                      <p className="text-sm font-medium leading-snug text-zinc-200">{ticket.title}</p>
                      <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                        <Ticket className="h-3 w-3 text-zinc-600" strokeWidth={2} />
                        {ticket.identifier}
                      </p>
                    </RowChrome>
                  </li>
                );
              })}
            </ul>
          )}
      </SnapshotSection>
    </div>
  );
}
