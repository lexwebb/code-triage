import { getRawSqlite, openStateDatabase } from "./db/client.js";
import { loadState, markEvaluating, needsEvaluation, saveState, markEvalFailed, markCommentWithEvaluation } from "./state.js";
import { evaluateComment, clampEvalConcurrency } from "./actioner.js";
import { updateClaudeStats, sseBroadcast, broadcastPollStatus } from "./server.js";
import { loadConfig } from "./config.js";
import { runWithConcurrency } from "./run-with-concurrency.js";
import type { CrComment, CrWatchState } from "./types.js";

export interface QueueItem {
  commentKey: string;
  commentId: number;
  repo: string;
  prNumber: number;
  comment: CrComment;
  status: "queued" | "in_flight";
  attempts: number;
}

function db() {
  openStateDatabase();
  return getRawSqlite();
}

export function enqueueEvaluation(
  comment: CrComment,
  prNumber: number,
  repo: string,
  state: CrWatchState,
): "queued" | "already-evaluated" | "already-queued" {
  const commentKey = `${repo}:${comment.id}`;
  const sqlite = db();
  const existing = sqlite.prepare("SELECT comment_key FROM eval_queue WHERE comment_key = ?").get(commentKey);
  if (existing) {
    return "already-queued";
  }

  if (!needsEvaluation(state, comment.id, repo)) {
    return "already-evaluated";
  }

  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO eval_queue (comment_key, comment_id, repo, pr_number, comment_json, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(commentKey, comment.id, repo, prNumber, JSON.stringify(comment), now, now);

  markEvaluating(state, comment.id, prNumber, repo);
  return "queued";
}

export function enqueueMany(
  comments: CrComment[],
  repo: string,
  state: CrWatchState,
): number {
  let enqueued = 0;
  for (const comment of comments) {
    const result = enqueueEvaluation(comment, comment.prNumber, repo, state);
    if (result === "queued") enqueued++;
  }
  if (enqueued > 0) {
    saveState(state);
    void drainOnce();
  }
  return enqueued;
}

export function dequeueItems(limit: number): QueueItem[] {
  const rows = db()
    .prepare("SELECT * FROM eval_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?")
    .all(limit) as Array<{
      comment_key: string;
      comment_id: number;
      repo: string;
      pr_number: number;
      comment_json: string;
      status: string;
      attempts: number;
    }>;

  return rows.map((r) => ({
    commentKey: r.comment_key,
    commentId: r.comment_id,
    repo: r.repo,
    prNumber: r.pr_number,
    comment: JSON.parse(r.comment_json) as CrComment,
    status: r.status as "queued" | "in_flight",
    attempts: r.attempts,
  }));
}

export function markInFlight(commentKey: string): void {
  db()
    .prepare("UPDATE eval_queue SET status = 'in_flight', updated_at = ? WHERE comment_key = ?")
    .run(new Date().toISOString(), commentKey);
}

export function completeItem(commentKey: string): void {
  db().prepare("DELETE FROM eval_queue WHERE comment_key = ?").run(commentKey);
}

const MAX_ATTEMPTS = 3;

export function failItem(commentKey: string): void {
  const sqlite = db();
  const now = new Date().toISOString();
  sqlite
    .prepare("UPDATE eval_queue SET attempts = attempts + 1, status = 'queued', updated_at = ? WHERE comment_key = ?")
    .run(now, commentKey);

  const row = sqlite
    .prepare("SELECT attempts, repo, comment_id FROM eval_queue WHERE comment_key = ?")
    .get(commentKey) as { attempts: number; repo: string; comment_id: number } | undefined;

  if (row && row.attempts >= MAX_ATTEMPTS) {
    sqlite.prepare("DELETE FROM eval_queue WHERE comment_key = ?").run(commentKey);
    const state = loadState();
    markEvalFailed(state, row.comment_id, row.repo);
    saveState(state);
  }
}

export function getQueueDepth(): { queued: number; inFlight: number } {
  const rows = db()
    .prepare("SELECT status, COUNT(*) as cnt FROM eval_queue GROUP BY status")
    .all() as Array<{ status: string; cnt: number }>;
  let queued = 0;
  let inFlight = 0;
  for (const r of rows) {
    if (r.status === "queued") queued = r.cnt;
    if (r.status === "in_flight") inFlight = r.cnt;
  }
  return { queued, inFlight };
}

export function recoverQueue(): void {
  db()
    .prepare("UPDATE eval_queue SET status = 'queued', updated_at = ? WHERE status = 'in_flight'")
    .run(new Date().toISOString());

  const sqlite = db();
  const deadLettered = sqlite
    .prepare("SELECT comment_key, comment_id, repo FROM eval_queue WHERE attempts >= ?")
    .all(MAX_ATTEMPTS) as Array<{ comment_key: string; comment_id: number; repo: string }>;

  if (deadLettered.length > 0) {
    const state = loadState();
    for (const row of deadLettered) {
      markEvalFailed(state, row.comment_id, row.repo);
      sqlite.prepare("DELETE FROM eval_queue WHERE comment_key = ?").run(row.comment_key);
    }
    saveState(state);
  }
}

// --- Worker ---

let workerTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let stopped = false;

export async function drainOnce(concurrency?: number): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    const cap = concurrency ?? clampEvalConcurrency(loadConfig().evalConcurrency ?? 2);
    const items = dequeueItems(cap);
    if (items.length === 0) return;

    for (const item of items) {
      markInFlight(item.commentKey);
    }

    await runWithConcurrency(items, cap, async (item) => {
      updateClaudeStats({ evalStarted: true });
      try {
        const evaluation = await evaluateComment(item.comment, item.repo);
        const state = loadState();
        markCommentWithEvaluation(state, item.commentId, "pending", item.prNumber, evaluation, item.repo);
        saveState(state);
        completeItem(item.commentKey);
        updateClaudeStats({ evalFinished: true });
        sseBroadcast("eval-complete", {
          repo: item.repo,
          prNumber: item.prNumber,
          commentId: item.commentId,
        });
        broadcastPollStatus();
      } catch (err) {
        updateClaudeStats({ evalFinished: true });
        console.error(`Eval failed for ${item.commentKey}: ${(err as Error).message}`);
        failItem(item.commentKey);
      }
    });
  } finally {
    draining = false;
  }
}

const DRAIN_INTERVAL_MS = 30_000;

export function startWorker(): void {
  stopped = false;
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    if (!stopped) void drainOnce();
  }, DRAIN_INTERVAL_MS);
  void drainOnce();
}

export function stopWorker(): Promise<void> {
  stopped = true;
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (!draining) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
}
