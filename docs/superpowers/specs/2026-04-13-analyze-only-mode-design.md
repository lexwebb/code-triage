# Analyze-Only Mode with WebUI Actions

## Overview

Change cr-watch from auto-acting on comments (replying, resolving, creating worktrees) to an analyze-and-suggest workflow. The CLI evaluates each new comment with Claude and stores the recommendation. The WebUI displays recommendations with action buttons for the user to execute.

## Core Behavior

1. Poll discovers new comments (unchanged)
2. Evaluate each comment with Claude (unchanged `evaluateComment` call)
3. Store evaluation in state — do NOT auto-reply, auto-resolve, or create worktrees
4. WebUI displays evaluations with suggested actions
5. User clicks action buttons to execute (reply, resolve, dismiss)

## State Changes (`src/types.ts`)

```typescript
export interface Evaluation {
  action: "reply" | "fix" | "resolve";
  summary: string;
  reply?: string;
  fixDescription?: string;
}

export interface CommentRecord {
  status: "pending" | "replied" | "fixed" | "dismissed";
  prNumber: number;
  repo: string;
  timestamp: string;
  evaluation?: Evaluation;
}
```

- `"seen"` status is replaced by `"pending"` (evaluated but not acted on)
- `"skipped"` is replaced by `"dismissed"`
- `evaluation` field stores Claude's recommendation
- `repo` field added to each record for multi-repo context

## Actioner Changes (`src/actioner.ts`)

Rename `processComments` to `analyzeComments`. The function:
1. Calls `evaluateComment(comment)` for each new comment (unchanged)
2. Stores the evaluation in state via `markComment` with the new evaluation field
3. Does NOT post replies, resolve threads, or create worktrees
4. Does NOT prompt the user in the terminal
5. Logs the evaluation to the terminal for visibility

Remove all interactive prompts, worktree creation, reply posting, and thread resolution from the analysis flow. These actions move to the API endpoints.

## New Action Endpoints (`src/api.ts`)

The server needs to accept POST requests. Add body parsing for JSON POST bodies.

### POST /api/actions/reply
Request: `{ repo: string, commentId: number, prNumber: number }`
Behavior: Posts the stored `evaluation.reply` as a reply to the comment on GitHub, then resolves the thread. Updates state to `"replied"`.

### POST /api/actions/resolve
Request: `{ repo: string, commentId: number, prNumber: number }`
Behavior: Resolves the thread on GitHub (with optional evaluation.reply if present). Updates state to `"replied"`.

### POST /api/actions/dismiss
Request: `{ repo: string, commentId: number, prNumber: number }`
Behavior: Updates state to `"dismissed"`. No GitHub action.

### POST /api/actions/fix
Deferred for v1. The evaluation shows the fix description; user acts manually. Button is shown but disabled with "Coming soon" tooltip.

## API Changes

### GET /api/pulls/:number/comments
No change to the endpoint itself. The evaluation data is served separately via state.

### GET /api/state
Already returns the full state including evaluations. The WebUI merges comment data with state data to show evaluations.

## Server Changes (`src/server.ts`)

Add POST body parsing to the request handler. When `req.method === "POST"`, read the request body as JSON and pass it to the route handler.

Update `RouteHandler` type to include a `body` parameter for POST routes.

## WebUI Changes

### Layout: Threads-First Design

The review threads panel becomes the primary content area — no `max-h-80` cap. The file list and diff view are collapsed by default behind an expandable "Files Changed" section.

```
┌──────────────────────────────────────────────────┐
│ PR Detail Header                                 │
├──────────────────────────────────────────────────┤
│ Review Threads (expanded, scrollable, main area) │
│ ┌─ src/auth.ts:15 ──────── [Suggest Reply] ────┐│
│ │ 🤖 coderabbitai: Consider retry limit...      ││
│ │                                                ││
│ │ 💡 Suggested reply:                            ││
│ │ "Good point, adding a MAX_RETRIES constant..." ││
│ │                                                ││
│ │ [Send Reply]  [Resolve]  [Dismiss]             ││
│ └────────────────────────────────────────────────┘│
│ ┌─ src/middleware.ts:42 ──── [Needs Fix] ───────┐│
│ │ 🤖 coderabbitai: Missing null check...         ││
│ │                                                ││
│ │ 🔧 Suggested fix:                              ││
│ │ "Add null check before accessing user.role..." ││
│ │                                                ││
│ │ [Fix (coming soon)]  [Resolve]  [Dismiss]      ││
│ └────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────┤
│ ▶ Files Changed (3) [collapsed by default]       │
└──────────────────────────────────────────────────┘
```

### CommentThreads Component

For each thread with a pending evaluation:
- Show a colored badge: green "Can Resolve", blue "Suggest Reply", orange "Needs Fix"
- Below the comment body, show the evaluation in an expandable section:
  - For "reply"/"resolve": show the suggested reply text
  - For "fix": show the fix description
- Action buttons at the bottom of each thread:
  - "Send Reply" — calls POST /api/actions/reply
  - "Resolve" — calls POST /api/actions/resolve
  - "Dismiss" — calls POST /api/actions/dismiss
- After an action succeeds, update local state to reflect the new status

### Thread Status Display
- `pending` with evaluation — show action buttons
- `replied` — show "Replied ✓" badge, collapse thread
- `dismissed` — show "Dismissed" badge, collapse thread
- No evaluation yet — show "Analyzing..." spinner (comment was just discovered)

### FileList + DiffView
- Wrapped in a collapsible section, collapsed by default
- Toggle button: "▶ Files Changed (N)" / "▼ Files Changed (N)"

## WebUI API Client Changes (`web/src/api.ts`)

Add action methods:
- `api.replyToComment(repo, commentId, prNumber)` — POST /api/actions/reply
- `api.resolveComment(repo, commentId, prNumber)` — POST /api/actions/resolve
- `api.dismissComment(repo, commentId, prNumber)` — POST /api/actions/dismiss

## WebUI Types Changes (`web/src/types.ts`)

Add to `ReviewComment` or as a separate merged type:
- `evaluation?: { action, summary, reply?, fixDescription? }`
- `status?: "pending" | "replied" | "fixed" | "dismissed"`

## CLI Changes (`src/cli.ts`)

- Call `analyzeComments` instead of `processComments`
- Remove worktree-related prompts from the poll loop
- Terminal still shows: "[time] Analyzed N comment(s) across M repo(s)"

## What Stays the Same

- Discovery, polling, multi-repo — unchanged
- `evaluateComment` function — unchanged
- Terminal hotkeys — unchanged
- `--dry-run` — skips evaluation (doesn't call Claude)
- URL routing — unchanged
- Markdown rendering — unchanged

## Non-Goals

- No automated fix application in v1 (button shown as disabled)
- No batch actions (reply all, dismiss all)
- No re-evaluation of comments
- No editing suggested replies before sending
