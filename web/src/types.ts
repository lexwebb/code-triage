export interface RepoInfo {
  repo: string;
  localPath: string;
}

export interface User {
  login: string;
  avatarUrl: string;
  url: string;
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
  author: string;
  authorAvatar: string;
  path: string;
  line: number;
  diffHunk: string;
  body: string;
  createdAt: string;
  inReplyToId: number | null;
  isResolved: boolean;
  evaluation: CommentEvaluation | null;
  crStatus: "pending" | "replied" | "fixed" | "dismissed" | null;
}

export interface CrWatchState {
  lastPoll: string | null;
  comments: Record<string, {
    status: "seen" | "replied" | "fixed" | "skipped";
    prNumber: number;
    timestamp: string;
  }>;
}
