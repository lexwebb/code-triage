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
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
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
}

export interface CrWatchState {
  lastPoll: string | null;
  comments: Record<string, {
    status: "seen" | "replied" | "fixed" | "skipped";
    prNumber: number;
    timestamp: string;
  }>;
}
