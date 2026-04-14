# No-Changes Fix Reply Design

**Date:** 2026-04-14
**Status:** Approved

## Problem

When a user runs "Fix with Claude" and Claude determines no code changes are needed (e.g. the suggestion is already handled, or violates a policy), the fix job is marked as `"failed"` with the error `"Claude made no changes"`. This is misleading — Claude successfully analyzed the situation and has a useful explanation, but the user sees it as a failure. The explanation is buried in raw JSON output.

Additionally, the `claudeOutput` field across all fix job states shows the raw JSON from `claude -p --output-format json` (a `{ result: "..." }` wrapper), which is hard to read.

## Solution

### New fix job status: `no_changes`

Add `"no_changes"` to the `FixJobStatus.status` union. When Claude finishes a fix and the diff is empty, set this status instead of `"failed"`. Store Claude's explanation in a new `suggestedReply` field.

### Backend: detect and handle no-changes

In `src/api.ts`, the empty-diff branch (currently sets `status: "failed"`, `error: "Claude made no changes"`) changes to:

- `status: "no_changes"`
- `suggestedReply: result.message` — Claude's parsed explanation (from `parseFixResponse`)
- `claudeOutput: result.message` — clean text, not raw JSON

The worktree is still cleaned up and the fix job removed from persistent state (same as before — no code changes to preserve).

### New endpoint: `POST /api/actions/fix-reply-and-resolve`

Request: `{ repo, commentId, prNumber, body }` — where `body` is the reply text (pre-filled from `suggestedReply`, user can edit).

Behavior: calls `postReply()` to reply to the comment thread, then `resolveThread()` to resolve it. Marks the comment as `"replied"` in state. Clears the fix job from the in-memory status map.

### Frontend: `FixJobsBanner.tsx`

The `no_changes` status gets a distinct display in the fix modal:

- **Info box** (blue/neutral, not red/error) showing Claude's explanation
- **Editable textarea** pre-filled with the suggested reply so the user can adjust before sending
- **"Send Reply & Resolve"** button — calls the new endpoint, closes the modal
- **"Dismiss"** button — closes without action

Status indicator in the job list row uses a blue/info color (like `awaiting_response`) instead of red.

### Claude output cleanup

For all fix job states, the `claudeOutput` field should contain the parsed message text, not the raw JSON wrapper. The `result.message` from `parseFixResponse` is already clean text. Pass this through instead of `result.rawOutput` for the user-visible `claudeOutput` field.

### Type changes

**Backend (`src/server.ts`):**
- Add `"no_changes"` to `FixJobStatus.status` union
- Add `suggestedReply?: string` to `FixJobStatus`

**Frontend (`web/src/api.ts`):**
- Add `"no_changes"` to `FixJobStatus.status` union
- Add `suggestedReply?: string` to `FixJobStatus`

**Frontend (`web/src/api.ts`):**
- Add `fixReplyAndResolve` API method (if not already present as `fixReply`)
