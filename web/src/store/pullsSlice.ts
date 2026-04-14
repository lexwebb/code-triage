import { api } from "../api";
import type { SliceCreator, PullsSlice } from "./types";

export const createPullsSlice: SliceCreator<PullsSlice> = (set, get) => ({
  authored: [],
  reviewRequested: [],
  repoFilter: "",
  pullsLoading: true,
  pullsRefreshing: false,
  githubUserUnavailable: false,
  pullFetchGeneration: 0,
  _fetchInFlight: null,

  fetchPulls: async (isInitial = false, resetRepoPollOnRefresh = false) => {
    // Coalesce overlapping fetches
    const existing = get()._fetchInFlight;
    if (existing) return existing;

    const run = (async () => {
      if (!isInitial) set({ pullsRefreshing: true });
      try {
        if (resetRepoPollOnRefresh) {
          await api.clearRepoPollSchedule();
        }
        const { authored, reviewRequested, githubUserUnavailable } =
          await api.getPullsBundle();
        set((s) => ({
          authored,
          reviewRequested,
          githubUserUnavailable: githubUserUnavailable === true,
          pullFetchGeneration: s.pullFetchGeneration + 1,
        }));

        if (isInitial) {
          const current = get().selectedPR;
          if (current) {
            // URL had a PR route — load its detail now that pulls are ready
            void get().selectPR(current.number, current.repo);
          } else if (authored.length > 0) {
            // No PR in URL — auto-select first authored PR
            void get().selectPR(authored[0].number, authored[0].repo);
          }
        }
      } catch (err) {
        if (isInitial) set({ error: (err as Error).message });
      } finally {
        if (isInitial) set({ pullsLoading: false });
        set({ pullsRefreshing: false });
      }
    })();

    set({ _fetchInFlight: run });
    try {
      await run;
    } finally {
      set({ _fetchInFlight: null });
    }
  },

  setRepoFilter: (filter) => set({ repoFilter: filter }),
});
