# Conversational Fix with Claude — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Claude to ask clarifying questions during a fix instead of guessing, with a multi-turn conversation in the web UI.

**Architecture:** Claude CLI invoked with `--session-id` and `--json-schema` to get structured `{ action, message }` responses. A new `"awaiting_response"` fix job status holds the session open while the user replies. Follow-up turns use `--resume` for real multi-turn with full context. Conversation displayed inline in CommentThreads and in the FixJobsBanner modal.

**Tech Stack:** Claude CLI (`--session-id`, `--resume`, `--json-schema`, `--output-format json`), TypeScript, React 19, Tailwind CSS v4, Vitest.

---

### Task 1: Add `fixConversationMaxTurns` to Config

**Files:**
- Modify: `src/config.ts:8-47` (Config interface + DEFAULTS)
- Modify: `src/api.ts:154-178` (serializeConfigForClient)
- Modify: `src/api.ts:180` (mergeConfigFromBody)
- Modify: `web/src/api.ts:48-73` (AppConfigPayload)

- [ ] **Step 1: Add field to Config interface**

In `src/config.ts`, add to the `Config` interface:

```typescript
/** Max Q&A turns before Claude must attempt the fix (0 = unlimited). Default 5. */
fixConversationMaxTurns?: number;
```

And add to `DEFAULTS`:

```typescript
fixConversationMaxTurns: 5,
```

- [ ] **Step 2: Expose in serializeConfigForClient**

In `src/api.ts`, add to the `serializeConfigForClient` return object:

```typescript
fixConversationMaxTurns: c.fixConversationMaxTurns ?? 5,
```

- [ ] **Step 3: Accept in mergeConfigFromBody**

In `src/api.ts` `mergeConfigFromBody`, add parsing for the new field. Find where other numeric config fields are merged (near the `evalConcurrency` handling) and add:

```typescript
const fixConversationMaxTurns = toInt(body.fixConversationMaxTurns, previous.fixConversationMaxTurns ?? 5);
```

Include `fixConversationMaxTurns` in the returned config object.

- [ ] **Step 4: Add to frontend AppConfigPayload**

In `web/src/api.ts`, add to the `AppConfigPayload` interface:

```typescript
/** Max Q&A turns for conversational fixes (0 = unlimited). Default 5. */
fixConversationMaxTurns: number;
```

- [ ] **Step 5: Build and verify**

Run: `yarn build:all`
Expected: Clean compile, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/api.ts web/src/api.ts
git commit -m "feat: add fixConversationMaxTurns config field"
```

---

### Task 2: Add `awaiting_response` status and new fields to FixJobStatus

**Files:**
- Modify: `src/server.ts:194-205` (FixJobStatus interface)
- Modify: `src/server.ts:277-289` (getActiveFixForBranch, getActiveFixForPR)
- Modify: `src/types.ts:26-34` (FixJobRecord)
- Modify: `src/db/schema.ts:24-32` (fix_jobs table — add sessionId, conversationJson columns)
- Modify: `src/db/client.ts` (writeStateToDb insert statement, loadState read)
- Modify: `web/src/api.ts:34-46` (frontend FixJobStatus)

- [ ] **Step 1: Update server-side FixJobStatus**

In `src/server.ts`, update the `FixJobStatus` interface:

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

- [ ] **Step 2: Verify lock functions exclude awaiting_response**

Confirm `getActiveFixForBranch` and `getActiveFixForPR` in `src/server.ts` only match `status === "running"`. They already do — no changes needed, but verify by reading lines 277-289.

- [ ] **Step 3: Update FixJobRecord in types.ts**

In `src/types.ts`, update `FixJobRecord`:

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

- [ ] **Step 4: Add columns to SQLite fix_jobs table**

In `src/db/schema.ts`, add two columns to the `fixJobs` table:

```typescript
export const fixJobs = sqliteTable("fix_jobs", {
  commentId: integer("comment_id").primaryKey(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number").notNull(),
  branch: text("branch").notNull(),
  path: text("path").notNull(),
  worktreePath: text("worktree_path").notNull(),
  startedAt: text("started_at").notNull(),
  sessionId: text("session_id"),
  conversationJson: text("conversation_json"),
});
```

- [ ] **Step 5: Update writeStateToDb and loadState in db/client.ts**

In `src/db/client.ts`, update the `insertJob` prepared statement to include the new columns:

```sql
INSERT INTO fix_jobs (comment_id, repo, pr_number, branch, path, worktree_path, started_at, session_id, conversation_json)
VALUES (@comment_id, @repo, @pr_number, @branch, @path, @worktree_path, @started_at, @session_id, @conversation_json)
```

And update the `insertJob.run(...)` call to include:

```typescript
session_id: j.sessionId ?? null,
conversation_json: j.conversation ? JSON.stringify(j.conversation) : null,
```

In the `loadState` function where fix jobs are read from the DB, update the mapping to include the new fields:

```typescript
sessionId: row.session_id ?? undefined,
conversation: row.conversation_json ? JSON.parse(row.conversation_json) : undefined,
```

Also add the `ALTER TABLE` migration for existing databases. In the `ensureSchema` function (or wherever schema migrations run), add:

```sql
ALTER TABLE fix_jobs ADD COLUMN session_id TEXT;
ALTER TABLE fix_jobs ADD COLUMN conversation_json TEXT;
```

Wrap each in a try/catch so it's safe to run if the columns already exist (SQLite doesn't support `IF NOT EXISTS` for `ALTER TABLE ADD COLUMN`).

- [ ] **Step 6: Update frontend FixJobStatus**

In `web/src/api.ts`, update the `FixJobStatus` interface:

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
  originalComment?: { path: string; line: number; body: string; diffHunk: string };
  sessionId?: string;
  conversation?: Array<{ role: "claude" | "user"; message: string }>;
}
```

- [ ] **Step 7: Build and verify**

Run: `yarn build:all`
Expected: Clean compile. Some components may now have incomplete switch/if coverage for the new status — that's fine, we'll fix those in later tasks.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/types.ts src/db/schema.ts src/db/client.ts web/src/api.ts
git commit -m "feat: add awaiting_response status and conversation fields to FixJobStatus"
```

---

### Task 3: Update `applyFixWithClaude` for structured output and session management

**Files:**
- Modify: `src/actioner.ts:294-320` (applyFixWithClaude function)
- Test: `src/actioner.test.ts`

- [ ] **Step 1: Write tests for the new parseFixResponse helper**

The `applyFixWithClaude` function uses `spawnTracked` which is hard to unit test (spawns real processes). Instead, extract a `parseFixResponse(rawOutput: string)` function that parses the Claude CLI JSON output and test that.

In `src/actioner.test.ts`, add:

```typescript
import { parseFixResponse } from "./actioner.js";

describe("parseFixResponse", () => {
  it("parses a fix action from CLI JSON output", () => {
    const cliOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify({ action: "fix", message: "Applied the guard clause" }),
    });
    const parsed = parseFixResponse(cliOutput);
    expect(parsed).toEqual({ action: "fix", message: "Applied the guard clause" });
  });

  it("parses a questions action from CLI JSON output", () => {
    const cliOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify({ action: "questions", message: "Should I use Option A or B?" }),
    });
    const parsed = parseFixResponse(cliOutput);
    expect(parsed).toEqual({ action: "questions", message: "Should I use Option A or B?" });
  });

  it("falls back to fix action when result is not valid JSON", () => {
    const cliOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "I made the changes as requested.",
    });
    const parsed = parseFixResponse(cliOutput);
    expect(parsed).toEqual({ action: "fix", message: "I made the changes as requested." });
  });

  it("falls back to fix action when CLI output is not JSON at all", () => {
    const parsed = parseFixResponse("Some plain text output from claude");
    expect(parsed).toEqual({ action: "fix", message: "Some plain text output from claude" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/actioner.test.ts`
Expected: FAIL — `parseFixResponse` is not exported / doesn't exist yet.

- [ ] **Step 3: Implement parseFixResponse**

In `src/actioner.ts`, add and export:

```typescript
export function parseFixResponse(rawOutput: string): { action: "fix" | "questions"; message: string } {
  try {
    const wrapper = JSON.parse(rawOutput) as { result?: string };
    const resultStr = wrapper.result ?? rawOutput;
    try {
      const inner = JSON.parse(resultStr) as { action?: string; message?: string };
      if (inner.action === "questions" && typeof inner.message === "string") {
        return { action: "questions", message: inner.message };
      }
      return { action: "fix", message: inner.message ?? resultStr };
    } catch {
      return { action: "fix", message: resultStr };
    }
  } catch {
    return { action: "fix", message: rawOutput };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/actioner.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Update applyFixWithClaude signature and implementation**

Replace the existing `applyFixWithClaude` function in `src/actioner.ts`:

```typescript
const FIX_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    action: { type: "string", enum: ["fix", "questions"] },
    message: { type: "string" },
  },
  required: ["action", "message"],
});

export async function applyFixWithClaude(
  worktreePath: string,
  comment: { path: string; line: number; body: string; diffHunk: string },
  userInstructions?: string,
  options?: { sessionId?: string; resumeSessionId?: string; isLastTurn?: boolean },
): Promise<{ action: "fix" | "questions"; message: string; rawOutput: string }> {
  let prompt: string;
  const args: string[] = [];

  if (options?.resumeSessionId) {
    // Follow-up turn: prompt is the user's message (passed as userInstructions)
    prompt = userInstructions ?? "";
    if (options.isLastTurn) {
      prompt += "\n\nIMPORTANT: This is the final turn. You must now attempt the fix with what you know. Do not ask more questions. Respond with action \"fix\".";
    }
    args.push("-p", prompt, "--dangerously-skip-permissions", "--resume", options.resumeSessionId, "--output-format", "json", "--json-schema", FIX_JSON_SCHEMA);
  } else {
    // Initial turn
    const userBlock = userInstructions?.trim()
      ? `\n\nAdditional instructions from the developer:\n${userInstructions.trim()}`
      : "";
    prompt = `Apply this CodeRabbit review suggestion. Make the minimal changes needed.

- File: ${comment.path}, line ${comment.line}
  Comment: ${comment.body.split("\n").slice(0, 10).join("\n  ")}

Diff context:
${comment.diffHunk}${userBlock}

If the comment is ambiguous, the intended behavior is unclear, or there are multiple valid approaches, respond with action "questions" and ask what you need to know. Otherwise, make the changes directly and respond with action "fix".

Respond as JSON: { "action": "fix" | "questions", "message": "..." }`;
    args.push("-p", prompt, "--dangerously-skip-permissions", "--output-format", "json", "--json-schema", FIX_JSON_SCHEMA);
    if (options?.sessionId) {
      args.push("--session-id", options.sessionId);
    }
  }

  updateClaudeStats({ fixStarted: true });
  let rawOutput: string;
  try {
    rawOutput = await spawnTracked("claude", args, {
      cwd: worktreePath,
      stdio: ["pipe", "pipe", "pipe"],
      stderrToConsole: true,
    });
  } finally {
    updateClaudeStats({ fixFinished: true });
  }

  const parsed = parseFixResponse(rawOutput);
  return { ...parsed, rawOutput };
}
```

- [ ] **Step 6: Build and verify**

Run: `yarn build:all`
Expected: Clean compile. The callers in `api.ts` will now have type errors because the return type changed — we'll fix those in the next task.

- [ ] **Step 7: Commit**

```bash
git add src/actioner.ts src/actioner.test.ts
git commit -m "feat: update applyFixWithClaude for structured output and session management"
```

---

### Task 4: Update `POST /api/actions/fix` to handle structured responses

**Files:**
- Modify: `src/api.ts:951-1051` (POST /api/actions/fix route)

- [ ] **Step 1: Update the fix route handler**

In `src/api.ts`, replace the background execution block (after `json(res, { success: true, ... })` at line ~1010) with the new logic. The key change is: generate a `sessionId`, pass it to `applyFixWithClaude`, and handle the `action: "questions"` response.

Find the line:
```typescript
json(res, { success: true, status: "running", branch: body.branch });
```

Keep everything above it unchanged. Replace everything after it (the `try/catch` block that calls `applyFixWithClaude`) with:

```typescript
    // Run Claude in background
    const sessionId = crypto.randomUUID();
    try {
      const result = await applyFixWithClaude(worktreePath, body.comment, body.userInstructions, { sessionId });

      if (result.action === "questions") {
        // Claude is asking questions — park the job
        const conversation: Array<{ role: "claude" | "user"; message: string }> = [
          { role: "claude", message: result.message },
        ];
        // Keep worktree alive, persist session info
        const s = loadState();
        const existingJob = getFixJobs(s).find((j) => j.commentId === body.commentId);
        if (existingJob) {
          existingJob.sessionId = sessionId;
          existingJob.conversation = conversation;
          saveState(s);
        }
        setFixJobStatus({
          commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
          path: body.comment.path, startedAt: Date.now(), status: "awaiting_response",
          branch: body.branch, claudeOutput: result.rawOutput,
          sessionId, conversation,
        });
        return;
      }

      // action === "fix" — check for diff as before
      const diff = getDiffInWorktree(worktreePath);

      if (!diff.trim()) {
        removeWorktree(body.branch, repoInfo?.localPath);
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
          path: body.comment.path, startedAt: Date.now(), status: "failed",
          error: "Claude made no changes",
          claudeOutput: result.rawOutput,
        });
        return;
      }

      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        path: body.comment.path, startedAt: Date.now(), status: "completed",
        diff, branch: body.branch, claudeOutput: result.rawOutput,
        conversation: [{ role: "claude", message: result.message }],
      });
    } catch (err) {
      removeWorktree(body.branch, repoInfo?.localPath);
      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        path: body.comment.path, startedAt: Date.now(), status: "failed",
        error: (err as Error).message,
      });
    }
```

Add `import { randomUUID } from "crypto";` at the top of the file (or use `crypto.randomUUID()` which is available in Node 19+). Check if `crypto` is already imported; if not, add it.

- [ ] **Step 2: Build and verify**

Run: `yarn build:all`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat: handle structured Claude responses in fix route"
```

---

### Task 5: Add `POST /api/actions/fix-reply` endpoint

**Files:**
- Modify: `src/api.ts` (add new route after the fix-discard route)

- [ ] **Step 1: Add the fix-reply route**

In `src/api.ts`, after the `POST /api/actions/fix-discard` route handler, add:

```typescript
  // POST /api/actions/fix-reply — respond to Claude's questions and resume the fix session
  addRoute("POST", "/api/actions/fix-reply", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; message: string }>(req);

    // Find the job — must be awaiting_response
    const job = fixJobStatuses.get(body.commentId);
    if (!job || job.status !== "awaiting_response") {
      json(res, { error: "No fix job awaiting response for this comment" }, 400);
      return;
    }
    if (!job.sessionId || !job.branch) {
      json(res, { error: "Fix job missing session or branch info" }, 400);
      return;
    }

    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) {
      json(res, { error: "Repo local path not found" }, 400);
      return;
    }

    // Append user message to conversation
    const conversation = [...(job.conversation ?? []), { role: "user" as const, message: body.message }];

    // Check turn limit
    const config = loadConfig();
    const maxTurns = config.fixConversationMaxTurns ?? 5;
    const claudeTurnCount = conversation.filter((m) => m.role === "claude").length;
    const isLastTurn = maxTurns > 0 && claudeTurnCount >= maxTurns - 1;

    // Set status to running
    setFixJobStatus({ ...job, status: "running", conversation });

    // Respond immediately
    json(res, { success: true, status: "running" });

    // Resume Claude session in background
    const worktreePath = getWorktreePath(job.branch, repoInfo.localPath);
    try {
      const result = await applyFixWithClaude(
        worktreePath,
        { path: job.path, line: 0, body: "", diffHunk: "" }, // not used for resume
        body.message, // passed as userInstructions, used as the prompt for resume
        { resumeSessionId: job.sessionId, isLastTurn },
      );

      const updatedConversation = [...conversation, { role: "claude" as const, message: result.message }];

      if (result.action === "questions" && !isLastTurn) {
        // More questions — update job
        const s = loadState();
        const persistedJob = getFixJobs(s).find((j) => j.commentId === body.commentId);
        if (persistedJob) {
          persistedJob.conversation = updatedConversation;
          saveState(s);
        }
        setFixJobStatus({
          ...job, status: "awaiting_response",
          conversation: updatedConversation,
          claudeOutput: result.rawOutput,
        });
        return;
      }

      // Claude answered "fix" or hit turn limit — check for diff
      const diff = getDiffInWorktree(worktreePath);

      if (!diff.trim()) {
        removeWorktree(job.branch, repoInfo.localPath);
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          ...job, status: "failed",
          error: isLastTurn && result.action === "questions"
            ? "Claude could not complete the fix within the turn limit"
            : "Claude made no changes",
          conversation: updatedConversation,
          claudeOutput: result.rawOutput,
        });
        return;
      }

      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        ...job, status: "completed",
        diff, conversation: updatedConversation,
        claudeOutput: result.rawOutput,
      });
    } catch (err) {
      removeWorktree(job.branch, repoInfo.localPath);
      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        ...job, status: "failed",
        error: (err as Error).message,
        conversation,
      });
    }
  });
```

Note: `fixJobStatuses` is a private Map in `server.ts`. You'll need to either:
- Export a `getFixJobStatus(commentId: number)` getter from `server.ts`, or
- Access it via the existing import pattern.

Check how `api.ts` currently accesses fix job state. If it uses `getActiveFixForBranch`/`getActiveFixForPR` from `server.ts`, add a new export:

In `src/server.ts`:
```typescript
export function getFixJobStatus(commentId: number): FixJobStatus | undefined {
  return fixJobStatuses.get(commentId);
}
```

Then use `getFixJobStatus(body.commentId)` instead of `fixJobStatuses.get(body.commentId)` in the route handler.

- [ ] **Step 2: Build and verify**

Run: `yarn build:all`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/api.ts src/server.ts
git commit -m "feat: add POST /api/actions/fix-reply endpoint for conversational fixes"
```

---

### Task 6: Add `fixReply` to frontend API client

**Files:**
- Modify: `web/src/api.ts:123-168` (api object)

- [ ] **Step 1: Add the fixReply method**

In `web/src/api.ts`, add to the `api` object (after `fixDiscard`):

```typescript
fixReply: (repo: string, commentId: number, message: string) =>
  postJSON<{ success: boolean; error?: string }>("/api/actions/fix-reply", { repo, commentId, message }),
```

- [ ] **Step 2: Build and verify**

Run: `yarn build:all`
Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat: add fixReply to frontend API client"
```

---

### Task 7: Add conversation UI to CommentThreads

**Files:**
- Modify: `web/src/components/CommentThreads.tsx`

- [ ] **Step 1: Create the FixConversation inline component**

Add a new component inside `CommentThreads.tsx` (above `ThreadItem`). This renders the conversation bubbles and reply input when a fix job is in `"awaiting_response"`:

```tsx
function FixConversation({ job, repo, onJobAction }: {
  job: FixJobStatus;
  repo: string;
  onJobAction: () => void;
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      await api.fixReply(repo, job.commentId, reply.trim());
      setReply("");
      onJobAction();
    } catch (err) {
      console.error("Fix reply failed:", err);
    } finally {
      setSending(false);
    }
  }

  const conversation = job.conversation ?? [];
  const claudeTurns = conversation.filter((m) => m.role === "claude").length;
  // maxTurns is not available client-side easily, so just show turn count
  const isRunning = job.status === "running";

  return (
    <div className="mx-1 mt-2 p-2 bg-indigo-950/20 rounded border border-indigo-500/30 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-indigo-400">Fix conversation</div>
      <div className="space-y-1.5 max-h-60 overflow-y-auto">
        {conversation.map((msg, i) => (
          <div key={i} className={`text-xs p-2 rounded ${
            msg.role === "claude"
              ? "bg-gray-800/60 text-gray-300 mr-8"
              : "bg-indigo-900/30 text-indigo-200 ml-8"
          }`}>
            <span className="text-[10px] text-gray-500 block mb-0.5">
              {msg.role === "claude" ? "Claude" : "You"}
            </span>
            {msg.message}
          </div>
        ))}
        {isRunning && (
          <div className="text-xs text-gray-500 italic px-2">Claude is thinking...</div>
        )}
      </div>
      {job.status === "awaiting_response" && (
        <div className="flex gap-2 items-end">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void handleSend();
              }
            }}
            placeholder="Reply to Claude..."
            disabled={sending}
            rows={2}
            autoFocus
            className="flex-1 text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
          />
          <div className="flex flex-col items-end gap-1">
            <Button variant="blue" size="xs" onClick={() => void handleSend()} disabled={sending || !reply.trim()}>
              {sending ? "Sending..." : "Send"}
            </Button>
            <span className="text-[10px] text-gray-600">Turn {claudeTurns}</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add "Claude Asking" badge**

In the `ThreadItem` component, find the header badge area where `EvalBadge` is rendered (around line 336):

```tsx
{isActedOn && <ThreadStatusBadge status={status!} />}
{!isActedOn && eval_ && <EvalBadge action={eval_.action} />}
```

Add a check for the fix job state before these badges. First, find the fix job for this thread. Add at the top of `ThreadItem` (after the existing state declarations):

```tsx
const fixJob = fixJobs?.find((j) => j.commentId === thread.root.id);
const isAwaitingResponse = fixJob?.status === "awaiting_response";
const isFixRunning = fixJob?.status === "running";
```

Note: `ThreadItem` doesn't currently receive `fixJobs`. You need to add it to the props:

```typescript
// Add to ThreadItem props interface:
fixJobs?: FixJobStatus[];
```

And pass it from the parent in the `ThreadItem` usage (around line 811):

```tsx
<ThreadItem
  // ...existing props...
  fixJobs={fixJobs}
/>
```

Then update the badge area:

```tsx
{isAwaitingResponse && <StatusBadge color="purple">Claude Asking</StatusBadge>}
{isFixRunning && <StatusBadge color="yellow">Fix Running</StatusBadge>}
{!isAwaitingResponse && !isFixRunning && isActedOn && <ThreadStatusBadge status={status!} />}
{!isAwaitingResponse && !isFixRunning && !isActedOn && eval_ && <EvalBadge action={eval_.action} />}
```

- [ ] **Step 3: Render FixConversation in the thread body**

In the `ThreadItem` expanded section, after the fix error display and before the action buttons, add:

```tsx
{/* Fix conversation (awaiting_response or running with conversation) */}
{fixJob && (fixJob.status === "awaiting_response" || (fixJob.status === "running" && fixJob.conversation?.length)) && (
  <FixConversation job={fixJob} repo={repo} onJobAction={onCommentAction} />
)}
```

- [ ] **Step 4: Hide "Fix with Claude" button when awaiting_response**

Update the button disabled/display logic. Find the "Fix with Claude" button (around line 462-469) and add the `isAwaitingResponse` check:

```tsx
{!isAwaitingResponse && (
  <Button
    variant="orange"
    size="xs"
    onClick={() => setFixModalOpen(true)}
    disabled={acting || fixing || fixBlocked}
    title={fixBlocked ? "A fix is already running on this PR" : undefined}
  >
    {fixing ? "Starting fix..." : fixBlocked ? "Fix running..." : "Fix with Claude"}
  </Button>
)}
```

- [ ] **Step 5: Build and verify**

Run: `yarn build:all`
Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/CommentThreads.tsx
git commit -m "feat: add inline conversation UI for conversational fixes in CommentThreads"
```

---

### Task 8: Update FixJobsBanner for awaiting_response

**Files:**
- Modify: `web/src/components/FixJobsBanner.tsx`

- [ ] **Step 1: Add awaiting_response to summary counts**

In the `FixJobsBanner` component (around line 238-249), add the awaiting count:

```tsx
const awaiting = fixJobs.filter((j) => j.status === "awaiting_response").length;
```

And update the summary display:

```tsx
{running > 0 && <span className="text-yellow-400">{running} running</span>}
{awaiting > 0 && <span className="text-indigo-400">{awaiting} awaiting reply</span>}
{completed > 0 && <span className="text-green-400">{completed} ready</span>}
{failed > 0 && <span className="text-red-400">{failed} failed</span>}
```

- [ ] **Step 2: Add awaiting_response to status colors and icons**

In `JobRow` and `JobModal`, add the new status to the color/icon maps. Import `HelpCircle` from lucide-react (it may already be imported elsewhere, but check FixJobsBanner's imports):

```tsx
import { Clock, Check, X, HelpCircle } from "lucide-react";
```

Update `statusColors` in both `JobRow` and `JobModal`:

```typescript
const statusColors: Record<string, string> = {
  running: "text-yellow-400",
  completed: "text-green-400",
  failed: "text-red-400",
  awaiting_response: "text-indigo-400",
};
```

Update `statusIcons` in `JobRow`:

```typescript
const statusIcons: Record<string, React.ReactNode> = {
  running: <Clock size={12} />,
  completed: <Check size={12} />,
  failed: <X size={12} />,
  awaiting_response: <HelpCircle size={12} />,
};
```

- [ ] **Step 3: Add conversation display to JobModal**

In `JobModal`, after the info grid section and before the error/diff sections, add a conversation section:

```tsx
{/* Conversation */}
{job.conversation && job.conversation.length > 0 && (
  <div className="px-4 py-3 border-b border-gray-800">
    <div className="text-xs text-gray-500 mb-1">Conversation</div>
    <div className="space-y-1.5 max-h-48 overflow-y-auto">
      {job.conversation.map((msg, i) => (
        <div key={i} className={`text-xs p-2 rounded ${
          msg.role === "claude"
            ? "bg-gray-800/60 text-gray-300 mr-8"
            : "bg-indigo-900/30 text-indigo-200 ml-8"
        }`}>
          <span className="text-[10px] text-gray-500 block mb-0.5">
            {msg.role === "claude" ? "Claude" : "You"}
          </span>
          {msg.message}
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: Add reply input to JobModal for awaiting_response**

In `JobModal`, add an actions section for `awaiting_response` status. Add state for the reply at the top of `JobModal`:

```tsx
const [replyText, setReplyText] = useState("");
```

Then add after the conversation section, before the existing action sections:

```tsx
{job.status === "awaiting_response" && (
  <div className="px-4 py-3 border-t border-gray-800">
    <div className="flex gap-2 items-end">
      <textarea
        value={replyText}
        onChange={(e) => setReplyText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && replyText.trim()) {
            setActing(true);
            void api.fixReply(job.repo, job.commentId, replyText.trim()).then(() => {
              setReplyText("");
              onJobAction();
            }).catch((err) => console.error("Reply failed:", err)).finally(() => setActing(false));
          }
        }}
        placeholder="Reply to Claude's questions..."
        disabled={acting}
        rows={2}
        autoFocus
        className="flex-1 text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
      />
      <Button
        variant="blue"
        size="xs"
        onClick={() => {
          if (!replyText.trim()) return;
          setActing(true);
          void api.fixReply(job.repo, job.commentId, replyText.trim()).then(() => {
            setReplyText("");
            onJobAction();
          }).catch((err) => console.error("Reply failed:", err)).finally(() => setActing(false));
        }}
        disabled={acting || !replyText.trim()}
      >
        {acting ? "Sending..." : "Send Reply"}
      </Button>
    </div>
  </div>
)}
```

- [ ] **Step 5: Update running spinner to show conversation context**

Replace the running spinner section to also show conversation when available:

```tsx
{job.status === "running" && (
  <div className="flex-1 flex items-center justify-center py-12 text-gray-500 text-sm">
    Claude is working on the fix...
  </div>
)}
```

This stays as-is — the conversation section above already renders for running jobs if `job.conversation` exists.

- [ ] **Step 6: Build and verify**

Run: `yarn build:all`
Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/FixJobsBanner.tsx
git commit -m "feat: update FixJobsBanner for awaiting_response status with conversation display"
```

---

### Task 9: Add fixConversationMaxTurns to Settings UI

**Files:**
- Modify: `web/src/components/SettingsView.tsx`

- [ ] **Step 1: Add field to payloadToForm**

In `SettingsView.tsx`, add to the `payloadToForm` return type and body:

Return type — add:
```typescript
fixConversationMaxTurns: number;
```

Body — add:
```typescript
fixConversationMaxTurns: c.fixConversationMaxTurns ?? 5,
```

- [ ] **Step 2: Add to handleSubmit body**

In `handleSubmit`, add to the `body` object:

```typescript
fixConversationMaxTurns: form.fixConversationMaxTurns,
```

- [ ] **Step 3: Add input in the Claude evaluation section**

In the "Claude evaluation" section (around line 474), add a new input field before the eval prompt textarea:

```tsx
<div className="grid grid-cols-2 gap-4">
  <label className="block space-y-1">
    <span className="text-sm text-gray-400">Fix conversation max turns (0 = unlimited)</span>
    <input
      type="number"
      min={0}
      max={50}
      className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
      value={form.fixConversationMaxTurns}
      onChange={(e) => update("fixConversationMaxTurns", parseInt(e.target.value, 10) || 0)}
    />
  </label>
</div>
<p className="text-xs text-gray-600">
  When Claude asks clarifying questions during a fix, this limits how many rounds of Q&amp;A before it must attempt the fix.
</p>
```

- [ ] **Step 4: Build and verify**

Run: `yarn build:all`
Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SettingsView.tsx
git commit -m "feat: add fixConversationMaxTurns to settings UI"
```

---

### Task 10: Broadcast conversation data via SSE

**Files:**
- Modify: `src/server.ts:264-275` (setFixJobStatus / sseBroadcast)

- [ ] **Step 1: Include conversation in SSE broadcast**

Currently `setFixJobStatus` broadcasts a minimal subset. Update the SSE broadcast in `setFixJobStatus` to also include `sessionId` and `conversation`:

In `src/server.ts`, update the `sseBroadcast` call inside `setFixJobStatus`:

```typescript
export function setFixJobStatus(job: FixJobStatus): void {
  fixJobStatuses.set(job.commentId, job);
  sseBroadcast("fix-job", {
    commentId: job.commentId,
    repo: job.repo,
    prNumber: job.prNumber,
    status: job.status,
    path: job.path,
    error: job.error,
    sessionId: job.sessionId,
    conversation: job.conversation,
  });
  broadcastPollStatus();
}
```

- [ ] **Step 2: Build and verify**

Run: `yarn build:all`
Expected: Clean compile.

- [ ] **Step 3: Run all tests**

Run: `yarn test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: include conversation data in SSE fix-job broadcasts"
```

---

### Task 11: End-to-end smoke test

**Files:** None (manual verification)

- [ ] **Step 1: Start dev server**

Run: `yarn dev`
Expected: CLI starts, web UI accessible at localhost:3100.

- [ ] **Step 2: Verify settings field appears**

Open Settings in the web UI. Confirm "Fix conversation max turns" field appears in the Claude evaluation section with default value 5.

- [ ] **Step 3: Verify fix flow still works**

Pick a PR with a review comment and click "Fix with Claude". Verify:
- The fix modal opens and accepts instructions
- The job appears in FixJobsBanner with "running" status
- If Claude asks questions: status changes to "awaiting_response", conversation appears inline in the thread and in the modal, reply input is available
- If Claude fixes directly: status changes to "completed" with diff

- [ ] **Step 4: Commit spec and plan**

```bash
git add docs/superpowers/specs/2026-04-14-conversational-fix-design.md docs/superpowers/plans/2026-04-14-conversational-fix.md
git commit -m "docs: add conversational fix design spec and implementation plan"
```
