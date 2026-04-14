import { getRawSqlite, openStateDatabase } from "./db/client.js";
import { sseBroadcast } from "./server.js";

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
  openStateDatabase();
  return getRawSqlite();
}

export function loadFixQueue(): void {
  const maxPos = db().prepare("SELECT MAX(position) as m FROM fix_queue").get() as { m: number | null } | undefined;
  nextPosition = (maxPos?.m ?? 0) + 1;
}

export function enqueueFix(req: EnqueueFixRequest): FixQueueItem {
  const now = new Date().toISOString();
  const pos = nextPosition++;
  db().prepare(
    `INSERT INTO fix_queue (comment_id, repo, pr_number, branch, path, line, body, diff_hunk, user_instructions, queued_at, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    req.commentId, req.repo, req.prNumber, req.branch,
    req.comment.path, req.comment.line, req.comment.body, req.comment.diffHunk,
    req.userInstructions ?? null, now, pos,
  );
  const item: FixQueueItem = {
    id: 0, commentId: req.commentId, repo: req.repo, prNumber: req.prNumber,
    branch: req.branch, path: req.comment.path, line: req.comment.line,
    body: req.comment.body, diffHunk: req.comment.diffHunk,
    userInstructions: req.userInstructions ?? null, queuedAt: now, position: pos,
  };
  broadcastQueue();
  return item;
}

export function getFixQueue(): FixQueueItem[] {
  const rows = db()
    .prepare("SELECT * FROM fix_queue ORDER BY position ASC")
    .all() as Array<{
      id: number; comment_id: number; repo: string; pr_number: number;
      branch: string; path: string; line: number; body: string; diff_hunk: string;
      user_instructions: string | null; queued_at: string; position: number;
    }>;
  return rows.map((r) => ({
    id: r.id, commentId: r.comment_id, repo: r.repo, prNumber: r.pr_number,
    branch: r.branch, path: r.path, line: r.line, body: r.body, diffHunk: r.diff_hunk,
    userInstructions: r.user_instructions, queuedAt: r.queued_at, position: r.position,
  }));
}

export function dequeueNextFix(): FixQueueItem | null {
  const row = db()
    .prepare("SELECT * FROM fix_queue ORDER BY position ASC LIMIT 1")
    .get() as {
      id: number; comment_id: number; repo: string; pr_number: number;
      branch: string; path: string; line: number; body: string; diff_hunk: string;
      user_instructions: string | null; queued_at: string; position: number;
    } | undefined;
  if (!row) return null;
  db().prepare("DELETE FROM fix_queue WHERE id = ?").run(row.id);
  broadcastQueue();
  return {
    id: row.id, commentId: row.comment_id, repo: row.repo, prNumber: row.pr_number,
    branch: row.branch, path: row.path, line: row.line, body: row.body, diffHunk: row.diff_hunk,
    userInstructions: row.user_instructions, queuedAt: row.queued_at, position: row.position,
  };
}

export function removeFromFixQueue(commentId: number): boolean {
  const result = db().prepare("DELETE FROM fix_queue WHERE comment_id = ?").run(commentId);
  if (result.changes > 0) {
    broadcastQueue();
    return true;
  }
  return false;
}

export function isInFixQueue(commentId: number): boolean {
  const row = db().prepare("SELECT 1 FROM fix_queue WHERE comment_id = ?").get(commentId);
  return !!row;
}

function broadcastQueue(): void {
  const queue = getFixQueue();
  sseBroadcast("fix-queue", queue.map((q) => ({
    commentId: q.commentId,
    repo: q.repo,
    prNumber: q.prNumber,
    path: q.path,
    position: q.position,
    queuedAt: q.queuedAt,
  })));
}
