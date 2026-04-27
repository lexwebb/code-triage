import { and, count, eq, inArray, isNotNull, isNull, lt, lte, ne, or } from "drizzle-orm";
import type { CommentTriagePatch, CrWatchState, CommentStatus, CommentRecord, Evaluation, FixJobRecord } from "./types.js";
import * as schema from "./db/schema.js";
import { openStateDatabase, writeStateToDb } from "./db/client.js";

/** Pending local triage rows per PR (not replied/dismissed/fixed), excluding active snoozes. Keys: `owner/repo:prNumber`. */
export function getPendingTriageCountsByPr(): Map<string, number> {
  const db = openStateDatabase();
  const now = new Date().toISOString();
  const rows = db
    .select({
      repo: schema.comments.repo,
      prNumber: schema.comments.prNumber,
      cnt: count().as("cnt"),
    })
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.status, "pending"),
        isNotNull(schema.comments.repo),
        ne(schema.comments.repo, ""),
        or(isNull(schema.comments.snoozeUntil), eq(schema.comments.snoozeUntil, ""), lte(schema.comments.snoozeUntil, now)),
      ),
    )
    .groupBy(schema.comments.repo, schema.comments.prNumber)
    .all();

  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.repo) {
      m.set(`${r.repo}:${r.prNumber}`, Number(r.cnt));
    }
  }
  return m;
}

/** Mark locally-pending comments as dismissed when their GitHub thread has been resolved. Returns count updated. */
export function reconcileResolvedComments(resolvedIds: Set<number>): number {
  if (resolvedIds.size === 0) return 0;
  const db = openStateDatabase();
  const ids = [...resolvedIds];
  const result = db
    .update(schema.comments)
    .set({ status: "dismissed" })
    .where(and(inArray(schema.comments.commentId, ids), eq(schema.comments.status, "pending")))
    .run();
  return result.changes ?? 0;
}

/** Remove old replied/dismissed/fixed rows from SQLite (pending always kept). Returns rows deleted. */
export function compactCommentHistory(retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }
  const db = openStateDatabase();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db
    .delete(schema.comments)
    .where(
      and(
        inArray(schema.comments.status, ["replied", "dismissed", "fixed"]),
        lt(schema.comments.timestamp, cutoff),
      ),
    )
    .run();
  return Number(result.changes ?? 0);
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
      ...(row.evalFailed ? { evalFailed: true } : {}),
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
    ...(r.sessionId != null ? { sessionId: r.sessionId } : {}),
    ...(r.conversationJson ? { conversation: JSON.parse(r.conversationJson) as Array<{ role: "claude" | "user"; message: string }> } : {}),
  }));

  const state: CrWatchState = { lastPoll, comments };
  if (fixJobs.length > 0) {
    state.fixJobs = fixJobs;
  }
  return state;
}

export function saveState(state: CrWatchState): void {
  writeStateToDb(state);
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

const ACTED_ON: Set<CommentStatus> = new Set(["replied", "dismissed", "fixed"]);

export function needsEvaluation(state: CrWatchState, commentId: number, repo?: string): boolean {
  const key = commentKey(commentId, repo);
  const record = state.comments[key] ?? state.comments[String(commentId)];
  if (!record) return true; // not in state at all
  if (record.evaluation) return false; // already evaluated
  if (record.status === "evaluating") return false; // in progress
  if (ACTED_ON.has(record.status)) return false; // already handled
  if (record.evalFailed) return false; // dead-lettered — needs manual re-evaluate
  return true; // pending with no evaluation
}

export function markEvaluating(state: CrWatchState, commentId: number, prNumber: number, repo?: string): void {
  const key = commentKey(commentId, repo);
  const prev = state.comments[key];
  state.comments[key] = {
    status: "evaluating",
    prNumber,
    timestamp: new Date().toISOString(),
    ...(repo ? { repo } : {}),
    ...carryTriage(prev),
  };
}

export function markEvalFailed(state: CrWatchState, commentId: number, repo?: string): void {
  const key = commentKey(commentId, repo);
  const prev = state.comments[key];
  if (prev) {
    prev.status = "pending";
    prev.evalFailed = true;
  }
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
