import type { User, RepoInfo, PullRequest, PullRequestDetail, PullFile, ReviewComment, CrWatchState, CheckSuite } from "./types";

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
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `API error: ${res.status}`);
  }
  return data as T;
}

function repoQuery(repo?: string): string {
  return repo ? `?repo=${encodeURIComponent(repo)}` : "";
}

function repoQueryRequired(repo: string): string {
  return `?repo=${encodeURIComponent(repo)}`;
}

export interface FixJobStatus {
  commentId: number;
  repo: string;
  prNumber: number;
  path: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  error?: string;
  diff?: string;
  branch?: string;
  claudeOutput?: string;
  originalComment?: { path: string; line: number; body: string; diffHunk: string };
}

/** Mirrors `GET /api/config` — safe for the browser (account tokens omitted). */
export interface AppConfigPayload {
  root: string;
  port: number;
  interval: number;
  evalConcurrency: number;
  pollReviewRequested: boolean;
  commentRetentionDays: number;
  ignoredBots: string[];
  accounts: Array<{ name: string; orgs: string[]; hasToken: boolean }>;
  /** True when a default PAT is stored in config (value not exposed). */
  hasGithubToken: boolean;
  evalPromptAppend: string;
  evalPromptAppendByRepo: Record<string, string>;
  evalClaudeExtraArgs: string[];
  /** Days without activity before a repo is polled less often; 0 = poll every repo every cycle. */
  repoPollStaleAfterDays: number;
  /** Minutes between polls for inactive repos. */
  repoPollColdIntervalMinutes: number;
  /** Reserve this fraction of GitHub quota for UI (0–0.95). Default 0.35. */
  pollApiHeadroom: number;
  /** Stretch poll interval when quota is tight (default true). */
  pollRateLimitAware: boolean;
}

export interface ConfigGetResponse {
  config: AppConfigPayload;
  needsSetup: boolean;
  listenPort: number;
}

export interface PollStatus {
  lastPoll: number;
  nextPoll: number;
  intervalMs: number;
  /** Configured minimum interval (ms); `intervalMs` may be larger when rate-aware. */
  baseIntervalMs?: number;
  estimatedPollRequests?: number;
  /** Rough polling-only GET count per hour at current effective interval. */
  estimatedGithubRequestsPerHour?: number;
  pollBudgetNote?: string | null;
  polling: boolean;
  /** True when poll is paused because >=80% of API quota is consumed. */
  pollPaused?: boolean;
  pollPausedReason?: string | null;
  fixJobs: FixJobStatus[];
  testNotification: boolean;
  rateLimited?: boolean;
  rateLimitResetAt?: number | null;
  /** From GitHub `X-RateLimit-Remaining` / `X-RateLimit-Limit` when present. */
  rateLimitRemaining?: number | null;
  rateLimitLimit?: number | null;
  /** e.g. `core` vs `graphql` (when GitHub sends `X-RateLimit-Resource`). */
  rateLimitResource?: string | null;
  rateLimitUpdatedAt?: number;
  /** Present when CLI records a top-level poll failure (see `/api/health`). */
  lastPollError?: string | null;
  claude?: {
    activeEvals: number;
    activeFixJobs: number;
    evalConcurrencyCap: number;
    totalEvalsThisSession: number;
    totalFixesThisSession: number;
  };
}

export interface PullsBundleResponse {
  authored: PullRequest[];
  reviewRequested: PullRequest[];
  /** Server could not resolve the GitHub login; lists are empty until /user succeeds. */
  githubUserUnavailable?: boolean;
}

export const api = {
  clearRepoPollSchedule: () => postJSON<{ ok: boolean }>("/api/actions/clear-repo-poll-schedule", {}),
  getUser: () => fetchJSON<User>("/api/user"),
  getRepos: () => fetchJSON<RepoInfo[]>("/api/repos"),
  /** One server pass over repos (use instead of getPulls + getReviewRequested together). */
  getPullsBundle: (repo?: string) => fetchJSON<PullsBundleResponse>(`/api/pulls-bundle${repoQuery(repo)}`),
  getPulls: (repo?: string) => fetchJSON<PullRequest[]>(`/api/pulls${repoQuery(repo)}`),
  getReviewRequested: (repo?: string) => fetchJSON<PullRequest[]>(`/api/pulls/review-requested${repoQuery(repo)}`),
  getPull: (number: number, repo: string) => fetchJSON<PullRequestDetail>(`/api/pulls/${number}${repoQueryRequired(repo)}`),
  getPullFiles: (number: number, repo: string) => fetchJSON<PullFile[]>(`/api/pulls/${number}/files${repoQueryRequired(repo)}`),
  getPullComments: (number: number, repo: string) => fetchJSON<ReviewComment[]>(`/api/pulls/${number}/comments${repoQueryRequired(repo)}`),
  getChecks: (number: number, repo: string) => fetchJSON<CheckSuite[]>(`/api/pulls/${number}/checks${repoQueryRequired(repo)}`),
  getFileContent: (prNumber: number, path: string, repo: string) => fetchJSON<{ content: string; path: string }>(`/api/pulls/${prNumber}/files/${path}${repoQueryRequired(repo)}`),
  getState: () => fetchJSON<CrWatchState>("/api/state"),
  getPollStatus: () => fetchJSON<PollStatus>("/api/poll-status"),
  replyToComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/reply", { repo, commentId, prNumber }),
  resolveComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/resolve", { repo, commentId, prNumber }),
  dismissComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/dismiss", { repo, commentId, prNumber }),
  updateCommentTriage: (
    repo: string,
    commentId: number,
    prNumber: number,
    patch: { snoozeUntil?: string | null; priority?: number | null; triageNote?: string | null },
  ) => postJSON<{ success: boolean }>("/api/actions/comment-triage", { repo, commentId, prNumber, ...patch }),
  reEvaluate: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean; evaluation?: unknown }>("/api/actions/re-evaluate", { repo, commentId, prNumber }),
  batchAction: (action: "reply" | "resolve" | "dismiss", items: Array<{ repo: string; commentId: number; prNumber: number }>) =>
    postJSON<{ results: Array<{ commentId: number; success: boolean; error?: string }> }>("/api/actions/batch", { action, items }),
  fixWithClaude: (repo: string, commentId: number, prNumber: number, branch: string, comment: { path: string; line: number; body: string; diffHunk: string }, userInstructions?: string) =>
    postJSON<{ success: boolean; status: string; branch?: string; error?: string }>("/api/actions/fix", { repo, commentId, prNumber, branch, comment, ...(userInstructions ? { userInstructions } : {}) }),
  fixApply: (repo: string, commentId: number, prNumber: number, branch: string) =>
    postJSON<{ success: boolean }>("/api/actions/fix-apply", { repo, commentId, prNumber, branch }),
  fixDiscard: (branch: string, commentId?: number) =>
    postJSON<{ success: boolean }>("/api/actions/fix-discard", { branch, commentId }),
  submitReview: (repo: string, prNumber: number, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body?: string) =>
    postJSON<{ success: boolean }>("/api/actions/review", { repo, prNumber, event, body }),
  createComment: (repo: string, prNumber: number, commitId: string, path: string, line: number, side: "LEFT" | "RIGHT", body: string) =>
    postJSON<{ success: boolean }>("/api/actions/comment", { repo, prNumber, commitId, path, line, side, body }),
  getVersion: () => fetchJSON<{ localSha: string; remoteSha: string; behind: number }>("/api/version"),
  getConfig: () => fetchJSON<ConfigGetResponse>("/api/config"),
  saveConfig: (body: Record<string, unknown>) =>
    postJSON<{ ok: boolean; restartRequired: boolean }>("/api/config", body),
};
