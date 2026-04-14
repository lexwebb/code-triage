# No-Changes Fix Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Claude fix produces no code changes, present the explanation as a suggested reply instead of a failure, letting the user review and post it to GitHub.

**Architecture:** Add `"no_changes"` status to FixJobStatus with a `suggestedReply` field. Backend detects empty diff and sets this status with Claude's parsed message. New API endpoint posts the reply and resolves the thread. Frontend shows a distinct UI with editable reply and action buttons.

**Tech Stack:** TypeScript/ESM backend, React frontend, existing `postReply`/`resolveThread` from actioner.ts.

**Spec:** `docs/superpowers/specs/2026-04-14-no-changes-fix-reply-design.md`

---

### Task 1: Add `no_changes` status and `suggestedReply` to types

**Files:**
- Modify: `src/server.ts:194-207` (FixJobStatus interface)
- Modify: `web/src/api.ts:34-48` (frontend FixJobStatus interface)

- [ ] **Step 1: Update backend FixJobStatus**

In `src/server.ts`, change the `status` union on line 200:

```typescript
status: "running" | "completed" | "failed" | "no_changes" | "awaiting_response";
```

Add `suggestedReply` field after `conversation`:

```typescript
suggestedReply?: string;
```

- [ ] **Step 2: Update frontend FixJobStatus**

In `web/src/api.ts`, change the `status` union on line 40:

```typescript
status: "running" | "completed" | "failed" | "no_changes" | "awaiting_response";
```

Add `suggestedReply` field after `conversation`:

```typescript
suggestedReply?: string;
```

- [ ] **Step 3: Build to verify**

Run: `yarn build:all`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server.ts web/src/api.ts
git commit -m "feat: add no_changes status and suggestedReply to FixJobStatus"
```

---

### Task 2: Backend — detect no-changes and set `no_changes` status

**Files:**
- Modify: `src/api.ts:1081-1092` (empty-diff branch in fix endpoint)

- [ ] **Step 1: Update the empty-diff branch**

In `src/api.ts`, find the block that handles an empty diff (around line 1081):

```typescript
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
```

Replace with:

```typescript
if (!diff.trim()) {
  removeWorktree(body.branch, repoInfo?.localPath);
  const s = loadState();
  removeFixJobState(s, body.commentId);
  saveState(s);
  setFixJobStatus({
    commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
    path: body.comment.path, startedAt: Date.now(), status: "no_changes",
    suggestedReply: result.message,
    claudeOutput: result.message,
  });
  return;
}
```

Changes: `status: "failed"` → `status: "no_changes"`, removed `error`, added `suggestedReply: result.message`, changed `claudeOutput` from `result.rawOutput` to `result.message` (clean parsed text).

- [ ] **Step 2: Also clean up claudeOutput for successful fixes**

In the successful-diff branch (around line 1098-1103), change `claudeOutput` from raw to parsed:

```typescript
setFixJobStatus({
  commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
  path: body.comment.path, startedAt: Date.now(), status: "completed",
  diff, branch: body.branch, claudeOutput: result.message,
  conversation: [{ role: "claude", message: result.message }],
});
```

Change: `claudeOutput: result.rawOutput` → `claudeOutput: result.message`.

- [ ] **Step 3: Build and test**

Run: `yarn test && yarn build:all`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/api.ts
git commit -m "feat: detect no-changes fix and set no_changes status with suggested reply"
```

---

### Task 3: New endpoint — `POST /api/actions/fix-reply-and-resolve`

**Files:**
- Modify: `src/api.ts` (add new route after the fix-discard route)

- [ ] **Step 1: Add the endpoint**

In `src/api.ts`, after the `POST /api/actions/fix-discard` route (around line 1152), add:

```typescript
  // POST /api/actions/fix-reply-and-resolve — post suggested reply and resolve the thread
  addRoute("POST", "/api/actions/fix-reply-and-resolve", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number; replyBody: string }>(req);

    try {
      await postReply(body.repo, body.prNumber, body.commentId, body.replyBody);
      await resolveThread(body.repo, body.commentId, body.prNumber, undefined);
    } catch (err) {
      json(res, { error: `Reply failed: ${(err as Error).message}` }, 500);
      return;
    }

    const state = loadState();
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    clearFixJobStatus(body.commentId);

    json(res, { success: true });
  });
```

Note: `postReply` and `resolveThread` are already imported from `./actioner.js`. `markComment` is already imported from `./state.js`. `clearFixJobStatus` is already imported from `./server.js`. Verify these imports exist — if `markComment` was removed in the eval-queue cleanup, re-add it to the import.

- [ ] **Step 2: Add the frontend API method**

In `web/src/api.ts`, add to the `api` object (after `fixReply`):

```typescript
fixReplyAndResolve: (repo: string, commentId: number, prNumber: number, replyBody: string) =>
  postJSON<{ success: boolean }>("/api/actions/fix-reply-and-resolve", { repo, commentId, prNumber, replyBody }),
```

- [ ] **Step 3: Build and test**

Run: `yarn test && yarn build:all`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/api.ts web/src/api.ts
git commit -m "feat: add fix-reply-and-resolve endpoint for no-changes fix suggestions"
```

---

### Task 4: Frontend — no_changes UI in FixJobsBanner

**Files:**
- Modify: `web/src/components/FixJobsBanner.tsx`

- [ ] **Step 1: Add `no_changes` to status colors and icons**

In the `JobModal` component, update the `statusColors` object (around line 69):

```typescript
const statusColors: Record<string, string> = {
  running: "text-yellow-400",
  completed: "text-green-400",
  failed: "text-red-400",
  no_changes: "text-blue-400",
  awaiting_response: "text-indigo-400",
};
```

In the `JobRow` component, update both `statusColors` and `statusIcons` objects similarly:

```typescript
const statusColors: Record<string, string> = {
  running: "text-yellow-400",
  completed: "text-green-400",
  failed: "text-red-400",
  no_changes: "text-blue-400",
  awaiting_response: "text-indigo-400",
};
const statusIcons: Record<string, React.ReactNode> = {
  running: <Clock size={12} />,
  completed: <Check size={12} />,
  failed: <X size={12} />,
  no_changes: <HelpCircle size={12} />,
  awaiting_response: <HelpCircle size={12} />,
};
```

Also update the status label in `JobRow` — currently it shows `job.status` directly. For `no_changes`, display `"no changes"` instead:

```typescript
{job.status === "no_changes" ? "no changes" : job.status}
```

- [ ] **Step 2: Add `no_changes` state to `JobRow` status display in banner summary**

In the `FixJobsBanner` component, add a count for `no_changes` alongside the existing counts:

```typescript
const noChanges = fixJobs.filter((j) => j.status === "no_changes").length;
```

And in the summary bar, after the `failed` span:

```typescript
{noChanges > 0 && <span className="text-blue-400">{noChanges} no changes</span>}
```

- [ ] **Step 3: Add `no_changes` display section in JobModal**

Add a new section in the modal, after the error section and before the diff section. Add state for the editable reply:

At the top of `JobModal`, add state:

```typescript
const [noChangesReply, setNoChangesReply] = useState(job.suggestedReply ?? "");
```

Then add the display section in the modal body (after the error block, before the diff block):

```typescript
{/* No changes — suggested reply */}
{job.status === "no_changes" && job.suggestedReply && (
  <div className="px-4 py-3 border-b border-gray-800">
    <div className="text-xs text-gray-500 mb-1">Claude determined no code changes are needed</div>
    <div className="text-xs text-gray-500 mb-2">Review and optionally edit the reply before sending:</div>
    <textarea
      value={noChangesReply}
      onChange={(e) => setNoChangesReply(e.target.value)}
      rows={4}
      className="w-full text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y"
    />
  </div>
)}
```

- [ ] **Step 4: Add action buttons for `no_changes` status**

After the existing `failed` action buttons block, add:

```typescript
{job.status === "no_changes" && (
  <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
    <Button
      variant="blue"
      size="xs"
      onClick={async () => {
        if (!noChangesReply.trim()) return;
        setActing(true);
        try {
          await api.fixReplyAndResolve(job.repo, job.commentId, job.prNumber, noChangesReply.trim());
          onJobAction();
          onClose();
        } catch (err) {
          console.error("Reply failed:", err);
        } finally {
          setActing(false);
        }
      }}
      disabled={acting || !noChangesReply.trim()}
    >
      {acting ? "Sending..." : "Send Reply & Resolve"}
    </Button>
    <Button variant="gray" size="xs" onClick={onClose}>
      Dismiss
    </Button>
  </div>
)}
```

- [ ] **Step 5: Build**

Run: `yarn build:all`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/FixJobsBanner.tsx
git commit -m "feat: no_changes fix UI with editable reply and send/dismiss buttons"
```
