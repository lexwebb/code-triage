import { asc, count, eq, gte, sql } from "drizzle-orm";
import * as schema from "./db/schema.js";
import { openStateDatabase } from "./db/client.js";
import { loadState, markEvaluating, needsEvaluation, saveState, markEvalFailed, markCommentWithEvaluation } from "./state.js";
import { evaluateComment, clampEvalConcurrency, resolveThread } from "./actioner.js";
import { updateClaudeStats, sseBroadcast, broadcastPollStatus } from "./server.js";
import { notifyEvalComplete } from "./push.js";
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
  return openStateDatabase();
}

export function enqueueEvaluation(
  comment: CrComment,
  prNumber: number,
  repo: string,
  state: CrWatchState,
): "queued" | "already-evaluated" | "already-queued" {
  const commentKey = `${repo}:${comment.id}`;
  const database = db();
  const existing = database
    .select({ commentKey: schema.evalQueue.commentKey })
    .from(schema.evalQueue)
    .where(eq(schema.evalQueue.commentKey, commentKey))
    .get();
  if (existing) {
    return "already-queued";
  }

  if (!needsEvaluation(state, comment.id, repo)) {
    return "already-evaluated";
  }

  const now = new Date().toISOString();
  database
    .insert(schema.evalQueue)
    .values({
      commentKey,
      commentId: comment.id,
      repo,
      prNumber,
      commentJson: JSON.stringify(comment),
      status: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  markEvaluating(state, comment.id, prNumber, repo);
  return "queued";
}

export function enqueueMany(comments: CrComment[], repo: string, state: CrWatchState): number {
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
    .select()
    .from(schema.evalQueue)
    .where(eq(schema.evalQueue.status, "queued"))
    .orderBy(asc(schema.evalQueue.createdAt))
    .limit(limit)
    .all();

  return rows.map((r) => ({
    commentKey: r.commentKey,
    commentId: r.commentId,
    repo: r.repo,
    prNumber: r.prNumber,
    comment: JSON.parse(r.commentJson) as CrComment,
    status: r.status as "queued" | "in_flight",
    attempts: r.attempts,
  }));
}

export function markInFlight(commentKey: string): void {
  db()
    .update(schema.evalQueue)
    .set({ status: "in_flight", updatedAt: new Date().toISOString() })
    .where(eq(schema.evalQueue.commentKey, commentKey))
    .run();
}

export function completeItem(commentKey: string): void {
  db().delete(schema.evalQueue).where(eq(schema.evalQueue.commentKey, commentKey)).run();
}

const MAX_ATTEMPTS = 3;

export function failItem(commentKey: string): void {
  const database = db();
  const now = new Date().toISOString();
  database
    .update(schema.evalQueue)
    .set({
      attempts: sql`${schema.evalQueue.attempts} + 1`,
      status: "queued",
      updatedAt: now,
    })
    .where(eq(schema.evalQueue.commentKey, commentKey))
    .run();

  const row = database
    .select({
      attempts: schema.evalQueue.attempts,
      repo: schema.evalQueue.repo,
      commentId: schema.evalQueue.commentId,
    })
    .from(schema.evalQueue)
    .where(eq(schema.evalQueue.commentKey, commentKey))
    .get();

  if (row && row.attempts >= MAX_ATTEMPTS) {
    database.delete(schema.evalQueue).where(eq(schema.evalQueue.commentKey, commentKey)).run();
    const state = loadState();
    markEvalFailed(state, row.commentId, row.repo);
    saveState(state);
  }
}

export function getQueueDepth(): { queued: number; inFlight: number } {
  const rows = db()
    .select({ status: schema.evalQueue.status, cnt: count().as("cnt") })
    .from(schema.evalQueue)
    .groupBy(schema.evalQueue.status)
    .all();
  let queued = 0;
  let inFlight = 0;
  for (const r of rows) {
    if (r.status === "queued") queued = Number(r.cnt);
    if (r.status === "in_flight") inFlight = Number(r.cnt);
  }
  return { queued, inFlight };
}

export function recoverQueue(): void {
  const database = db();
  database
    .update(schema.evalQueue)
    .set({ status: "queued", updatedAt: new Date().toISOString() })
    .where(eq(schema.evalQueue.status, "in_flight"))
    .run();

  const deadLettered = database
    .select({
      commentKey: schema.evalQueue.commentKey,
      commentId: schema.evalQueue.commentId,
      repo: schema.evalQueue.repo,
    })
    .from(schema.evalQueue)
    .where(gte(schema.evalQueue.attempts, MAX_ATTEMPTS))
    .all();

  if (deadLettered.length > 0) {
    const state = loadState();
    for (const row of deadLettered) {
      markEvalFailed(state, row.commentId, row.repo);
      database.delete(schema.evalQueue).where(eq(schema.evalQueue.commentKey, row.commentKey)).run();
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
    const config = loadConfig();
    const cap = concurrency ?? clampEvalConcurrency(config.evalConcurrency ?? 2);
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
        let nextStatus: "pending" | "replied" = "pending";
        if (config.autoResolveOnEvaluation && evaluation.action === "resolve") {
          try {
            await resolveThread(item.repo, item.commentId, item.prNumber, evaluation.reply);
            nextStatus = "replied";
          } catch (err) {
            // Keep the triaged result so users can resolve manually if the API call fails.
            console.error(`Auto-resolve failed for ${item.commentKey}: ${(err as Error).message}`);
          }
        }
        markCommentWithEvaluation(state, item.commentId, nextStatus, item.prNumber, evaluation, item.repo);
        saveState(state);
        completeItem(item.commentKey);
        updateClaudeStats({ evalFinished: true });
        sseBroadcast("eval-complete", {
          repo: item.repo,
          prNumber: item.prNumber,
          commentId: item.commentId,
        });
        broadcastPollStatus();
        if (evaluation) {
          notifyEvalComplete({
            repo: item.repo,
            prNumber: item.prNumber,
            commentId: item.commentId,
            path: item.comment.path,
            line: item.comment.line,
            action: evaluation.action,
            summary: evaluation.summary,
          });
        }
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
