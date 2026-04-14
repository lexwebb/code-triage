# Fix Queue Design

**Date:** 2026-04-14
**Status:** Draft

## Problem

When reviewing a PR with multiple actionable comments, you must wait for one fix to complete (and be applied/discarded) before starting the next. This forces serial interaction — click, wait, review, apply, click again — when you already know which comments you want fixed.

## Solution

A server-side sequential fix queue. Users can click "Fix with Claude" on multiple comments upfront. Fixes execute one at a time globally. Each completed fix pauses for user review before the next starts. Failed or question-blocked fixes are skipped so the queue keeps moving.

## Requirements

- **Sequential execution:** Only one Claude fix process runs at a time across all PRs.
- **Per-PR queues:** Each PR can have its own set of queued fixes. Multiple PRs can have queued items simultaneously.
- **Global ordering:** A single FIFO position counter determines which queued item runs next, regardless of which PR it belongs to.
- **Pause for review:** Completed fixes (with a diff) block the queue until the user applies or discards them.
- **Skip failures and questions:** Jobs that end in `failed`, `awaiting_response`, or `no_changes` do not block the queue. They remain in the fix jobs banner for the user to handle later.
- **Batch selection:** The UI allows clicking "Fix" on multiple comments without waiting for the first to finish.
- **Persistent queue:** Queue state is stored in SQLite so it survives process restarts and browser refreshes.

## Data Model

### New table: `fix_queue`

```sql
fix_queue (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id         INTEGER NOT NULL UNIQUE,
  repo               TEXT NOT NULL,
  pr_number          INTEGER NOT NULL,
  branch             TEXT NOT NULL,
  path               TEXT NOT NULL,
  line               INTEGER NOT NULL,
  body               TEXT NOT NULL,
  diff_hunk          TEXT NOT NULL,
  user_instructions  TEXT,
  queued_at          TEXT NOT NULL,
  position           INTEGER NOT NULL
)
```

- `comment_id UNIQUE` prevents queuing the same comment twice.
- `position` is a monotonically increasing integer for FIFO ordering.
- The full comment payload (`path`, `line`, `body`, `diff_hunk`) is stored so the worker can start the fix without re-fetching.
- Items are deleted from `fix_queue` when they move to the running state (inserted into `fix_jobs`).

### In-memory mirror

An array loaded from SQLite on startup mirrors the queue for fast access. All mutations go through SQLite first, then update the in-memory array.

### New Drizzle schema entry

Add a `fixQueue` table to `src/db/schema.ts` matching the SQL above.

## API Changes

### `POST /api/actions/fix` — modified

Current behavior: returns 409 if any fix is running on the same PR.

New behavior:
1. If the same `commentId` is already queued or running → 409 (true duplicate).
2. If no fix is running globally and no completed fix is awaiting review → start immediately, return `{ success: true, status: "running", branch }`.
3. Otherwise → insert into `fix_queue`, return `{ success: true, status: "queued", position }`.

The branch-level duplicate check (same branch already has an active worktree) remains a 409. The per-PR 409 is replaced by enqueue logic.

### `GET /api/fix-queue` — new

Returns the full queue ordered by position:
```json
[
  {
    "commentId": 123,
    "repo": "owner/repo",
    "prNumber": 42,
    "path": "src/foo.ts",
    "position": 1,
    "queuedAt": "2026-04-14T12:00:00Z"
  }
]
```

### `DELETE /api/fix-queue/:commentId` — new

Removes an item from the queue before it starts. Returns 404 if the item isn't queued.

### `POST /api/actions/fix-apply` and `POST /api/actions/fix-discard` — modified

After their existing logic completes, both call `advanceQueue()` to start the next queued fix.

### SSE

New event type: `fix-queue`. Broadcast whenever the queue changes (item added, removed, or started). Payload is the full current queue array.

## Queue Advancement: `advanceQueue()`

A function (not a background loop) that checks whether to start the next queued fix. No timers or polling.

### Triggers

1. After `fix-apply` completes.
2. After `fix-discard` completes.
3. After a fix finishes with `no_changes`, `failed`, or `awaiting_response` — these are non-blocking terminal states.
4. On process startup — in case items were queued when the process last exited.

### Logic

```
function advanceQueue():
  if any fixJobStatus has status === "running":
    return  // something is already in flight
  if any fixJobStatus has status === "completed":
    return  // waiting for user to review a diff
  item = dequeue next item from fix_queue (lowest position)
  if no item:
    return  // queue is empty
  if item.branch has an active worktree (getActiveFixForBranch):
    skip this item, try next  // branch conflict — leave in queue, advance past it
  remove item from fix_queue table
  start fix using the stored payload (create worktree, persist job, run Claude)
  broadcast fix-queue SSE event
```

Key invariant: `completed` fixes block the queue (user must act). All other non-running terminal states (`failed`, `awaiting_response`, `no_changes`) do not block.

## Frontend Changes

### Store: `fixJobsSlice`

New state:
- `queue: QueuedFixItem[]` — mirrors the server queue.
- `setQueue(items: QueuedFixItem[])` — setter called on `fix-queue` SSE events.
- `cancelQueued(commentId: number)` — calls `DELETE /api/fix-queue/:commentId`.

### `prDetailSlice.startFix()`

Handle the new `status: "queued"` response from the API. Instead of optimistically adding a running job, add the item to the queue state.

### `FixJobsBanner`

Queued items appear in the banner alongside running/completed jobs:
- Visual distinction: "Queued #N" badge, dimmed styling.
- Each queued item has a "Cancel" button.
- Ordering: queued items appear after active/completed jobs, sorted by position.

### "Fix with Claude" button

Three states depending on context:
1. **No active fix** → "Fix with Claude" (starts immediately).
2. **Another fix is active on this or any PR** → "Queue Fix" (enqueues).
3. **This comment is already queued** → "Queued" (disabled).

## Testing

- Unit test for `advanceQueue()` logic: mock fixJobStatuses with various states, verify correct advancement.
- Unit test for queue ordering: enqueue items from multiple PRs, verify FIFO ordering.
- Unit test for skip behavior: set a job to `failed`/`awaiting_response`, call `advanceQueue()`, verify next item starts.
- Unit test for blocking behavior: set a job to `completed`, call `advanceQueue()`, verify nothing starts.
- Integration: queue two fixes, verify the second starts after the first is applied.

## Migration

No data migration needed. The `fix_queue` table is new and starts empty. Existing `fix_jobs` and `fix_job_results` tables are unchanged.
