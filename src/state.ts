import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CrWatchState, CommentStatus } from "./types.js";

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

export function markComment(
  state: CrWatchState,
  commentId: number,
  status: CommentStatus,
  prNumber: number,
): CrWatchState {
  state.comments[commentId] = {
    status,
    prNumber,
    timestamp: new Date().toISOString(),
  };
  return state;
}

export function isNewComment(state: CrWatchState, commentId: number): boolean {
  return !state.comments[commentId];
}

export function getCommentsByStatus(state: CrWatchState, status: CommentStatus) {
  return Object.entries(state.comments)
    .filter(([, v]) => v.status === status)
    .map(([id, v]) => ({ id, ...v }));
}
