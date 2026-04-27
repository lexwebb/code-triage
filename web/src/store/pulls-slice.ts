import { getQueryClient } from "../lib/query-client";
import { qk } from "../lib/query-keys";
import { trpcClient } from "../lib/trpc";
import type { SliceCreator, PullsSlice } from "./types";

export const createPullsSlice: SliceCreator<PullsSlice> = (set, get) => ({
  authored: [],
  reviewRequested: [],
  repoFilter: "",
  pullsLoading: true,
  pullsRefreshing: false,
  githubUserUnavailable: false,

  fetchPulls: async (_isInitial = false, resetRepoPollOnRefresh = false) => {
    if (resetRepoPollOnRefresh) {
      await trpcClient.clearRepoPollScheduleAction.mutate();
    }
    const qc = getQueryClient();
    const filter = get().repoFilter;
    await qc.refetchQueries({ queryKey: qk.pulls.bundle(filter) });
    await qc.invalidateQueries({ queryKey: qk.attention.root });
  },

  setRepoFilter: (filter) => set({ repoFilter: filter }),
});
