import type { User, RepoInfo, PullRequest, PullRequestDetail, PullFile, ReviewComment, CrWatchState, CheckSuite, TicketIssue, TicketIssueDetail } from "./types";

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

async function deleteJSON<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
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

export interface QueuedFixItem {
  commentId: number;
  repo: string;
  prNumber: number;
  path: string;
  branch: string;
  position: number;
  queuedAt: string;
}

export interface FixJobStatus {
  commentId: number;
  repo: string;
  prNumber: number;
  path: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "no_changes" | "awaiting_response";
  error?: string;
  diff?: string;
  branch?: string;
  claudeOutput?: string;
  originalComment?: { path: string; line: number; body: string; diffHunk: string };
  sessionId?: string;
  conversation?: Array<{ role: "claude" | "user"; message: string }>;
  suggestedReply?: string;
}

/** PR assistant panel on the reviews page (`/api/reviews/companion/*`). */
export interface PrCompanionChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PrCompanionQueueFix {
  commentId: number;
  userInstructions?: string;
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
  /** `owner/repo` hidden from PR sidebars and attention (global mute). */
  mutedRepos: string[];
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
  /** Multiplier for very cold repos with no recorded activity. */
  repoPollSuperColdMultiplier: number;
  /** Reserve this fraction of GitHub quota for UI (0–0.95). Default 0.35. */
  pollApiHeadroom: number;
  /** Stretch poll interval when quota is tight (default true). */
  pollRateLimitAware: boolean;
  /** IDE to open files in from the web UI. Default "vscode". */
  preferredEditor: string;
  /** Max Q&A turns for conversational fixes (0 = unlimited). Default 5. */
  fixConversationMaxTurns: number;
  /** True when a Linear API key is stored in config (value not exposed). */
  hasLinearApiKey: boolean;
  /** Team keys to filter Linear queries. */
  linearTeamKeys: string[];
  /** Active ticket provider, if configured. */
  ticketProvider?: "linear";
  coherence: {
    branchStalenessDays: number;
    approvedUnmergedHours: number;
    reviewWaitHours: number;
    ticketInactivityDays: number;
  };
  team: {
    enabled: boolean;
    pollIntervalMinutes: number;
  };
}

export interface TeamOverviewSnapshot {
  generatedAt: string;
  summaryCounts: {
    stuck: number;
    awaitingReview: number;
    recentlyMerged: number;
    unlinkedPrs: number;
    unlinkedTickets: number;
  };
  stuck: Array<{
    entityKind: "pr" | "ticket";
    entityIdentifier: string;
    title: string;
    lifecycleStage?: string;
    lifecycleStuck?: boolean;
    actorLabel?: string;
    providerUrl?: string;
  }>;
  awaitingReview: Array<{
    repo: string;
    number: number;
    title: string;
    waitHours: number;
    lifecycleStage?: string;
    lifecycleStuck?: boolean;
    actorLabel?: string;
  }>;
  recentlyMerged: Array<{
    repo: string;
    number: number;
    title: string;
    mergedAt: string;
    lifecycleStage?: string;
    lifecycleStuck?: boolean;
    actorLabel?: string;
  }>;
  unlinkedPrs: Array<{
    repo: string;
    number: number;
    title: string;
    lifecycleStage?: string;
    lifecycleStuck?: boolean;
    actorLabel?: string;
  }>;
  unlinkedTickets: Array<{
    identifier: string;
    title: string;
    lifecycleStage?: string;
    lifecycleStuck?: boolean;
    actorLabel?: string;
    providerUrl?: string;
  }>;
}

export interface TeamOverviewResponse {
  snapshot: TeamOverviewSnapshot | null;
  updatedAtMs: number | null;
  refreshError: string | null;
  stale: boolean;
}

export interface AttentionItem {
  id: string;
  type: string;
  entityKind: "pr" | "ticket";
  entityIdentifier: string;
  priority: "high" | "medium" | "low";
  title: string;
  stage?: string;
  stuckSince?: string;
  firstSeenAt: string;
  snoozedUntil?: string;
  dismissedAt?: string;
  pinned: boolean;
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
  fixQueue?: QueuedFixItem[];
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
  githubRequestStats?: {
    total: number;
    byMethod: Record<string, number>;
    byFamily: Record<string, number>;
  };
  linearRequestStats?: {
    total: number;
    byOperation: Record<string, number>;
  };
  githubRequestRates?: {
    actualRpm: number;
    actualRph: number;
    predictedRpm: number;
    predictedRph: number;
  };
  linearRequestRates?: {
    actualRpm: number;
    actualRph: number;
    predictedRpm: number;
    predictedRph: number;
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
  getPullComments: (number: number, repo: string, opts?: { autoEvaluate?: boolean }) =>
    fetchJSON<ReviewComment[]>(
      `/api/pulls/${number}/comments${repoQueryRequired(repo)}${
        opts?.autoEvaluate === undefined ? "" : `&autoEvaluate=${opts.autoEvaluate ? "1" : "0"}`
      }`,
    ),
  getChecks: (number: number, repo: string, sha?: string) => fetchJSON<CheckSuite[]>(`/api/pulls/${number}/checks${repoQueryRequired(repo)}${sha ? `&sha=${encodeURIComponent(sha)}` : ""}`),
  getFileContent: (prNumber: number, path: string, repo: string) => fetchJSON<{ content: string; path: string }>(`/api/pulls/${prNumber}/files/${path}${repoQueryRequired(repo)}`),
  getState: () => fetchJSON<CrWatchState>("/api/state"),
  getPollStatus: () => fetchJSON<PollStatus>("/api/poll-status"),
  /** Same as CLI [r] — full GitHub + tickets + coherence poll. */
  requestPollNow: () => postJSON<{ ok: boolean }>("/api/actions/poll-now", {}),
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
    postJSON<{ success: boolean; status: string; branch?: string; error?: string; position?: number }>("/api/actions/fix", { repo, commentId, prNumber, branch, comment, ...(userInstructions ? { userInstructions } : {}) }),
  getFixQueue: () => fetchJSON<QueuedFixItem[]>("/api/fix-queue"),
  cancelQueuedFix: (commentId: number) =>
    deleteJSON<{ success: boolean }>(`/api/fix-queue/${commentId}`, {}),
  fixApply: (repo: string, commentId: number, prNumber: number, branch: string) =>
    postJSON<{ success: boolean; recoveredWorktree?: boolean }>("/api/actions/fix-apply", {
      repo,
      commentId,
      prNumber,
      branch,
    }),
  fixDiscard: (branch: string, commentId?: number) =>
    postJSON<{ success: boolean }>("/api/actions/fix-discard", { branch, commentId }),
  fixReply: (repo: string, commentId: number, message: string) =>
    postJSON<{ success: boolean; error?: string }>("/api/actions/fix-reply", { repo, commentId, message }),
  fixReplyAndResolve: (repo: string, commentId: number, prNumber: number, replyBody: string) =>
    postJSON<{ success: boolean }>("/api/actions/fix-reply-and-resolve", { repo, commentId, prNumber, replyBody }),
  submitReview: (repo: string, prNumber: number, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body?: string) =>
    postJSON<{ success: boolean }>("/api/actions/review", { repo, prNumber, event, body }),
  createComment: (repo: string, prNumber: number, commitId: string, path: string, line: number, side: "LEFT" | "RIGHT", body: string) =>
    postJSON<{ success: boolean }>("/api/actions/comment", { repo, prNumber, commitId, path, line, side, body }),
  getVersion: () => fetchJSON<{ localSha: string; remoteSha: string; behind: number }>("/api/version"),
  getConfig: () => fetchJSON<ConfigGetResponse>("/api/config"),
  saveConfig: (body: Record<string, unknown>) =>
    postJSON<{ ok: boolean; restartRequired: boolean }>("/api/config", body),
  getVapidPublicKey: () => fetchJSON<{ publicKey: string }>("/api/push/vapid-public-key"),
  subscribePush: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    postJSON<{ ok: boolean }>("/api/push/subscribe", sub),
  unsubscribePush: (endpoint: string) =>
    deleteJSON<{ ok: boolean }>("/api/push/unsubscribe", { endpoint }),
  mutePR: (repo: string, number: number) =>
    postJSON<{ ok: boolean }>("/api/push/mute", { repo, number }),
  unmutePR: (repo: string, number: number) =>
    deleteJSON<{ ok: boolean }>("/api/push/mute", { repo, number }),
  getMutedPRs: () => fetchJSON<{ muted: string[] }>("/api/push/muted"),
  // Tickets
  getTicketUser: () => fetchJSON<{ id: string; name: string; email: string }>("/api/tickets/me"),
  getMyTickets: () => fetchJSON<TicketIssue[]>("/api/tickets/mine"),
  getRepoLinkedTickets: () => fetchJSON<(TicketIssue & { linkedPRs: Array<{ number: number; repo: string; title: string }> })[]>("/api/tickets/repo-linked"),
  getTicketDetail: (id: string) => fetchJSON<TicketIssueDetail>(`/api/tickets/${encodeURIComponent(id)}`),
  getTicketTeams: () => fetchJSON<Array<{ id: string; key: string; name: string }>>("/api/tickets/teams"),
  getTicketLinkMap: () => fetchJSON<{ ticketToPRs: Record<string, Array<{ number: number; repo: string; title: string }>>; prToTickets: Record<string, string[]> }>("/api/tickets/link-map"),
  // Attention
  getAttentionItems: (all?: boolean) =>
    fetchJSON<AttentionItem[]>(`/api/attention${all ? "?all=true" : ""}`),
  snoozeAttentionItem: (id: string, until: string) =>
    postJSON<{ ok: boolean }>(`/api/attention/${encodeURIComponent(id)}/snooze`, { until }),
  dismissAttentionItem: (id: string) =>
    postJSON<{ ok: boolean }>(`/api/attention/${encodeURIComponent(id)}/dismiss`, {}),
  pinAttentionItem: (id: string) =>
    postJSON<{ ok: boolean }>(`/api/attention/${encodeURIComponent(id)}/pin`, {}),
  getTeamOverview: () => fetchJSON<TeamOverviewResponse>("/api/team/overview"),
  refreshTeamOverview: async () => {
    const res = await fetch(`${BASE}/api/team/overview/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      snapshot?: TeamOverviewSnapshot;
      error?: string | null;
    };
    if (!res.ok && res.status !== 500) {
      throw new Error(typeof data.error === "string" ? data.error : `API error: ${res.status}`);
    }
    return {
      ok: data.ok === true,
      ...(data.snapshot ? { snapshot: data.snapshot } : {}),
      ...(data.error !== undefined ? { error: data.error } : {}),
    } as { ok: boolean; snapshot?: TeamOverviewSnapshot; error?: string | null };
  },
  getPrCompanionSession: (repo: string, prNumber: number) =>
    fetchJSON<{
      messages: PrCompanionChatMessage[];
      bundleThreadCount: number;
      bundleUpdatedAtMs: number | null;
    }>(`/api/reviews/companion/session?repo=${encodeURIComponent(repo)}&prNumber=${prNumber}`),
  postPrCompanionMessage: (body: {
    repo: string;
    prNumber: number;
    userMessage: string;
    threadBundle?: unknown;
    refreshContext?: boolean;
  }) =>
    postJSON<{
      assistantMessage: string;
      messages: PrCompanionChatMessage[];
      contextNote?: string;
      bundleThreadCount: number;
      bundleUpdatedAtMs: number | null;
      queueFixes?: PrCompanionQueueFix[];
    }>("/api/reviews/companion/message", body),
  resetPrCompanionSession: (repo: string, prNumber: number) =>
    postJSON<{ ok: boolean }>("/api/reviews/companion/reset", { repo, prNumber }),
};
