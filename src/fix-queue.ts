import { asc, eq, sql } from "drizzle-orm";
import * as schema from "./db/schema.js";
import { openStateDatabase } from "./db/client.js";
import { sseBroadcast, getActiveFixForBranch, setFixJobStatus, getRepos, getAllFixJobStatuses } from "./server.js";
import { loadState, saveState, addFixJob, removeFixJob } from "./state.js";
import { createWorktree, removeWorktree, getDiffInWorktree } from "./worktree.js";
import { applyFixWithClaude } from "./actioner.js";
import type { FixJobRecord } from "./types.js";

export interface FixQueueItem {
  id: number;
  commentId: number;
  repo: string;
  prNumber: number;
  branch: string;
  path: string;
  line: number;
  body: string;
  diffHunk: string;
  userInstructions: string | null;
  queuedAt: string;
  position: number;
}

export interface EnqueueFixRequest {
  commentId: number;
  repo: string;
  prNumber: number;
  branch: string;
  comment: { path: string; line: number; body: string; diffHunk: string };
  userInstructions?: string;
}

let nextPosition = 0;

function db() {
  return openStateDatabase();
}

export function loadFixQueue(): void {
  const row = db()
    .select({ m: sql<number | null>`max(${schema.fixQueue.position})` })
    .from(schema.fixQueue)
    .get();
  nextPosition = (row?.m ?? 0) + 1;
}

export function enqueueFix(req: EnqueueFixRequest): FixQueueItem {
  const now = new Date().toISOString();
  const pos = nextPosition++;
  db()
    .insert(schema.fixQueue)
    .values({
      commentId: req.commentId,
      repo: req.repo,
      prNumber: req.prNumber,
      branch: req.branch,
      path: req.comment.path,
      line: req.comment.line,
      body: req.comment.body,
      diffHunk: req.comment.diffHunk,
      userInstructions: req.userInstructions ?? null,
      queuedAt: now,
      position: pos,
    })
    .run();
  const item: FixQueueItem = {
    id: 0,
    commentId: req.commentId,
    repo: req.repo,
    prNumber: req.prNumber,
    branch: req.branch,
    path: req.comment.path,
    line: req.comment.line,
    body: req.comment.body,
    diffHunk: req.comment.diffHunk,
    userInstructions: req.userInstructions ?? null,
    queuedAt: now,
    position: pos,
  };
  broadcastQueue();
  return item;
}

export function getFixQueue(): FixQueueItem[] {
  const rows = db().select().from(schema.fixQueue).orderBy(asc(schema.fixQueue.position)).all();
  return rows.map((r) => ({
    id: r.id,
    commentId: r.commentId,
    repo: r.repo,
    prNumber: r.prNumber,
    branch: r.branch,
    path: r.path,
    line: r.line,
    body: r.body,
    diffHunk: r.diffHunk,
    userInstructions: r.userInstructions,
    queuedAt: r.queuedAt,
    position: r.position,
  }));
}

export function dequeueNextFix(): FixQueueItem | null {
  const row = db()
    .select()
    .from(schema.fixQueue)
    .orderBy(asc(schema.fixQueue.position))
    .limit(1)
    .get();
  if (!row) return null;
  db().delete(schema.fixQueue).where(eq(schema.fixQueue.id, row.id)).run();
  broadcastQueue();
  return {
    id: row.id,
    commentId: row.commentId,
    repo: row.repo,
    prNumber: row.prNumber,
    branch: row.branch,
    path: row.path,
    line: row.line,
    body: row.body,
    diffHunk: row.diffHunk,
    userInstructions: row.userInstructions,
    queuedAt: row.queuedAt,
    position: row.position,
  };
}

export function removeFromFixQueue(commentId: number): boolean {
  const result = db().delete(schema.fixQueue).where(eq(schema.fixQueue.commentId, commentId)).run();
  if ((result.changes ?? 0) > 0) {
    broadcastQueue();
    return true;
  }
  return false;
}

export function isInFixQueue(commentId: number): boolean {
  const row = db()
    .select({ c: schema.fixQueue.commentId })
    .from(schema.fixQueue)
    .where(eq(schema.fixQueue.commentId, commentId))
    .limit(1)
    .get();
  return !!row;
}

function broadcastQueue(): void {
  const queue = getFixQueue();
  sseBroadcast(
    "fix-queue",
    queue.map((q) => ({
      commentId: q.commentId,
      repo: q.repo,
      prNumber: q.prNumber,
      path: q.path,
      position: q.position,
      queuedAt: q.queuedAt,
    })),
  );
}

export function advanceQueue(): void {
  const statuses = getAllFixJobStatuses();

  // Block if anything is currently running
  if (statuses.some((j) => j.status === "running")) return;

  // Block if a completed fix is waiting for user review
  if (statuses.some((j) => j.status === "completed")) return;

  // Try to dequeue and start the next item
  const queue = getFixQueue();
  for (const item of queue) {
    // Skip if this branch already has an active worktree
    if (getActiveFixForBranch(item.branch)) continue;

    const repoInfo = getRepos().find((r) => r.repo === item.repo);
    if (!repoInfo?.localPath) continue; // skip — repo not found

    // Remove from queue
    db().delete(schema.fixQueue).where(eq(schema.fixQueue.id, item.id)).run();
    broadcastQueue();

    // Start the fix (same flow as the /api/actions/fix handler)
    startFixFromQueue(item, repoInfo.localPath);
    return;
  }
}

function startFixFromQueue(item: FixQueueItem, repoLocalPath: string): void {
  let worktreePath: string;
  try {
    worktreePath = createWorktree(item.branch, repoLocalPath);
  } catch (err) {
    setFixJobStatus({
      commentId: item.commentId,
      repo: item.repo,
      prNumber: item.prNumber,
      path: item.path,
      startedAt: Date.now(),
      status: "failed",
      error: `Failed to create worktree: ${(err as Error).message}`,
    });
    // Try next item
    advanceQueue();
    return;
  }

  const jobRecord: FixJobRecord = {
    commentId: item.commentId,
    repo: item.repo,
    prNumber: item.prNumber,
    branch: item.branch,
    path: item.path,
    worktreePath,
    startedAt: new Date().toISOString(),
  };
  const state = loadState();
  addFixJob(state, jobRecord);
  saveState(state);

  setFixJobStatus({
    commentId: item.commentId,
    repo: item.repo,
    prNumber: item.prNumber,
    path: item.path,
    startedAt: Date.now(),
    status: "running",
  });

  // Run Claude in background (don't await — same pattern as api.ts)
  const sessionId = crypto.randomUUID();
  void (async () => {
    try {
      const result = await applyFixWithClaude(
        worktreePath,
        { path: item.path, line: item.line, body: item.body, diffHunk: item.diffHunk },
        item.userInstructions ?? undefined,
        { sessionId },
      );

      if (result.action === "questions") {
        const conversation = [{ role: "claude" as const, message: result.message }];
        const s = loadState();
        const existingJob = (s.fixJobs ?? []).find((j: FixJobRecord) => j.commentId === item.commentId);
        if (existingJob) {
          existingJob.sessionId = sessionId;
          existingJob.conversation = conversation;
          saveState(s);
        }
        setFixJobStatus({
          commentId: item.commentId,
          repo: item.repo,
          prNumber: item.prNumber,
          path: item.path,
          startedAt: Date.now(),
          status: "awaiting_response",
          branch: item.branch,
          claudeOutput: result.rawOutput,
          sessionId,
          conversation,
        });
        advanceQueue(); // skip — advance to next
        return;
      }

      const diff = getDiffInWorktree(worktreePath);

      if (!diff.trim()) {
        removeWorktree(item.branch, repoLocalPath);
        const s = loadState();
        removeFixJob(s, item.commentId);
        saveState(s);
        setFixJobStatus({
          commentId: item.commentId,
          repo: item.repo,
          prNumber: item.prNumber,
          path: item.path,
          startedAt: Date.now(),
          status: "no_changes",
          suggestedReply: result.message,
          claudeOutput: result.message,
        });
        advanceQueue(); // skip — advance to next
        return;
      }

      const s = loadState();
      removeFixJob(s, item.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: item.commentId,
        repo: item.repo,
        prNumber: item.prNumber,
        path: item.path,
        startedAt: Date.now(),
        status: "completed",
        diff,
        branch: item.branch,
        claudeOutput: result.message,
        conversation: [{ role: "claude" as const, message: result.message }],
      });
      // completed blocks queue — don't advance
    } catch (err) {
      removeWorktree(item.branch, repoLocalPath);
      const s = loadState();
      removeFixJob(s, item.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: item.commentId,
        repo: item.repo,
        prNumber: item.prNumber,
        path: item.path,
        startedAt: Date.now(),
        status: "failed",
        error: (err as Error).message,
      });
      advanceQueue(); // skip — advance to next
    }
  })();
}
