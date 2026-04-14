# Evaluation Queue Design

**Date:** 2026-04-14
**Status:** Approved

## Problem

The current evaluation flow relies on `isNewComment()` to gate automatic Claude evaluations during the poll cycle. This is brittle:

- If a comment lands in state without an evaluation (eval error, race condition, poller hasn't run yet), it's stuck forever — `isNewComment()` returns false and the comment is never retried.
- The web API fetches comments directly from GitHub and merges with state, but never triggers evaluations. Users must wait for the next poll cycle or manually hit re-evaluate.
- There is no visibility into whether an evaluation is in progress — the frontend can't distinguish "not yet evaluated" from "evaluation running."

## Solution

Replace the `isNewComment` gate with an SQLite-backed evaluation queue. Both the poller and the web API enqueue comments that lack evaluations. A background worker drains the queue with bounded concurrency. A new `evaluating` comment status provides accurate state at all times.

## New Comment Status: `evaluating`

Added to the `CommentStatus` union alongside `"pending"`, `"replied"`, `"dismissed"`, `"fixed"`.

**State transitions:**

```text
(not in state) ──→ evaluating ──→ pending (with evaluation)
                       │
                       ↓ (on error, attempts < 3)
                   evaluating → queued for retry
                       │
                       ↓ (on error, attempts >= 3)
                   pending (no evaluation, dead-lettered)
```

The frontend shows an "Evaluating..." badge for comments in this status.

## SQLite-Backed Evaluation Queue

### Schema

New `eval_queue` table in `state.sqlite`:

```sql
CREATE TABLE IF NOT EXISTS eval_queue (
  comment_key  TEXT PRIMARY KEY,   -- repo:commentId (same format as comments table)
  comment_id   INTEGER NOT NULL,
  repo         TEXT NOT NULL,
  pr_number    INTEGER NOT NULL,
  comment_json TEXT NOT NULL,      -- serialized CrComment for eval prompt
  status       TEXT NOT NULL,      -- 'queued' | 'in_flight'
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

### Crash Recovery

On startup, any `in_flight` rows are reset to `queued` (they were interrupted by a crash/restart). Rows with `attempts >= 3` are removed from the queue and their comment is marked `pending` with no evaluation (dead-lettered — the user can still manually re-evaluate).

### Module: `src/eval-queue.ts`

**API surface:**

- `enqueueEvaluation(comment: CrComment, prNumber: number, repo: string): "queued" | "already-evaluated" | "already-queued"` — inserts into `eval_queue` if not already there and comment doesn't already have an evaluation in state. Atomically marks comment status as `evaluating`.
- `enqueueMany(comments: CrComment[], pullsByNumber: Record<number, PrInfo>, repo: string): void` — batch version for the poller. Calls `enqueueEvaluation` for each comment.
- `drainQueue(): void` — called after enqueue and on a 30-second periodic tick (ensures retries and crash-recovery items are picked up even without new enqueues). Pulls `queued` rows, marks them `in_flight`, runs `evaluateComment()` with bounded concurrency (reuses `runWithConcurrency` and `evalConcurrency` config).
- `getQueueDepth(): { queued: number; inFlight: number }` — for status bar / SSE.
- `shutdown(): Promise<void>` — stops accepting new items, waits for in-flight work to finish. Called during CLI shutdown.

**On success:** Remove from `eval_queue`, call `markCommentWithEvaluation()` and `saveState()`, broadcast SSE `"eval-complete"` event.

**On error:** Increment `attempts` in `eval_queue`, set queue status back to `queued`. If `attempts >= 3`, remove from queue and mark comment as `pending` with `evalFailed: true` — dead-lettered. The frontend shows an "Eval failed" badge for these comments, and the re-evaluate button remains available.

## Integration Points

### Poller (`cli.ts` → `poll()`)

Replace the `analyzeComments()` call with `enqueueMany()`. The poller no longer evaluates directly — it discovers comments and feeds the queue.

The filter predicate changes from `isNewComment(repo, commentId)` to `needsEvaluation(repo, commentId)` — which returns true when the comment has no evaluation in state, is not currently `evaluating`, and has not already been acted on (`replied`/`dismissed`/`fixed`).

### Web API (`GET /api/pulls/:number/comments`)

After fetching comments from GitHub and merging with state, iterate the results. Any comment that:

- has no evaluation in state, AND
- is not in `evaluating` status, AND
- is not from an ignored bot

gets enqueued via `enqueueEvaluation()`. The API returns immediately — evaluation happens asynchronously via the queue worker.

All comments in a thread are eligible (not just root comments), since replies can change the needed action through back-and-forth discussion.

### Re-evaluate Endpoint (`POST /api/actions/re-evaluate`)

Changes from synchronous to async: resets the comment's state, clears any existing queue entry (resetting attempts to 0), enqueues, and returns `{ success: true, status: "queued" }`. The frontend shows the `evaluating` badge and picks up the result via SSE.

### Startup (`cli.ts`)

Call crash recovery (reset `in_flight` → `queued`, dead-letter `attempts >= 3`), then `drainQueue()` to resume any items from a previous session.

## SSE: `eval-complete` Event

New SSE event type broadcast when an evaluation finishes:

```json
{ "repo": "owner/repo", "prNumber": 123, "commentId": 456 }
```

The frontend subscribes in the existing `EventSource` setup. On receipt, if the currently selected PR matches `repo` + `prNumber`, calls `reloadComments()`.

## Frontend Changes

### `evaluating` Status Badge

In `CommentThreads.tsx` `ThreadItem`: when `crStatus === "evaluating"`, show a pulsing "Evaluating..." badge. Disable action buttons (reply, resolve, dismiss, fix) while evaluating.

### Auto-refresh via SSE

Listen for `"eval-complete"` events. When the event's `repo` and `prNumber` match the selected PR, call `reloadComments()` to pick up the new evaluation. This eliminates the need for manual refresh or re-evaluate to see results.

### Re-evaluate Button

Changes from "wait for result" to fire-and-forget. Click enqueues and the comment transitions to the `evaluating` badge. Result appears via SSE-triggered refresh.

## What Gets Removed

- `analyzeComments()` in `actioner.ts` — replaced by queue enqueue + worker drain. `evaluateComment()` itself stays (the worker calls it).
- `isNewComment()` in `state.ts` — replaced by `needsEvaluation()` which checks for missing evaluation in state.
- Inline synchronous evaluation in the `POST /api/actions/re-evaluate` endpoint.

## What Stays

- `evaluateComment()` in `actioner.ts` — the actual Claude evaluation logic, called by the queue worker.
- `parseEvaluation()` in `actioner.ts` — response parsing.
- `markCommentWithEvaluation()` in `state.ts` — state persistence.
- `filterCommentsForPoll()` in `poller.ts` — still filters bots and resolved comments, but uses the new `needsEvaluation` predicate instead of `isNewComment`.
