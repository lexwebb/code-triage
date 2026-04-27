import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { Route as rootRoute } from "./__root";
import { qk } from "../lib/query-keys";
import { trpcClient } from "../lib/trpc";
import { useAppStore } from "../store";
import { TeamSnapshotPanel } from "../components/team-snapshot-panel";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "team",
  component: function TeamRadarPage() {
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
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <p className="text-sm text-zinc-300">Team snapshot and radar are turned off in settings.</p>
          <p className="mt-2 text-sm">
            <Link to="/settings" className="text-blue-300 hover:text-blue-200 hover:underline">
              Open settings
            </Link>
            {" · "}
            <Link to="/attention" className="text-blue-300 hover:text-blue-200 hover:underline">
              Back to attention
            </Link>
          </p>
        </div>
      );
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
        <div className="mb-3 flex shrink-0 items-center gap-2">
          <Users size={18} className="text-cyan-300" />
          <h2 className="text-base font-semibold text-white">Team radar</h2>
        </div>
        <div className="min-h-0 flex-1">
          <TeamSnapshotPanel
            data={teamOverviewQuery.data}
            loading={teamOverviewQuery.isPending}
            error={teamOverviewQuery.isError ? (teamOverviewQuery.error as Error).message : null}
            onRefresh={handleTeamRefresh}
            showRadarLink={false}
            showMemberSummary
          />
        </div>
      </div>
    );
  },
});
