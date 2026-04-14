# Evaluation Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the brittle `isNewComment` evaluation gate with an SQLite-backed evaluation queue that ensures all comments get evaluated automatically, with crash recovery and retry.

**Architecture:** New `src/eval-queue.ts` module owns a persistent `eval_queue` SQLite table and a background worker. Both the poller and web API enqueue comments missing evaluations. The worker drains the queue with bounded concurrency, persists results, and broadcasts SSE events. A new `evaluating` comment status gives accurate state to the frontend.

**Tech Stack:** TypeScript/ESM, better-sqlite3 (direct — matches existing `getRawSqlite()` pattern), Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-04-14-eval-queue-design.md`

---

### Task 1: Add `evaluating` to CommentStatus and `evalFailed` flag

**Files:**
- Modify: `src/types.ts:1` (CommentStatus union)
- Modify: `src/types.ts:4-16` (CommentRecord — add `evalFailed`)
- Modify: `web/src/types.ts:83` (crStatus union)
- Modify: `web/src/types.ts:69-87` (ReviewComment — add `evalFailed`)
- Modify: `src/api.ts:540` (comments endpoint — pass through `evalFailed`)

- [ ] **Step 1: Update backend CommentStatus**

In `src/types.ts`, change line 1:

```typescript
export type CommentStatus = "pending" | "evaluating" | "replied" | "fixed" | "dismissed";
```

Add `evalFailed` to `CommentRecord` (after `triageNote`):

```typescript
/** True when evaluation failed after max retries (dead-lettered). */
evalFailed?: boolean;
```

- [ ] **Step 2: Update frontend types**

In `web/src/types.ts`, change line 83:

```typescript
crStatus: "pending" | "evaluating" | "replied" | "fixed" | "dismissed" | null;
```

Add to `ReviewComment` interface (after `triageNote`):

```typescript
evalFailed?: boolean;
```

- [ ] **Step 3: Pass `evalFailed` through comments API**

In `src/api.ts`, in the `GET /api/pulls/:number/comments` handler (around line 540), add `evalFailed` to the returned object:

```typescript
evalFailed: record?.evalFailed ?? false,
```

- [ ] **Step 4: Persist `evalFailed` in SQLite**

In `src/db/client.ts`, add to `migrateCommentsColumns`:

```typescript
if (!names.has("eval_failed")) {
  raw.exec("ALTER TABLE comments ADD COLUMN eval_failed INTEGER DEFAULT 0");
}
```

In `writeStateToDb`, add `eval_failed` to the INSERT statement and the values:

```typescript
// In the INSERT column list, after triage_note:
// , eval_failed
// In the VALUES placeholders:
// , @eval_failed
// In the run() call:
eval_failed: v.evalFailed ? 1 : 0,
```

In `loadState`, after the `triageNote` spread, add:

```typescript
...(row.evalFailed ? { evalFailed: true } : {}),
```

Note: `row.evalFailed` is read from the `eval_failed` column (the drizzle ORM auto-maps `eval_failed` → `evalFailed` via the schema). Add the column to `src/db/schema.ts` `comments` table:

```typescript
evalFailed: integer("eval_failed"),
```

- [ ] **Step 5: Run tests and build**

Run: `yarn test && yarn build:all`
Expected: PASS — no functional changes yet, just type additions.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts web/src/types.ts src/api.ts src/db/client.ts src/db/schema.ts
git commit -m "feat: add 'evaluating' comment status and evalFailed flag"
```

---

### Task 2: Add `eval_queue` table and `needsEvaluation` predicate

**Files:**
- Modify: `src/db/client.ts:31-70` (ensureSchema — add eval_queue table)
- Modify: `src/state.ts` (add `needsEvaluation`, `markEvaluating`, `markEvalFailed`)
- Test: `src/state.test.ts`

- [ ] **Step 1: Write failing tests for `needsEvaluation` and `markEvaluating`**

Add to `src/state.test.ts`:

```typescript
import { needsEvaluation, markEvaluating, markEvalFailed } from "./state.js";

describe("evaluation state helpers", () => {
  it("needsEvaluation returns true for comments without evaluation", () => {
    const s = loadState();
    // Not in state at all — needs evaluation
    expect(needsEvaluation(s, 100, "o/r")).toBe(true);

    // In state as pending with no evaluation — needs evaluation
    markComment(s, 100, "pending", 1, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 100, "o/r")).toBe(true);
  });

  it("needsEvaluation returns false for comments with evaluation", () => {
    const s = loadState();
    markCommentWithEvaluation(s, 200, "pending", 1, { action: "reply", summary: "ok", reply: "hi" }, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 200, "o/r")).toBe(false);
  });

  it("needsEvaluation returns false for evaluating status", () => {
    const s = loadState();
    markEvaluating(s, 300, 1, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 300, "o/r")).toBe(false);
  });

  it("needsEvaluation returns false for acted-on comments", () => {
    const s = loadState();
    markComment(s, 400, "replied", 1, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 400, "o/r")).toBe(false);
  });

  it("needsEvaluation returns false for dead-lettered (evalFailed) comments", () => {
    const s = loadState();
    markEvaluating(s, 700, 1, "o/r");
    markEvalFailed(s, 700, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 700, "o/r")).toBe(false);
  });

  it("markEvaluating sets status to evaluating", () => {
    const s = loadState();
    markEvaluating(s, 500, 1, "o/r");
    saveState(s);
    const loaded = loadState();
    expect(loaded.comments["o/r:500"]?.status).toBe("evaluating");
  });

  it("markEvalFailed sets evalFailed and pending status", () => {
    const s = loadState();
    markEvaluating(s, 600, 1, "o/r");
    markEvalFailed(s, 600, "o/r");
    saveState(s);
    const loaded = loadState();
    expect(loaded.comments["o/r:600"]?.status).toBe("pending");
    expect(loaded.comments["o/r:600"]?.evalFailed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/state.test.ts`
Expected: FAIL — `needsEvaluation`, `markEvaluating`, `markEvalFailed` not exported.

- [ ] **Step 3: Add `eval_queue` table to schema**

In `src/db/client.ts`, inside `ensureSchema`, after the `repo_access` CREATE TABLE, add:

```typescript
    CREATE TABLE IF NOT EXISTS eval_queue (
      comment_key  TEXT PRIMARY KEY,
      comment_id   INTEGER NOT NULL,
      repo         TEXT NOT NULL,
      pr_number    INTEGER NOT NULL,
      comment_json TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued',
      attempts     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
```

- [ ] **Step 4: Implement `needsEvaluation`, `markEvaluating`, `markEvalFailed` in `src/state.ts`**

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/state.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/client.ts src/state.ts src/state.test.ts
git commit -m "feat: add eval_queue table, needsEvaluation predicate, and evaluating state helpers"
```

---

### Task 3: Create `src/eval-queue.ts` — core queue operations

**Files:**
- Create: `src/eval-queue.ts`
- Test: `src/eval-queue.test.ts`

- [ ] **Step 1: Write failing tests for enqueue and queue reads**

Create `src/eval-queue.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeStateDatabase, getStateDir } from "./db/client.js";
import { loadState, markCommentWithEvaluation, saveState } from "./state.js";
import { enqueueEvaluation, getQueueDepth, dequeueItems, markInFlight, completeItem, failItem, recoverQueue } from "./eval-queue.js";
import type { CrComment } from "./types.js";

let testRoot: string;

function makeComment(id: number, prNumber = 1): CrComment {
  return { id, prNumber, path: "src/foo.ts", line: 10, diffHunk: "@@ -1,3 +1,3 @@", body: "fix this", inReplyToId: null };
}

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "eval-queue-"));
  process.env.CODE_TRIAGE_STATE_DIR = testRoot;
});

afterAll(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  closeStateDatabase();
  const dir = getStateDir();
  mkdirSync(dir, { recursive: true });
  for (const f of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
    const p = join(dir, f);
    if (existsSync(p)) rmSync(p);
  }
});

describe("eval-queue", () => {
  it("enqueueEvaluation returns 'queued' for new comment", () => {
    const state = loadState();
    const result = enqueueEvaluation(makeComment(1), 1, "o/r", state);
    expect(result).toBe("queued");
    expect(state.comments["o/r:1"]?.status).toBe("evaluating");
  });

  it("enqueueEvaluation returns 'already-evaluated' for comment with evaluation", () => {
    const state = loadState();
    markCommentWithEvaluation(state, 2, "pending", 1, { action: "reply", summary: "ok", reply: "hi" }, "o/r");
    saveState(state);
    const result = enqueueEvaluation(makeComment(2), 1, "o/r", state);
    expect(result).toBe("already-evaluated");
  });

  it("enqueueEvaluation returns 'already-queued' for duplicate enqueue", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(3), 1, "o/r", state);
    saveState(state);
    const result = enqueueEvaluation(makeComment(3), 1, "o/r", state);
    expect(result).toBe("already-queued");
  });

  it("dequeueItems returns queued items up to limit", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(10), 1, "o/r", state);
    enqueueEvaluation(makeComment(11), 1, "o/r", state);
    enqueueEvaluation(makeComment(12), 1, "o/r", state);
    saveState(state);
    const items = dequeueItems(2);
    expect(items).toHaveLength(2);
    expect(items[0].commentId).toBe(10);
    expect(items[1].commentId).toBe(11);
  });

  it("markInFlight transitions queued to in_flight", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(20), 1, "o/r", state);
    saveState(state);
    const items = dequeueItems(1);
    markInFlight(items[0].commentKey);
    const depth = getQueueDepth();
    expect(depth.inFlight).toBe(1);
    expect(depth.queued).toBe(0);
  });

  it("completeItem removes from queue", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(30), 1, "o/r", state);
    saveState(state);
    completeItem("o/r:30");
    const depth = getQueueDepth();
    expect(depth.queued).toBe(0);
    expect(depth.inFlight).toBe(0);
  });

  it("failItem increments attempts and resets to queued", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(40), 1, "o/r", state);
    saveState(state);
    failItem("o/r:40");
    const items = dequeueItems(1);
    expect(items[0].attempts).toBe(1);
  });

  it("failItem with attempts >= 3 removes from queue", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(50), 1, "o/r", state);
    saveState(state);
    failItem("o/r:50");
    failItem("o/r:50");
    failItem("o/r:50"); // 3rd failure
    const depth = getQueueDepth();
    expect(depth.queued).toBe(0);
  });

  it("recoverQueue resets in_flight to queued", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(60), 1, "o/r", state);
    saveState(state);
    markInFlight("o/r:60");
    recoverQueue();
    const depth = getQueueDepth();
    expect(depth.queued).toBe(1);
    expect(depth.inFlight).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/eval-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/eval-queue.ts` — queue CRUD operations**

```typescript
import { getRawSqlite, openStateDatabase } from "./db/client.js";
import { loadState, markEvaluating, needsEvaluation, saveState, markEvalFailed } from "./state.js";
import type { CrComment } from "./types.js";

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
  state: ReturnType<typeof loadState>,
): "queued" | "already-evaluated" | "already-queued" {
  if (!needsEvaluation(state, comment.id, repo)) {
    return "already-evaluated";
  }

  const commentKey = `${repo}:${comment.id}`;
  const sqlite = db();
  const existing = sqlite.prepare("SELECT comment_key FROM eval_queue WHERE comment_key = ?").get(commentKey);
  if (existing) {
    return "already-queued";
  }

  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO eval_queue (comment_key, comment_id, repo, pr_number, comment_json, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
  ).run(commentKey, comment.id, repo, prNumber, JSON.stringify(comment), now, now);

  markEvaluating(state, comment.id, prNumber, repo);
  return "queued";
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
    // Mark as dead-lettered in state
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

  // Dead-letter items that have exceeded max attempts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/eval-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/eval-queue.ts src/eval-queue.test.ts
git commit -m "feat: SQLite-backed eval queue with enqueue, dequeue, retry, and crash recovery"
```

---

### Task 4: Add queue worker (drain loop)

**Files:**
- Modify: `src/eval-queue.ts` (add `startWorker`, `stopWorker`, `drainOnce`)
- Test: `src/eval-queue.test.ts` (add worker tests with mocked `evaluateComment`)

- [ ] **Step 1: Write failing test for `drainOnce`**

Add to `src/eval-queue.test.ts`:

```typescript
import { vi } from "vitest";
import { drainOnce } from "./eval-queue.js";

// At top of file, mock the evaluateComment function
vi.mock("./actioner.js", () => ({
  evaluateComment: vi.fn().mockResolvedValue({ action: "reply", summary: "ok", reply: "hi" }),
  clampEvalConcurrency: (n: number) => Math.min(8, Math.max(1, n)),
}));

// Also mock server.js to avoid SSE side effects
vi.mock("./server.js", () => ({
  updateClaudeStats: vi.fn(),
  sseBroadcast: vi.fn(),
  broadcastPollStatus: vi.fn(),
}));

describe("eval-queue worker", () => {
  it("drainOnce evaluates queued items and stores results", async () => {
    const state = loadState();
    enqueueEvaluation(makeComment(70), 1, "o/r", state);
    saveState(state);

    await drainOnce(2);

    const depth = getQueueDepth();
    expect(depth.queued).toBe(0);
    expect(depth.inFlight).toBe(0);

    const updated = loadState();
    expect(updated.comments["o/r:70"]?.status).toBe("pending");
    expect(updated.comments["o/r:70"]?.evaluation?.action).toBe("reply");
  });

  it("drainOnce handles evaluation failure with retry", async () => {
    const { evaluateComment } = await import("./actioner.js");
    (evaluateComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Claude unavailable"));

    const state = loadState();
    enqueueEvaluation(makeComment(80), 1, "o/r", state);
    saveState(state);

    await drainOnce(2);

    // Item should be back in queue with attempts = 1
    const items = dequeueItems(10);
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/eval-queue.test.ts`
Expected: FAIL — `drainOnce` not exported.

- [ ] **Step 3: Implement `drainOnce`, `startWorker`, `stopWorker`**

Add to `src/eval-queue.ts`:

```typescript
import { evaluateComment } from "./actioner.js";
import { markCommentWithEvaluation } from "./state.js";
import { updateClaudeStats, sseBroadcast, broadcastPollStatus } from "./server.js";
import { loadConfig } from "./config.js";
import { clampEvalConcurrency } from "./actioner.js";
import { runWithConcurrency } from "./run-with-concurrency.js";

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
  // Also drain immediately on start
  void drainOnce();
}

export function stopWorker(): Promise<void> {
  stopped = true;
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  // Wait for in-flight drain to finish
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (!draining) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/eval-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/eval-queue.ts src/eval-queue.test.ts
git commit -m "feat: eval queue worker with drain loop, SSE broadcast, and bounded concurrency"
```

---

### Task 5: Wire poller to use eval queue

**Files:**
- Modify: `src/cli.ts:416-434` (replace `analyzeComments` call with `enqueueMany`)
- Modify: `src/cli.ts:443-456` (fallback path too)
- Modify: `src/cli.ts:1-10` (imports)
- Modify: `src/cli.ts:296-303` (startup — add recoverQueue + startWorker)
- Modify: `src/cli.ts:552-570` (shutdown — add stopWorker)
- Modify: `src/poller.ts:62-71` (change filter predicate)
- Modify: `src/eval-queue.ts` (add `enqueueMany`)

- [ ] **Step 1: Add `enqueueMany` to `src/eval-queue.ts`**

```typescript
import type { CrComment, CrWatchState, PrInfo } from "./types.js";

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
```

- [ ] **Step 2: Update poller filter predicate**

In `src/poller.ts`, change `filterCommentsForPoll` to accept a generic predicate name. The function signature stays the same — the callers pass different predicates. No change to the function itself.

In `src/poller.ts` `buildPollResultForRepo`, change the `isNewComment` parameter name to `shouldInclude` for clarity, and in the `filterCommentsForPoll` call:

```typescript
// In buildPollResultForRepo signature, rename:
shouldInclude: (repo: string, commentId: number) => boolean,

// The filterCommentsForPoll call already uses it correctly:
const relevantComments = filterCommentsForPoll(comments, resolvedIds, ignoredBots, (id) =>
  shouldInclude(repoPath, id),
);
```

In `fetchNewCommentsBatch`, rename the parameter:

```typescript
shouldInclude: (repo: string, commentId: number) => boolean,
```

In `fetchNewComments`, rename accordingly:

```typescript
export async function fetchNewComments(
  repo: string | undefined,
  shouldInclude: (id: number) => boolean,
  ...
```

- [ ] **Step 3: Update `cli.ts` — replace `analyzeComments` with queue enqueue**

In imports, replace:

```typescript
// Remove:
import { analyzeComments, clampEvalConcurrency, killAllChildren } from "./actioner.js";
// Add:
import { clampEvalConcurrency, killAllChildren } from "./actioner.js";
import { enqueueMany, recoverQueue, startWorker, stopWorker, drainOnce } from "./eval-queue.js";
import { needsEvaluation } from "./state.js";
```

In the `poll()` function, replace the `isNewComment` calls with `needsEvaluation`:

```typescript
// Change the batch call:
const batch = await fetchNewCommentsBatch(
  reposToPoll,
  (repo, id) => needsEvaluation(state, id, repo),
  pollReviewRequested,
  githubLogin,
);
```

Replace the `analyzeComments` call in the batch loop (around line 434):

```typescript
if (comments.length > 0) {
  notifyNewComments(comments, pullsByNumber);
  enqueueMany(comments, repoInfo.repo, state);
}
```

Same change in the fallback loop (around line 455):

```typescript
if (comments.length > 0) {
  notifyNewComments(comments, pullsByNumber);
  enqueueMany(comments, repoInfo.repo, state);
}
```

Remove the `evalConcurrency` argument that was passed to `analyzeComments` — the queue reads concurrency from config directly.

- [ ] **Step 4: Add startup recovery and worker**

After the worktree pruning block (around line 303), add:

```typescript
// Recover any interrupted eval queue items from previous session
recoverQueue();
startWorker();
```

- [ ] **Step 5: Add worker shutdown**

In the `shutdown()` function, after `killAllChildren()`:

```typescript
void stopWorker();
```

- [ ] **Step 6: Update fallback fetchNewComments call**

In the fallback single-repo loop, update the predicate:

```typescript
const { comments, pullsByNumber } = await fetchNewComments(
  repoInfo.repo,
  (id) => needsEvaluation(state, id, repoInfo.repo),
  pollReviewRequested,
  githubLogin,
);
```

- [ ] **Step 7: Run tests and build**

Run: `yarn test && yarn build:all`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/poller.ts src/eval-queue.ts
git commit -m "feat: wire poller to eval queue instead of inline analyzeComments"
```

---

### Task 6: Wire web API to enqueue on comment fetch

**Files:**
- Modify: `src/api.ts:513-547` (GET /api/pulls/:number/comments — enqueue missing evals)
- Modify: `src/api.ts:688-723` (POST /api/actions/re-evaluate — make async)
- Modify: `src/api.ts:1-9` (imports)

- [ ] **Step 1: Update imports in `src/api.ts`**

Add to imports:

```typescript
import { enqueueEvaluation, drainOnce } from "./eval-queue.js";
import { needsEvaluation } from "./state.js";
import { buildIgnoredBotSet } from "./poller.js";
```

- [ ] **Step 2: Add auto-enqueue to GET comments endpoint**

In `src/api.ts`, after the `json(res, comments.map(...))` block in the `GET /api/pulls/:number/comments` handler, add enqueue logic BEFORE the json response. Restructure to:

```typescript
addRoute("GET", "/api/pulls/:number/comments", async (_req, res, params, query) => {
  const repo = requireRepo(query);
  const prNumber = parseInt(params.number, 10);

  const pollByPr = await batchPullPollData(repo, [prNumber]);
  const poll = pollByPr.get(prNumber);
  const comments = poll?.comments ?? [];
  const resolvedIds = poll?.resolvedIds ?? new Set<number>();

  const state = loadState();
  const config = loadConfig();
  const ignoredBots = buildIgnoredBotSet(config.ignoredBots);

  // Enqueue evaluations for comments missing them
  let enqueued = 0;
  for (const c of comments) {
    if (ignoredBots.has(c.user.login)) continue;
    if (!needsEvaluation(state, c.id, repo)) continue;
    const crComment = {
      id: c.id,
      prNumber,
      path: c.path,
      line: c.line || c.original_line || 0,
      diffHunk: c.diff_hunk,
      body: c.body,
      inReplyToId: c.in_reply_to_id ?? null,
    };
    const result = enqueueEvaluation(crComment, prNumber, repo, state);
    if (result === "queued") enqueued++;
  }
  if (enqueued > 0) {
    saveState(state);
    void drainOnce();
  }

  json(res, comments.map((c) => {
    const stateKey = `${repo}:${c.id}`;
    const record = state.comments[stateKey];
    return {
      id: c.id,
      htmlUrl: c.html_url ?? "",
      author: c.user.login,
      authorAvatar: c.user.avatar_url ?? "",
      path: c.path,
      line: c.line || c.original_line || 0,
      diffHunk: c.diff_hunk,
      body: c.body,
      createdAt: c.created_at ?? "",
      inReplyToId: c.in_reply_to_id ?? null,
      isResolved: resolvedIds.has(c.id),
      evaluation: record?.evaluation ?? null,
      crStatus: record?.status ?? null,
      snoozeUntil: record?.snoozeUntil ?? null,
      priority: record?.priority ?? null,
      triageNote: record?.triageNote ?? null,
      evalFailed: record?.evalFailed ?? false,
    };
  }));
});
```

- [ ] **Step 3: Make re-evaluate endpoint async**

Replace the `POST /api/actions/re-evaluate` handler:

```typescript
addRoute("POST", "/api/actions/re-evaluate", async (req, res) => {
  const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
  const state = loadState();

  // Fetch comment from GitHub to get current content
  let ghComment: { id: number; path: string; line: number | null; original_line: number | null; diff_hunk: string; body: string; in_reply_to_id: number | null };
  try {
    ghComment = await ghAsync<typeof ghComment>(`/repos/${body.repo}/pulls/comments/${body.commentId}`);
  } catch (err) {
    json(res, { error: `Failed to fetch comment: ${(err as Error).message}` }, 500);
    return;
  }

  const comment = {
    id: ghComment.id,
    prNumber: body.prNumber,
    path: ghComment.path,
    line: ghComment.line ?? ghComment.original_line ?? 0,
    diffHunk: ghComment.diff_hunk,
    body: ghComment.body,
    inReplyToId: ghComment.in_reply_to_id ?? null,
  };

  // Clear any existing queue entry and reset state
  const sqlite = getRawSqlite();
  sqlite.prepare("DELETE FROM eval_queue WHERE comment_key = ?").run(`${body.repo}:${body.commentId}`);

  // Remove evalFailed flag if present
  const key = `${body.repo}:${body.commentId}`;
  if (state.comments[key]) {
    delete state.comments[key].evalFailed;
  }

  const result = enqueueEvaluation(comment, body.prNumber, body.repo, state);
  saveState(state);
  if (result === "queued") void drainOnce();
  json(res, { success: true, status: result });
});
```

Add import for `getRawSqlite` at the top of `src/api.ts`:

```typescript
import { getRawSqlite } from "./db/client.js";
```

- [ ] **Step 4: Run tests and build**

Run: `yarn test && yarn build:all`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/api.ts
git commit -m "feat: web API auto-enqueues evaluations on comment fetch, re-evaluate is async"
```

---

### Task 7: Frontend — `evaluating` badge and SSE refresh

**Files:**
- Modify: `web/src/components/CommentThreads.tsx:80-103` (badges)
- Modify: `web/src/components/CommentThreads.tsx:121` (ThreadItem — disable actions while evaluating)
- Modify: `web/src/App.tsx:451-465` (SSE listener — add eval-complete)

- [ ] **Step 1: Add evaluating badge in `CommentThreads.tsx`**

Add to `ThreadStatusBadge`:

```typescript
function ThreadStatusBadge({ status }: { status: string }) {
  if (status === "evaluating") return <StatusBadge color="blue" className="animate-pulse">Evaluating...</StatusBadge>;
  if (status === "replied") return <StatusBadge color="green" icon={<Check size={12} />}>Replied</StatusBadge>;
  if (status === "dismissed") return <StatusBadge color="gray">Dismissed</StatusBadge>;
  if (status === "fixed") return <StatusBadge color="blue" icon={<Check size={12} />}>Fixed</StatusBadge>;
  return null;
}
```

- [ ] **Step 2: Show eval-failed badge and disable actions while evaluating**

In `ThreadItem`, add `isEvaluating` derived state:

```typescript
const isEvaluating = status === "evaluating";
```

In the badge display area (around line 289), show evaluating status even when not acted on:

```typescript
{isEvaluating && <ThreadStatusBadge status="evaluating" />}
{!isEvaluating && isActedOn && <ThreadStatusBadge status={status!} />}
{!isEvaluating && !isActedOn && eval_ && <EvalBadge action={eval_.action} />}
```

For eval-failed comments, show a distinct badge. In `EvalBadge` or alongside it, check for `evalFailed` on the thread root. Access it from props — add `evalFailed` to the thread root data. In the badge area:

```typescript
{!isEvaluating && !isActedOn && !eval_ && thread.root.evalFailed && (
  <StatusBadge color="gray" className="text-red-400">Eval failed</StatusBadge>
)}
```

Disable action buttons while evaluating — update the condition in the action buttons section:

```typescript
{!isActedOn && !thread.isResolved && !isEvaluating && (
```

- [ ] **Step 3: Add SSE listener for `eval-complete` in `App.tsx`**

In the `useEffect` that creates the `EventSource` (around line 452), add:

```typescript
es.addEventListener("eval-complete", (ev) => {
  try {
    const data = JSON.parse((ev as MessageEvent).data) as { repo?: string; prNumber?: number };
    if (
      data.repo && data.prNumber &&
      selectedPRRef.current?.repo === data.repo &&
      selectedPRRef.current?.number === data.prNumber
    ) {
      void reloadComments();
    }
  } catch { /* ignore */ }
});
```

Add `selectedPRRef` (it already exists as `selectedPRRef` from line 209). Add `reloadComments` to the ref pattern to avoid stale closures — create a ref:

```typescript
const reloadCommentsRef = useRef(reloadComments);
reloadCommentsRef.current = reloadComments;
```

And in the listener, use `reloadCommentsRef.current()` instead of `reloadComments()`.

Add `reloadCommentsRef` to the dependency considerations (no need to add to deps array since it's a ref).

- [ ] **Step 4: Add `evalFailed` to frontend ReviewComment usage**

The `ReviewComment` type already has `evalFailed` from Task 1. The `thread.root` object is of type `ReviewComment`, so `thread.root.evalFailed` is already available.

- [ ] **Step 5: Build frontend**

Run: `yarn build:all`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/CommentThreads.tsx web/src/App.tsx
git commit -m "feat: evaluating badge, eval-failed state, and SSE auto-refresh for evaluations"
```

---

### Task 8: Remove dead code and update tests

**Files:**
- Modify: `src/actioner.ts` (remove `analyzeComments`)
- Modify: `src/state.ts` (remove `isNewComment`)
- Modify: `src/state.test.ts` (remove `isNewComment` tests, keep `needsEvaluation` tests)
- Modify: `src/actioner.test.ts` (remove `analyzeComments` tests if any)

- [ ] **Step 1: Remove `analyzeComments` from `src/actioner.ts`**

Delete the `analyzeComments` function (lines 322-375). Keep `evaluateComment`, `parseEvaluation`, `postReply`, `resolveThread`, `applyFixWithClaude`, `clampEvalConcurrency`, `killAllChildren`.

- [ ] **Step 2: Remove `isNewComment` from `src/state.ts`**

Delete the `isNewComment` function (lines 187-192). The `needsEvaluation` function replaces it.

- [ ] **Step 3: Update `src/state.test.ts`**

Remove the `isNewComment` test (the "isNewComment matches prefixed keys" test). The `needsEvaluation` tests from Task 2 cover the replacement.

Update the import line to remove `isNewComment`:

```typescript
import { compactCommentHistory, loadState, markComment, markCommentWithEvaluation, patchCommentTriage, saveState, needsEvaluation, markEvaluating, markEvalFailed } from "./state.js";
```

- [ ] **Step 4: Check `src/actioner.test.ts` for references to removed functions**

Read the file and remove any tests that reference `analyzeComments`. If the test file only tests `parseEvaluation`, leave it as-is.

- [ ] **Step 5: Update imports that referenced `analyzeComments` or `isNewComment`**

Search for any remaining imports of `analyzeComments` or `isNewComment` and remove them. The only callers should have been `cli.ts` (updated in Task 5) and `state.test.ts` (updated above).

- [ ] **Step 6: Run all tests and build**

Run: `yarn test && yarn build:all`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/actioner.ts src/state.ts src/state.test.ts src/actioner.test.ts
git commit -m "refactor: remove analyzeComments and isNewComment, replaced by eval queue"
```

---

### Task 9: Update poller tests

**Files:**
- Modify: `src/poller.test.ts` (update predicate references from `isNewComment` to `shouldInclude`/`needsEvaluation`)

- [ ] **Step 1: Read `src/poller.test.ts` and update any `isNewComment` references**

If tests call `filterCommentsForPoll` or `fetchNewComments` with an `isNewComment` parameter, the parameter name changed but the type signature is identical (`(id: number) => boolean`). The tests should still pass since only parameter names changed. Verify and fix any issues.

- [ ] **Step 2: Run poller tests**

Run: `yarn test src/poller.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `yarn test`
Expected: PASS

- [ ] **Step 4: Commit (if changes needed)**

```bash
git add src/poller.test.ts
git commit -m "test: update poller tests for renamed predicate parameter"
```
