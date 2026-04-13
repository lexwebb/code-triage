import type { User, RepoInfo, PullRequest, PullRequestDetail, PullFile, ReviewComment, CrWatchState } from "./types";

const BASE = "";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function postJSON<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function repoQuery(repo?: string): string {
  return repo ? `?repo=${encodeURIComponent(repo)}` : "";
}

function repoQueryRequired(repo: string): string {
  return `?repo=${encodeURIComponent(repo)}`;
}

export const api = {
  getUser: () => fetchJSON<User>("/api/user"),
  getRepos: () => fetchJSON<RepoInfo[]>("/api/repos"),
  getPulls: (repo?: string) => fetchJSON<PullRequest[]>(`/api/pulls${repoQuery(repo)}`),
  getReviewRequested: (repo?: string) => fetchJSON<PullRequest[]>(`/api/pulls/review-requested${repoQuery(repo)}`),
  getPull: (number: number, repo: string) => fetchJSON<PullRequestDetail>(`/api/pulls/${number}${repoQueryRequired(repo)}`),
  getPullFiles: (number: number, repo: string) => fetchJSON<PullFile[]>(`/api/pulls/${number}/files${repoQueryRequired(repo)}`),
  getPullComments: (number: number, repo: string) => fetchJSON<ReviewComment[]>(`/api/pulls/${number}/comments${repoQueryRequired(repo)}`),
  getFileContent: (prNumber: number, path: string, repo: string) => fetchJSON<{ content: string; path: string }>(`/api/pulls/${prNumber}/files/${path}${repoQueryRequired(repo)}`),
  getState: () => fetchJSON<CrWatchState>("/api/state"),
  getPollStatus: () => fetchJSON<{ lastPoll: number; nextPoll: number; intervalMs: number; polling: boolean }>("/api/poll-status"),
  replyToComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/reply", { repo, commentId, prNumber }),
  resolveComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/resolve", { repo, commentId, prNumber }),
  dismissComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/dismiss", { repo, commentId, prNumber }),
  fixWithClaude: (repo: string, commentId: number, prNumber: number, branch: string, comment: { path: string; line: number; body: string; diffHunk: string }) =>
    postJSON<{ success: boolean; diff?: string; branch?: string; error?: string }>("/api/actions/fix", { repo, commentId, prNumber, branch, comment }),
  fixApply: (repo: string, commentId: number, prNumber: number, branch: string) =>
    postJSON<{ success: boolean }>("/api/actions/fix-apply", { repo, commentId, prNumber, branch }),
  fixDiscard: (branch: string) =>
    postJSON<{ success: boolean }>("/api/actions/fix-discard", { branch }),
  submitReview: (repo: string, prNumber: number, event: "APPROVE" | "REQUEST_CHANGES", body?: string) =>
    postJSON<{ success: boolean }>("/api/actions/review", { repo, prNumber, event, body }),
};
