import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CrWatchState, CommentStatus, Evaluation } from "./types.js";

const STATE_DIR = join(homedir(), ".cr-watch");
const STATE_FILE = join(STATE_DIR, "state.json");
const STATE_TMP = join(STATE_DIR, "state.json.tmp");

const DEFAULT_STATE: CrWatchState = {
  lastPoll: null,
  comments: {},
};

export function loadState(): CrWatchState {
  if (!existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as CrWatchState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: CrWatchState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_TMP, JSON.stringify(state, null, 2));
  renameSync(STATE_TMP, STATE_FILE);
}

function commentKey(commentId: number, repo?: string): string {
  return repo ? `${repo}:${commentId}` : String(commentId);
}

export function markComment(
  state: CrWatchState,
  commentId: number,
  status: CommentStatus,
  prNumber: number,
  repo?: string,
): CrWatchState {
  const key = commentKey(commentId, repo);
  state.comments[key] = {
    status,
    prNumber,
    timestamp: new Date().toISOString(),
  };
  return state;
}

export function markCommentWithEvaluation(
  state: CrWatchState,
  commentId: number,
  status: CommentStatus,
  prNumber: number,
  evaluation: Evaluation,
  repo?: string,
): CrWatchState {
  const key = commentKey(commentId, repo);
  state.comments[key] = {
    status,
    prNumber,
    timestamp: new Date().toISOString(),
    evaluation,
  };
  return state;
}

export function isNewComment(state: CrWatchState, commentId: number, repo?: string): boolean {
  const prefixedKey = commentKey(commentId, repo);
  if (state.comments[prefixedKey]) return false;
  if (state.comments[String(commentId)]) return false;
  return true;
}

export function getCommentsByStatus(state: CrWatchState, status: CommentStatus) {
  return Object.entries(state.comments)
    .filter(([, v]) => v.status === status)
    .map(([id, v]) => ({ id, ...v }));
}
