export type CommentStatus = "seen" | "replied" | "fixed" | "skipped";
export type EvalAction = "reply" | "fix" | "resolve";

export interface CommentRecord {
  status: CommentStatus;
  prNumber: number;
  timestamp: string;
}

export interface CrWatchState {
  lastPoll: string | null;
  comments: Record<string, CommentRecord>;
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
}

export interface SpawnOptions {
  cwd?: string;
  stdio?: ["pipe", "pipe", "pipe"];
  inputData?: string;
  stderrToConsole?: boolean;
}
