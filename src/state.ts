import { eq } from "drizzle-orm";
import type { CommentTriagePatch, CrWatchState, CommentStatus, CommentRecord, Evaluation, FixJobRecord } from "./types.js";
import * as schema from "./db/schema.js";
import { openStateDatabase, writeStateToDb, getRawSqlite } from "./db/client.js";

/** Remove old replied/dismissed/fixed rows from SQLite (pending always kept). Returns rows deleted. */
export function compactCommentHistory(retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }
  openStateDatabase();
  const sqlite = getRawSqlite();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = sqlite
    .prepare(
      `DELETE FROM comments WHERE status IN ('replied', 'dismissed', 'fixed') AND timestamp < ?`,
    )
    .run(cutoff);
  return Number(result.changes);
}

export function loadState(): CrWatchState {
  const db = openStateDatabase();
  const metaRow = db.select().from(schema.meta).where(eq(schema.meta.id, 1)).get();
  const lastPoll = metaRow?.lastPoll ?? null;

  const rows = db.select().from(schema.comments).all();
  const comments: CrWatchState["comments"] = {};
  for (const row of rows) {
    let evaluation: Evaluation | undefined;
    if (row.evaluationJson) {
      try {
        evaluation = JSON.parse(row.evaluationJson) as Evaluation;
      } catch {
        evaluation = undefined;
      }
    }
    comments[row.commentKey] = {
      status: row.status as CommentStatus,
      prNumber: row.prNumber,
      ...(row.repo ? { repo: row.repo } : {}),
      timestamp: row.timestamp,
      ...(evaluation ? { evaluation } : {}),
      ...(row.snoozeUntil != null && row.snoozeUntil !== "" ? { snoozeUntil: row.snoozeUntil } : {}),
      ...(row.priority != null ? { priority: row.priority } : {}),
      ...(row.triageNote != null && row.triageNote !== "" ? { triageNote: row.triageNote } : {}),
    };
  }

  const jobRows = db.select().from(schema.fixJobs).all();
  const fixJobs: FixJobRecord[] = jobRows.map((r) => ({
    commentId: r.commentId,
    repo: r.repo,
    prNumber: r.prNumber,
    branch: r.branch,
    path: r.path,
    worktreePath: r.worktreePath,
    startedAt: r.startedAt,
  }));

  const state: CrWatchState = { lastPoll, comments };
  if (fixJobs.length > 0) {
    state.fixJobs = fixJobs;
  }
  return state;
}

export function saveState(state: CrWatchState): void {
  writeStateToDb(getRawSqlite(), state);
}

function commentKey(commentId: number, repo?: string): string {
  return repo ? `${repo}:${commentId}` : String(commentId);
}

function carryTriage(prev: CommentRecord | undefined): Partial<Pick<CommentRecord, "snoozeUntil" | "priority" | "triageNote">> {
  if (!prev) {
    return {};
  }
  const t: Partial<Pick<CommentRecord, "snoozeUntil" | "priority" | "triageNote">> = {};
  if (prev.snoozeUntil != null) {
    t.snoozeUntil = prev.snoozeUntil;
  }
  if (prev.priority !== undefined && prev.priority !== null) {
    t.priority = prev.priority;
  }
  if (prev.triageNote != null && prev.triageNote !== "") {
    t.triageNote = prev.triageNote;
  }
  return t;
}

export function markComment(
  state: CrWatchState,
  commentId: number,
  status: CommentStatus,
  prNumber: number,
  repo?: string,
): CrWatchState {
  const key = commentKey(commentId, repo);
  const prev = state.comments[key];
  state.comments[key] = {
    status,
    prNumber,
    timestamp: new Date().toISOString(),
    ...(repo ? { repo } : {}),
    ...carryTriage(prev),
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
  const prev = state.comments[key];
  state.comments[key] = {
    status,
    prNumber,
    timestamp: new Date().toISOString(),
    evaluation,
    ...(repo ? { repo } : {}),
    ...carryTriage(prev),
  };
  return state;
}

export function patchCommentTriage(
  state: CrWatchState,
  commentId: number,
  repo: string,
  prNumber: number,
  patch: CommentTriagePatch,
): void {
  const key = commentKey(commentId, repo);
  let rec = state.comments[key];
  if (!rec) {
    rec = {
      status: "pending",
      prNumber,
      timestamp: new Date().toISOString(),
      repo,
    };
  } else {
    rec = { ...rec };
  }
  if (patch.snoozeUntil !== undefined) {
    rec.snoozeUntil = patch.snoozeUntil;
  }
  if (patch.priority !== undefined) {
    if (patch.priority === null) {
      delete rec.priority;
    } else {
      rec.priority = patch.priority;
    }
  }
  if (patch.triageNote !== undefined) {
    rec.triageNote = patch.triageNote === "" ? null : patch.triageNote;
  }
  state.comments[key] = rec;
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

export function addFixJob(state: CrWatchState, job: FixJobRecord): void {
  if (!state.fixJobs) state.fixJobs = [];
  state.fixJobs = state.fixJobs.filter((j) => j.commentId !== job.commentId);
  state.fixJobs.push(job);
}

export function removeFixJob(state: CrWatchState, commentId: number): void {
  if (!state.fixJobs) return;
  state.fixJobs = state.fixJobs.filter((j) => j.commentId !== commentId);
}

export function getFixJobs(state: CrWatchState): FixJobRecord[] {
  return state.fixJobs ?? [];
}
