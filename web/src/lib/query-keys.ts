import type { QueryClient } from "@tanstack/react-query";

export const qk = {
  pulls: {
    root: ["pulls"] as const,
    bundle: (repoFilter: string) => ["pulls", "bundle", repoFilter] as const,
  },
  pull: {
    root: (repo: string, n: number) => ["pull", repo, n] as const,
    detail: (repo: string, n: number) => [...qk.pull.root(repo, n), "detail"] as const,
    files: (repo: string, n: number) => [...qk.pull.root(repo, n), "files"] as const,
    comments: (repo: string, n: number, autoEval: boolean) =>
      [...qk.pull.root(repo, n), "comments", autoEval] as const,
    checks: (repo: string, n: number, sha: string) =>
      [...qk.pull.root(repo, n), "checks", sha] as const,
  },
  attention: {
    root: ["attention"] as const,
    list: (all: boolean) => ["attention", "list", all] as const,
  },
  tickets: {
    root: ["tickets"] as const,
    bundle: ["tickets", "bundle"] as const,
    detail: (id: string) => ["tickets", "detail", id] as const,
  },
} as const;

export function invalidatePullBundleQueries(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.pulls.root });
}

export function invalidatePrPullQueries(qc: QueryClient, repo: string, n: number): Promise<void> {
  return qc.invalidateQueries({ queryKey: qk.pull.root(repo, n) });
}
