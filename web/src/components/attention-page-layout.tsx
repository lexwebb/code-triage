import { useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "../lib/query-keys";
import { trpcClient } from "../lib/trpc";
import { useAppStore } from "../store";
import { AttentionFeed } from "./attention-feed";
import { TeamSnapshotPanel } from "./team-snapshot-panel";

function compactSummaryLine(
  summary:
    | {
      stuck: number;
      awaitingReview: number;
      recentlyMerged: number;
      unlinkedPrs: number;
      unlinkedTickets: number;
    }
    | undefined,
): string {
  if (!summary) return "No team snapshot yet";
  const unlinked = summary.unlinkedPrs + summary.unlinkedTickets;
  return `${summary.stuck} stuck · ${summary.awaitingReview} awaiting review · ${unlinked} unlinked`;
}

export function AttentionPageLayout() {
  const queryClient = useQueryClient();
  const appGate = useAppStore((s) => s.appGate);
  const teamEnabled = useAppStore((s) => s.config?.team?.enabled !== false);

  const teamOverviewQuery = useQuery({
    queryKey: qk.team.overview,
    queryFn: () => trpcClient.teamOverview.query(),
    staleTime: 60_000,
    enabled: appGate === "ready" && teamEnabled,
  });

  async function handleTeamRefresh() {
    await trpcClient.teamOverviewRefresh.mutate();
    await queryClient.invalidateQueries({ queryKey: qk.team.overview });
  }

  if (!teamEnabled) {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AttentionFeed />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 w-full flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_320px] md:gap-4 md:p-3">
        <div className="min-h-0 md:rounded-lg md:border md:border-zinc-800 md:bg-zinc-950/60">
          <AttentionFeed />
        </div>

        <div className="border-t border-zinc-800 p-3 md:hidden">
          <details className="rounded-lg border border-zinc-800 bg-zinc-900/30">
            <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-zinc-200 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center justify-between gap-3">
                <span>Team snapshot</span>
                <span className="text-xs font-normal text-zinc-500">
                  {compactSummaryLine(teamOverviewQuery.data?.snapshot?.summaryCounts)}
                </span>
              </span>
            </summary>
            <div className="border-t border-zinc-800 p-2">
              <TeamSnapshotPanel
                data={teamOverviewQuery.data}
                loading={teamOverviewQuery.isPending}
                error={teamOverviewQuery.isError ? (teamOverviewQuery.error as Error).message : null}
                onRefresh={handleTeamRefresh}
              />
            </div>
          </details>
        </div>

        <div className="hidden min-h-0 md:block">
          <TeamSnapshotPanel
            data={teamOverviewQuery.data}
            loading={teamOverviewQuery.isPending}
            error={teamOverviewQuery.isError ? (teamOverviewQuery.error as Error).message : null}
            onRefresh={handleTeamRefresh}
          />
        </div>
      </div>
    </div>
  );
}
