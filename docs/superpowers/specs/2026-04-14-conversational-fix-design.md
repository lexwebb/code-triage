# Conversational Fix with Claude

**Date:** 2026-04-14
**Status:** Approved

## Problem

When Claude receives a fix request, it either makes changes or fails silently. If the review comment is ambiguous, the intended behavior is unclear, or there are multiple valid approaches, Claude guesses — often producing a fix the user didn't want or making no changes at all. There is no way for Claude to ask clarifying questions before committing to an implementation.

## Solution

Allow Claude to respond with questions instead of immediately fixing. Surface those questions inline in the CommentThreads UI so the user can answer. Resume the Claude session with the user's answers, repeating until Claude is satisfied and applies the fix. Use Claude CLI's `--session-id` / `--resume` flags for real multi-turn conversation with full context retention.

## Structured Output Format

The fix prompt changes to instruct Claude to respond with JSON:

```json
{ "action": "fix", "message": "Brief summary of what was changed" }
```

or

```json
{ "action": "questions", "message": "I have a few questions before proceeding:\n1. ..." }
```

Enforced via `--json-schema` on the Claude CLI invocation. The prompt tells Claude it may ask clarifying questions when the review comment is ambiguous, the intended behavior is unclear, or there are multiple valid approaches. Otherwise it should proceed with the fix.

The `--output-format json` flag is used alongside `--json-schema` to get structured CLI output. The CLI returns a JSON wrapper with a `result` field containing the model's text. When `--json-schema` is used, the `result` string is itself valid JSON conforming to the schema. Parsing is two-step: first parse the CLI wrapper (`JSON.parse(stdout)`), then parse the inner `result` field (`JSON.parse(wrapper.result)`) to get the `{ action, message }` object.

## New Fix Job Status: `awaiting_response`

`FixJobStatus.status` gains a fourth value: `"awaiting_response"`.

When Claude responds with `action: "questions"`:
- Status is set to `"awaiting_response"`
- The worktree is kept alive (same as `"completed"`)
- The session ID is stored on the job for resumption
- Claude's questions are stored in the conversation history

### New fields on `FixJobStatus`

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string?` | Claude CLI session UUID, set on first invocation, used for `--resume` |
| `conversation` | `Array<{ role: "claude" \| "user"; message: string }>?` | Full Q&A history, appended with each turn |

### Status transitions

```
User clicks "Fix"
  → status: "running" (initial Claude invocation with --session-id)
  → Claude responds with action: "fix"
    → check diff → status: "completed" or "failed"
  → Claude responds with action: "questions"
    → status: "awaiting_response"
    → User replies in UI
      → status: "running" (Claude resumed with --resume)
      → (loop back to Claude response handling)
```

## Session Management

### Initial invocation

```bash
claude -p "<fix prompt>" \
  --dangerously-skip-permissions \
  --session-id <uuid> \
  --output-format json \
  --json-schema '{"type":"object","properties":{"action":{"type":"string","enum":["fix","questions"]},"message":{"type":"string"}},"required":["action","message"]}'
```

Working directory: the worktree root.

### Follow-up invocation (after user answers)

```bash
claude -p "<user reply text>" \
  --dangerously-skip-permissions \
  --resume <session-id> \
  --output-format json \
  --json-schema '{"type":"object","properties":{"action":{"type":"string","enum":["fix","questions"]},"message":{"type":"string"}},"required":["action","message"]}'
```

Claude retains full file/tool context from prior turns via the resumed session.

### Prompt changes

The initial fix prompt (in `applyFixWithClaude`) is updated to:

```
Apply this CodeRabbit review suggestion. Make the minimal changes needed.

- File: {path}, line {line}
  Comment: {body (first 10 lines)}

Diff context:
{diffHunk}
{optional user instructions}

If the comment is ambiguous, the intended behavior is unclear, or there are multiple
valid approaches, respond with action "questions" and ask what you need to know.
Otherwise, make the changes directly and respond with action "fix".

Respond as JSON: { "action": "fix" | "questions", "message": "..." }
```

## New API Endpoint: `POST /api/actions/fix-reply`

```
POST /api/actions/fix-reply
Content-Type: application/json

{
  "repo": "owner/repo",
  "commentId": 12345,
  "message": "Use approach A because..."
}
```

### Behavior

1. Look up the fix job by `commentId` — must be in `"awaiting_response"` status. Return 400 if not found or wrong status.
2. Append `{ role: "user", message }` to the conversation history.
3. Set status to `"running"`, broadcast via SSE.
4. Respond immediately with `{ success: true, status: "running" }`.
5. In background: invoke `claude -p "<message>" --resume <sessionId> --dangerously-skip-permissions --output-format json --json-schema <schema>` in the worktree directory.
6. Parse response:
   - `action: "questions"` → append to conversation, set status to `"awaiting_response"`, broadcast.
   - `action: "fix"` → append to conversation, check `getDiffInWorktree()`:
     - Diff present → status `"completed"` with diff and full conversation.
     - No diff → status `"failed"` with error "Claude made no changes".
7. On error → status `"failed"`, clean up worktree.

### Concurrency

No new locking needed. The job is already tracked. The `getActiveFixForBranch` / `getActiveFixForPR` checks only match `status === "running"`, so an `"awaiting_response"` job does **not** block new fixes on the same PR. This lets users start other fixes while Claude waits for answers on a different thread.

## Turn Limit

### Config

New field in `Config`:

```typescript
/** Max Q&A turns before Claude must attempt the fix (0 = unlimited). Default 5. */
fixConversationMaxTurns?: number;
```

Default: `5`. Exposed in the web settings UI.

### Enforcement

The turn count is the number of Claude responses in the conversation (not user messages). When the count reaches `maxTurns - 1` (i.e. the next response will be the last allowed), the user's reply prompt is wrapped with:

```
{user message}

IMPORTANT: This is the final turn. You must now attempt the fix with what you know.
Do not ask more questions. Respond with action "fix".
```

If Claude still responds with `action: "questions"` on the final turn, treat it as a fix attempt and check for diff (fall through to the normal diff check).

## UI: Inline Conversation in CommentThreads

### Thread-level display

When a fix job for a thread is in `"awaiting_response"`:

1. **Header badge**: A purple/indigo `StatusBadge` reading "Claude Asking" replaces the normal eval badge area.
2. **Conversation section**: Below the existing comment/replies (and below the triage section), a conversation panel appears:
   - Each turn rendered as a simple bubble: Claude messages left-aligned with a bot icon, user messages right-aligned.
   - Messages rendered as plain text (no markdown) to keep it simple.
3. **Reply input**: At the bottom of the conversation section, a text input + "Send Reply" button. `Ctrl+Enter` submits. The input is auto-focused when the conversation section appears.
4. **Turn counter**: Small gray text showing "Turn 2 of 5" next to the reply input.

### Submitting a reply

- Calls `POST /api/actions/fix-reply`
- Optimistically appends the user message to the local conversation and sets status to `"running"`
- Disables the input while Claude is processing

### Thread interaction with fix states

| Fix status | Thread behavior |
|---|---|
| `running` | "Fix with Claude" button shows "Fix running...", disabled |
| `awaiting_response` | Conversation panel visible with reply input; "Fix with Claude" button hidden |
| `completed` | Normal completed behavior (diff in banner modal) |
| `failed` | Normal failed behavior (error display) |

## FixJobsBanner Updates

### Summary counts

The banner summary expands to include awaiting jobs:

```
{running} running, {awaiting} awaiting reply, {completed} ready, {failed} failed
```

### Job row

- `"awaiting_response"` jobs show a purple question-mark icon
- Elapsed time shows time since Claude's last question (not job start)
- Click opens the modal which shows conversation history

### Job modal

The existing job modal gains a "Conversation" section (between the info grid and the diff/error section):

- Shows full conversation history as alternating Claude/user entries
- Collapsible, expanded by default when status is `"awaiting_response"`
- When `"awaiting_response"`, the modal also has the reply input (same as the inline version in CommentThreads) so users can reply from either location

## Frontend API Addition

New method in `web/src/api.ts`:

```typescript
async fixReply(repo: string, commentId: number, message: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${BASE}/api/actions/fix-reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, commentId, message }),
  });
  return res.json();
}
```

## Backend Type Changes

### `src/server.ts` — `FixJobStatus`

```typescript
export interface FixJobStatus {
  commentId: number;
  repo: string;
  prNumber: number;
  path: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "awaiting_response";
  error?: string;
  diff?: string;
  branch?: string;
  claudeOutput?: string;
  sessionId?: string;
  conversation?: Array<{ role: "claude" | "user"; message: string }>;
}
```

### `src/server.ts` — Lock changes

`getActiveFixForBranch` and `getActiveFixForPR` already only match `status === "running"`, so `"awaiting_response"` jobs are naturally excluded from the lock. No changes needed.

### `src/actioner.ts` — `applyFixWithClaude`

The function signature changes to accept an optional `sessionId` and optional `resumeSessionId`:

```typescript
export async function applyFixWithClaude(
  worktreePath: string,
  comment: { path: string; line: number; body: string; diffHunk: string },
  userInstructions?: string,
  options?: { sessionId?: string; resumeSessionId?: string; isLastTurn?: boolean },
): Promise<{ action: "fix" | "questions"; message: string; rawOutput: string }>;
```

- When `sessionId` is provided (initial call): uses `--session-id <sessionId>`
- When `resumeSessionId` is provided (follow-up): uses `--resume <resumeSessionId>`, and the prompt is just the user's message
- When `isLastTurn` is true: appends the "must fix now" instruction
- Returns parsed JSON response plus raw CLI output

### `src/types.ts` — `FixJobRecord`

Add `sessionId` to the persisted record so sessions survive server restarts:

```typescript
export interface FixJobRecord {
  commentId: number;
  repo: string;
  prNumber: number;
  branch: string;
  path: string;
  worktreePath: string;
  startedAt: string;
  sessionId?: string;
  conversation?: Array<{ role: "claude" | "user"; message: string }>;
}
```

## Error Handling

- **JSON parse failure**: If Claude's response doesn't parse as valid JSON matching the schema, treat it as `action: "fix"` (Claude may have just made changes without following the format). Check for diff as normal.
- **Session not found**: If `--resume` fails because the session expired or was cleaned up, fall back to a fresh invocation with the full conversation history baked into the prompt (replay approach). Set a new `sessionId`.
- **Turn limit exceeded**: If Claude responds with `questions` on the final turn, check for diff anyway. If no diff, set status to `"failed"` with error "Claude could not complete the fix within the turn limit."

## Files Changed

| File | Changes |
|------|---------|
| `src/actioner.ts` | Update `applyFixWithClaude` signature, add JSON schema, session ID args, parse structured response |
| `src/api.ts` | Update `POST /api/actions/fix` to use new `applyFixWithClaude`, add `POST /api/actions/fix-reply` |
| `src/server.ts` | Add `sessionId`, `conversation` to `FixJobStatus`, add `"awaiting_response"` to status union |
| `src/types.ts` | Add `sessionId`, `conversation` to `FixJobRecord` |
| `src/config.ts` | Add `fixConversationMaxTurns` to `Config` |
| `web/src/api.ts` | Add `fixReply` method, update `FixJobStatus` type |
| `web/src/components/CommentThreads.tsx` | Add inline conversation panel, reply input, "Claude Asking" badge |
| `web/src/components/FixJobsBanner.tsx` | Add `"awaiting_response"` count, icon, conversation in modal |
| `web/src/components/SettingsView.tsx` | Add `fixConversationMaxTurns` setting |
