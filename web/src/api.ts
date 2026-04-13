import type { User, PullRequest, PullRequestDetail, PullFile, ReviewComment, CrWatchState } from "./types";

const BASE = "";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getUser: () => fetchJSON<User>("/api/user"),
  getPulls: () => fetchJSON<PullRequest[]>("/api/pulls"),
  getPull: (number: number) => fetchJSON<PullRequestDetail>(`/api/pulls/${number}`),
  getPullFiles: (number: number) => fetchJSON<PullFile[]>(`/api/pulls/${number}/files`),
  getPullComments: (number: number) => fetchJSON<ReviewComment[]>(`/api/pulls/${number}/comments`),
  getFileContent: (prNumber: number, path: string) => fetchJSON<{ content: string; path: string }>(`/api/pulls/${prNumber}/files/${path}`),
  getState: () => fetchJSON<CrWatchState>("/api/state"),
};
