import type { PullRequest } from "./types";

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
  batchCommentIds?: number[];
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

export interface PrCompanionBatchFix {
  commentIds: number[];
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
    memberLinks: Array<{
      label: string;
      githubLogins?: string[];
      linearNames?: string[];
      linearUserIds?: string[];
    }>;
    /** When true, Claude suggests extra GitHub–Linear identity links during team snapshot rebuild. */
    claudeMemberLinking: boolean;
    /** When true, Claude adds per-teammate bullet summaries (skipped when work fingerprints are unchanged). */
    claudeMemberSummaries: boolean;
    /** Include teammate PRs from GitHub orgs you share with tracked repo owners (team overview). */
    includeGithubOrgMemberPulls: boolean;
    /** With Linear team keys set, load team issues not only assigned to you (team overview). */
    includeLinearTeamScopeIssues: boolean;
    /** Max issues for Linear team-scope fetch. */
    linearTeamIssueCap: number;
  };
}

/** One line in per-teammate accordion (matches team radar row shape). */
export type TeamMemberSummaryItem = {
  title: string;
  entityKind: "pr" | "ticket";
  entityIdentifier: string;
  lifecycleStage?: string;
  lifecycleStuck?: boolean;
  providerUrl?: string;
  waitLabel?: string;
  /** ISO time of last PR/ticket activity; used to exclude stale items from AI summaries. */
  activityAt?: string;
};

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
  /** Fingerprint when any teammate's PR/ticket digest inputs change (server-computed). */
  teamMemberAiDigestInputFingerprint?: string;
  memberSummaries?: Array<{
    memberLabel: string;
    identityHints?: Array<
      | { kind: "github"; login: string }
      | { kind: "linear"; userId?: string; name: string }
    >;
    workingOn: TeamMemberSummaryItem[];
    waiting: TeamMemberSummaryItem[];
    comingUp: TeamMemberSummaryItem[];
    aiDigest?: {
      bullets: string[];
      workFingerprint: string;
      generatedAt: string;
    };
   }>;
}

export type TeamMemberSummaryIdentityHint = NonNullable<
  NonNullable<TeamOverviewSnapshot["memberSummaries"]>[number]["identityHints"]
>[number];

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

