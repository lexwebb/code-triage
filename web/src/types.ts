export interface RepoInfo {
  repo: string;
  localPath: string;
}

export interface User {
  login: string;
  avatarUrl: string;
  url: string;
  /** GitHub GET /user failed with no cached login (e.g. rate limited). */
  degraded?: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  authorAvatar: string;
  branch: string;
  baseBranch: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  repo: string;
  checksStatus: "success" | "failure" | "pending";
  openComments: number;
  /** Local SQLite rows still `pending` (not replied/dismissed/fixed), excluding active snoozes. */
  pendingTriage?: number;
  hasHumanApproval: boolean;
}

export interface Reviewer {
  login: string;
  avatar: string;
  state: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewers: Reviewer[];
  checksSummary: {
    total: number;
    success: number;
    failure: number;
    pending: number;
  } | null;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface CommentEvaluation {
  action: "reply" | "fix" | "resolve";
  summary: string;
  reply?: string;
  fixDescription?: string;
}

export interface ReviewComment {
  id: number;
  /** GitHub permalink for this review comment (when provided by API). */
  htmlUrl?: string;
  author: string;
  authorAvatar: string;
  isBot?: boolean;
  path: string;
  line: number;
  diffHunk: string;
  body: string;
  createdAt: string;
  inReplyToId: number | null;
  isResolved: boolean;
  evaluation: CommentEvaluation | null;
  crStatus: "pending" | "evaluating" | "replied" | "fixed" | "dismissed" | null;
  snoozeUntil?: string | null;
  priority?: number | null;
  triageNote?: string | null;
  evalFailed?: boolean;
}

export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  message: string;
  title: string | null;
}

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  htmlUrl: string;
  annotations: CheckAnnotation[];
}

export interface CheckSuite {
  id: number;
  name: string;
  conclusion: string | null;
  runs: CheckRun[];
}

export type CiProvider = "github-actions" | "circleci";
export type CiRunStatus = "success" | "failure" | "pending";

export interface CiRun {
  id: string;
  provider: CiProvider;
  name: string;
  status: CiRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  htmlUrl: string | null;
  logsAvailable: boolean;
}

export interface CiProviderSection {
  provider: CiProvider;
  runs: CiRun[];
  status: CiRunStatus;
}

export interface PullCiResult {
  overallStatus: CiRunStatus;
  providers: CiProviderSection[];
}

export interface CrWatchState {
  lastPoll: string | null;
  comments: Record<string, {
    status: "seen" | "replied" | "fixed" | "skipped";
    prNumber: number;
    timestamp: string;
  }>;
}

// ── Tickets ──

export interface TicketIssue {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; color: string; type: string };
  isDone?: boolean;
  providerLinkedPulls?: Array<{ number: number; repo: string; title: string }>;
  priority: number;
  assignee?: { id?: string; name: string; avatarUrl?: string };
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  providerUrl: string;
}

export interface TicketComment {
  id: string;
  body: string;
  author: { name: string; avatarUrl?: string };
  createdAt: string;
}

export interface TicketIssueDetail extends TicketIssue {
  description?: string;
  comments: TicketComment[];
  linkedPRs: Array<{ number: number; repo: string; title: string }>;
}
