import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import { qk } from "../lib/query-keys";
import { useAppStore } from "../store";

/**
 * Keeps TanStack Query as the source of truth for pulls bundle + attention;
 * mirrors into Zustand so existing selectors and PR detail logic keep working.
 */
export function useServerQuerySync() {
  const appGate = useAppStore((s) => s.appGate);
  const repoFilter = useAppStore((s) => s.repoFilter);
  const teamEnabled = useAppStore((s) => s.config?.team?.enabled === true);

  const pullsQuery = useQuery({
    queryKey: qk.pulls.bundle(repoFilter),
    queryFn: () => api.getPullsBundle(repoFilter || undefined),
    staleTime: 20_000,
    enabled: appGate === "ready",
  });

  const attentionQuery = useQuery({
    queryKey: qk.attention.list(false),
    queryFn: () => api.getAttentionItems(),
    staleTime: 15_000,
    enabled: appGate === "ready",
  });

  useQuery({
    queryKey: qk.team.overview,
    queryFn: () => api.getTeamOverview(),
    staleTime: 60_000,
    enabled: appGate === "ready" && teamEnabled,
  });

  useEffect(() => {
    const d = pullsQuery.data;
    if (d) {
      useAppStore.setState({
        authored: d.authored,
        reviewRequested: d.reviewRequested,
        githubUserUnavailable: d.githubUserUnavailable === true,
      });
    }
  }, [pullsQuery.data]);

  useEffect(() => {
    if (appGate !== "ready") return;
    useAppStore.setState({
      pullsLoading: pullsQuery.isPending,
      pullsRefreshing: pullsQuery.isFetching && !pullsQuery.isPending,
    });
  }, [appGate, pullsQuery.isPending, pullsQuery.isFetching]);

  useEffect(() => {
    if (pullsQuery.isError && appGate === "ready") {
      useAppStore.setState({ error: (pullsQuery.error as Error).message });
    }
  }, [pullsQuery.isError, pullsQuery.error, appGate]);

  useEffect(() => {
    useAppStore.setState({
      attentionItems: attentionQuery.data ?? [],
      attentionLoading: attentionQuery.isPending,
      attentionError: attentionQuery.isError ? (attentionQuery.error as Error).message : null,
    });
  }, [attentionQuery.data, attentionQuery.isPending, attentionQuery.isError, attentionQuery.error]);

  useEffect(() => {
    if (!pullsQuery.isSuccess || !pullsQuery.data) return;
    const path = window.location.pathname;
    const onReviewsRoute = path === "/reviews" || path.startsWith("/reviews/");
    if (!onReviewsRoute) return;
    const st = useAppStore.getState();
    if (st.selectedPR) {
      void st.selectPR(st.selectedPR.number, st.selectedPR.repo);
    }
  }, [pullsQuery.isSuccess, pullsQuery.data]);

}
