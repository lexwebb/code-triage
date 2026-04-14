export type CommentStatus = "pending" | "evaluating" | "replied" | "fixed" | "dismissed";
export type EvalAction = "reply" | "fix" | "resolve";

export interface CommentRecord {
  status: CommentStatus;
  prNumber: number;
  repo?: string;
  timestamp: string;
  evaluation?: Evaluation;
  /** ISO — hide thread from active triage until this instant (local only). */
  snoozeUntil?: string | null;
  /** Higher sorts first within the same snooze bucket (local only). */
  priority?: number;
  /** Local note; never sent to GitHub. */
  triageNote?: string | null;
  /** True when evaluation failed after max retries (dead-lettered). */
  evalFailed?: boolean;
}

export interface CommentTriagePatch {
  snoozeUntil?: string | null;
  priority?: number | null;
  triageNote?: string | null;
}

export interface FixJobRecord {
  commentId: number;
  repo: string;
  prNumber: number;
  branch: string;
  path: string;
  worktreePath: string;
  startedAt: string;
}

export interface CrWatchState {
  lastPoll: string | null;
  comments: Record<string, CommentRecord>;
  fixJobs?: FixJobRecord[];
}

export interface CrComment {
  id: number;
  prNumber: number;
  path: string;
  line: number;
  diffHunk: string;
  body: string;
  inReplyToId: number | null;
}

export interface PrInfo {
  number: number;
  title: string;
  branch: string;
  url: string;
}

export interface PollResult {
  comments: CrComment[];
  pullsByNumber: Record<number, PrInfo>;
}

export interface Evaluation {
  action: EvalAction;
  summary: string;
  reply?: string;
  fixDescription?: string;
}

export interface SpawnOptions {
  cwd?: string;
  stdio?: ["pipe", "pipe", "pipe"];
  inputData?: string;
  stderrToConsole?: boolean;
}
