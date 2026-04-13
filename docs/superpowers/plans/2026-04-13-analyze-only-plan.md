# Analyze-Only Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change cr-watch from auto-acting on comments to an analyze-and-suggest workflow where evaluations are displayed in the WebUI with action buttons.

**Architecture:** The actioner becomes analyze-only (evaluate + store, no GitHub actions). New POST API endpoints let the WebUI trigger reply/resolve/dismiss. The WebUI shifts to a threads-first layout with evaluation badges and action buttons. File changes section is collapsed by default.

**Tech Stack:** Existing stack — no new dependencies.

---

### Task 1: Update Types and State for Evaluations

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state.ts`

- [ ] **Step 1: Update `src/types.ts`**

Replace the `CommentStatus` type and add `repo` to `CommentRecord`. Add the evaluation to the record:

```typescript
export type CommentStatus = "pending" | "replied" | "fixed" | "dismissed";
```

Update `CommentRecord`:

```typescript
export interface CommentRecord {
  status: CommentStatus;
  prNumber: number;
  repo?: string;
  timestamp: string;
  evaluation?: Evaluation;
}
```

The `Evaluation` interface already exists in types.ts — update it to include `fixDescription`:

```typescript
export interface Evaluation {
  action: EvalAction;
  summary: string;
  reply?: string;
  fixDescription?: string;
}
```

- [ ] **Step 2: Update `src/state.ts` — add `markCommentWithEvaluation` function**

Add a new function after `markComment`:

```typescript
export function markCommentWithEvaluation(
  state: CrWatchState,
  commentId: number,
  status: CommentStatus,
  prNumber: number,
  evaluation: Evaluation,
  repo?: string,
): CrWatchState {
  const key = commentKey(commentId, repo);
  state.comments[key] = {
    status,
    prNumber,
    timestamp: new Date().toISOString(),
    evaluation,
  };
  return state;
}
```

Also update the `printStatus` references — in `src/cli.ts` line 34, `"seen"` becomes `"pending"`, and `"skipped"` becomes `"dismissed"`. We'll fix that in Task 3.

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles (cli.ts will have warnings about "seen"/"skipped" but not errors since they're strings).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/state.ts
git commit -m "feat: update types and state for evaluation storage"
```

---

### Task 2: Rewrite Actioner to Analyze-Only (`src/actioner.ts`)

**Files:**
- Modify: `src/actioner.ts`

- [ ] **Step 1: Replace `processComments` with `analyzeComments`**

Replace the entire `processComments` export function (lines 268-446) with:

```typescript
export async function analyzeComments(
  comments: CrComment[],
  pullsByNumber: Record<number, PrInfo>,
  state: CrWatchState,
  repoPath: string,
  dryRun: boolean,
): Promise<void> {
  const byPr: Record<number, CrComment[]> = {};
  for (const c of comments) {
    if (!byPr[c.prNumber]) byPr[c.prNumber] = [];
    byPr[c.prNumber].push(c);
  }

  for (const [prNum, prComments] of Object.entries(byPr)) {
    const prNumber = Number(prNum);
    const pr = pullsByNumber[prNumber];
    console.log(`\nAnalyzing PR #${prNum}: ${pr?.title || "Unknown"}`);

    for (const comment of prComments) {
      console.log(`\n  Evaluating: ${comment.path}:${comment.line}`);

      if (dryRun) {
        console.log(`  [dry-run] Would evaluate with Claude.`);
        markComment(state, comment.id, "pending", prNumber, repoPath);
        saveState(state);
        continue;
      }

      let evaluation: Evaluation;
      try {
        evaluation = await evaluateComment(comment);
      } catch (err) {
        console.error(`  Error evaluating comment ${comment.id}: ${(err as Error).message}`);
        markComment(state, comment.id, "pending", prNumber, repoPath);
        saveState(state);
        continue;
      }

      console.log(`  Result: ${evaluation.action} — ${evaluation.summary}`);
      markCommentWithEvaluation(state, comment.id, "pending", prNumber, evaluation, repoPath);
      saveState(state);
    }
  }
}
```

Also add the import for `markCommentWithEvaluation`:

```typescript
import { markComment, markCommentWithEvaluation, saveState } from "./state.js";
```

Remove the import of `prompt` from `./terminal.js` — it's no longer needed.

Remove the imports of `createWorktree`, `removeWorktree`, `getDiffInWorktree`, `commitAndPushWorktree` from `./worktree.js` — no longer needed.

Remove the `applyFixWithClaude` function (lines 247-266) — no longer needed.

Keep `evaluateComment`, `parseEvaluation`, `postReply`, `resolveThread`, `spawnTracked`, `killAllChildren` — the action functions are still needed for the API action endpoints.

Export `postReply` and `resolveThread` so the API can call them:

```typescript
export async function postReply(repoPath: string, prNumber: number, commentId: number, body: string): Promise<void> {
```

```typescript
export async function resolveThread(
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/actioner.ts
git commit -m "feat: replace processComments with analyze-only analyzeComments"
```

---

### Task 3: Update CLI (`src/cli.ts`)

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Update imports and calls**

Change the import from:
```typescript
import { processComments, killAllChildren } from "./actioner.js";
```
to:
```typescript
import { analyzeComments, killAllChildren } from "./actioner.js";
```

In the `poll` function, change line 118:
```typescript
await processComments(comments, pullsByNumber, state, repoInfo.repo, dryRun);
```
to:
```typescript
await analyzeComments(comments, pullsByNumber, state, repoInfo.repo, dryRun);
```

Update `printStatus` to use the new status names — change `"seen"` to `"pending"` and `"skipped"` to `"dismissed"`:

```typescript
const pending = getCommentsByStatus(state, "pending");
const replied = getCommentsByStatus(state, "replied");
const fixed = getCommentsByStatus(state, "fixed");
const dismissed = getCommentsByStatus(state, "dismissed");

console.log("\ncr-watch status:");
console.log(`  Last poll: ${state.lastPoll || "never"}`);
console.log(`  Comments: ${Object.keys(state.comments).length} total`);
console.log(`    Pending:   ${pending.length}`);
console.log(`    Replied:   ${replied.length}`);
console.log(`    Fixed:     ${fixed.length}`);
console.log(`    Dismissed: ${dismissed.length}`);
```

Update the poll status message:
```typescript
setStatus(`[${now}] Analyzed ${repos.length} repo(s).`);
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: update CLI to use analyzeComments instead of processComments"
```

---

### Task 4: Add POST Support and Action Endpoints (`src/server.ts`, `src/api.ts`)

**Files:**
- Modify: `src/server.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: Add POST body parsing to `src/server.ts`**

Update the CORS preflight to allow POST:

```typescript
"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
```

Add a body parser helper function before `startServer`:

```typescript
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
```

In the route dispatch section, for POST routes, parse the body before calling the handler. Update the route matching block to read the body for POST requests:

```typescript
// API routes
for (const route of routes) {
  if (req.method !== route.method) continue;
  const match = pathname.match(route.pattern);
  if (!match) continue;
  const params: Record<string, string> = {};
  route.paramNames.forEach((name, i) => {
    params[name] = decodeURIComponent(match[i + 1]);
  });
  try {
    // Parse body for POST requests
    if (req.method === "POST") {
      const bodyStr = await readBody(req);
      (req as any).__body = bodyStr ? JSON.parse(bodyStr) : {};
    }
    await route.handler(req, res, params, query);
  } catch (err) {
    json(res, { error: (err as Error).message }, 500);
  }
  return;
}
```

Export a helper to get the parsed body:

```typescript
export function getBody<T>(req: IncomingMessage): T {
  return (req as any).__body as T;
}
```

- [ ] **Step 2: Add action endpoints to `src/api.ts`**

Add imports at the top:

```typescript
import { loadState, markComment, saveState } from "./state.js";
import { postReply, resolveThread } from "./actioner.js";
```

Update existing `loadState` import (it's already there, just need to add `markComment` and `saveState`).

Add the import for `getBody` from server:

```typescript
import { addRoute, json, getRepos, getBody } from "./server.js";
```

Add these endpoints inside `registerRoutes()`, after the existing `GET /api/state` route:

```typescript
  // POST /api/actions/reply
  addRoute("POST", "/api/actions/reply", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];

    if (!record?.evaluation?.reply) {
      json(res, { error: "No reply text in evaluation" }, 400);
      return;
    }

    await postReply(body.repo, body.prNumber, body.commentId, record.evaluation.reply);
    await resolveThread(body.repo, body.commentId, body.prNumber, undefined);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "replied" });
  });

  // POST /api/actions/resolve
  addRoute("POST", "/api/actions/resolve", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];

    await resolveThread(body.repo, body.commentId, body.prNumber, record?.evaluation?.reply);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "replied" });
  });

  // POST /api/actions/dismiss
  addRoute("POST", "/api/actions/dismiss", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    markComment(state, body.commentId, "dismissed", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "dismissed" });
  });
```

- [ ] **Step 3: Update the GET /api/pulls/:number/comments endpoint to merge evaluation data**

In the existing comments endpoint, after building the comment list, merge in evaluation data from state:

```typescript
    const state = loadState();

    json(res, comments.map((c) => {
      const stateKey = `${repo}:${c.id}`;
      const record = state.comments[stateKey];
      return {
        id: c.id,
        author: c.user.login,
        authorAvatar: c.user.avatar_url,
        path: c.path,
        line: c.line || c.original_line || 0,
        diffHunk: c.diff_hunk,
        body: c.body,
        createdAt: c.created_at,
        inReplyToId: c.in_reply_to_id ?? null,
        isResolved: resolvedIds.has(c.id),
        evaluation: record?.evaluation ?? null,
        crStatus: record?.status ?? null,
      };
    }));
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/api.ts
git commit -m "feat: add POST body parsing and action endpoints for reply/resolve/dismiss"
```

---

### Task 5: Update WebUI Types and API Client

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`

- [ ] **Step 1: Update `web/src/types.ts`**

Add evaluation type and update ReviewComment:

```typescript
export interface CommentEvaluation {
  action: "reply" | "fix" | "resolve";
  summary: string;
  reply?: string;
  fixDescription?: string;
}
```

Add to the `ReviewComment` interface:

```typescript
export interface ReviewComment {
  id: number;
  author: string;
  authorAvatar: string;
  path: string;
  line: number;
  diffHunk: string;
  body: string;
  createdAt: string;
  inReplyToId: number | null;
  isResolved: boolean;
  evaluation: CommentEvaluation | null;
  crStatus: "pending" | "replied" | "fixed" | "dismissed" | null;
}
```

- [ ] **Step 2: Update `web/src/api.ts`**

Add a `postJSON` helper and action methods:

```typescript
async function postJSON<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}
```

Add to the `api` object:

```typescript
  replyToComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/reply", { repo, commentId, prNumber }),
  resolveComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/resolve", { repo, commentId, prNumber }),
  dismissComment: (repo: string, commentId: number, prNumber: number) =>
    postJSON<{ success: boolean }>("/api/actions/dismiss", { repo, commentId, prNumber }),
```

- [ ] **Step 3: Commit**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat: add evaluation types and action methods to WebUI API client"
```

---

### Task 6: Update CommentThreads with Evaluations and Action Buttons

**Files:**
- Modify: `web/src/components/CommentThreads.tsx`

- [ ] **Step 1: Rewrite CommentThreads.tsx**

Replace the entire file. Key changes:
- Remove `max-h-80` — threads panel is the main content area now
- Add evaluation badges (green "Can Resolve", blue "Suggest Reply", orange "Needs Fix")
- Show suggested reply/fix text in expandable section
- Add action buttons (Send Reply, Resolve, Dismiss)
- Show status after action taken (Replied ✓, Dismissed)
- Pass `repo` and `prNumber` for API calls

```tsx
import { useState } from "react";
import type { ReviewComment } from "../types";
import { api } from "../api";
import Comment from "./Comment";

interface CommentThreadsProps {
  comments: ReviewComment[];
  onSelectFile: (filename: string) => void;
  repo: string;
  prNumber: number;
  onCommentAction: () => void;
}

interface Thread {
  root: ReviewComment;
  replies: ReviewComment[];
  isResolved: boolean;
}

function buildThreads(comments: ReviewComment[]): Thread[] {
  const rootComments = comments.filter((c) => c.inReplyToId === null);
  const replyMap = new Map<number, ReviewComment[]>();

  for (const c of comments) {
    if (c.inReplyToId !== null) {
      const existing = replyMap.get(c.inReplyToId) ?? [];
      existing.push(c);
      replyMap.set(c.inReplyToId, existing);
    }
  }

  const threads: Thread[] = rootComments.map((root) => {
    const replies = (replyMap.get(root.id) ?? []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const isResolved = root.isResolved || replies.some((r) => r.isResolved);
    return { root, replies, isResolved };
  });

  threads.sort((a, b) => {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
    return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
  });

  return threads;
}

function EvalBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    resolve: "bg-green-500/20 text-green-400",
    reply: "bg-blue-500/20 text-blue-400",
    fix: "bg-orange-500/20 text-orange-400",
  };
  const labels: Record<string, string> = {
    resolve: "Can Resolve",
    reply: "Suggest Reply",
    fix: "Needs Fix",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-sans ${styles[action] ?? "bg-gray-500/20 text-gray-400"}`}>
      {labels[action] ?? action}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "replied") return <span className="text-xs text-green-400">Replied ✓</span>;
  if (status === "dismissed") return <span className="text-xs text-gray-500">Dismissed</span>;
  if (status === "fixed") return <span className="text-xs text-blue-400">Fixed ✓</span>;
  return null;
}

function ThreadItem({ thread, onSelectFile, repo, prNumber, onCommentAction }: {
  thread: Thread;
  onSelectFile: (f: string) => void;
  repo: string;
  prNumber: number;
  onCommentAction: () => void;
}) {
  const eval_ = thread.root.evaluation;
  const status = thread.root.crStatus;
  const isActedOn = status === "replied" || status === "dismissed" || status === "fixed";
  const [expanded, setExpanded] = useState(!thread.isResolved && !isActedOn);
  const [acting, setActing] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);

  async function handleAction(action: "reply" | "resolve" | "dismiss") {
    setActing(true);
    try {
      if (action === "reply") {
        await api.replyToComment(repo, thread.root.id, prNumber);
      } else if (action === "resolve") {
        await api.resolveComment(repo, thread.root.id, prNumber);
      } else {
        await api.dismissComment(repo, thread.root.id, prNumber);
      }
      onCommentAction();
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setActing(false);
    }
  }

  return (
    <div className={`border rounded-lg overflow-hidden ${
      thread.isResolved || isActedOn ? "border-gray-800/50 opacity-70" : "border-gray-800"
    }`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 bg-gray-800/50 text-left text-xs font-mono flex items-center justify-between hover:bg-gray-800/80 transition-colors"
      >
        <span
          onClick={(e) => { e.stopPropagation(); onSelectFile(thread.root.path); }}
          className="text-blue-400 hover:text-blue-300"
        >
          {thread.root.path}:{thread.root.line}
        </span>
        <span className="flex items-center gap-2">
          {isActedOn && <StatusBadge status={status!} />}
          {!isActedOn && eval_ && <EvalBadge action={eval_.action} />}
          {thread.isResolved && <span className="text-green-500/70 text-xs font-sans">Resolved</span>}
          <span className="text-gray-600 text-xs">{expanded ? "▼" : "▶"}</span>
        </span>
      </button>
      {expanded && (
        <div className="p-2 space-y-0">
          <Comment comment={thread.root} compact />
          {thread.replies.map((reply) => (
            <Comment key={reply.id} comment={reply} compact />
          ))}

          {/* Evaluation suggestion */}
          {eval_ && !isActedOn && (
            <div className="mx-1 mt-2">
              <button
                onClick={() => setShowSuggestion(!showSuggestion)}
                className="text-xs text-gray-400 hover:text-gray-300 flex items-center gap-1"
              >
                <span>{showSuggestion ? "▼" : "▶"}</span>
                <span>
                  {eval_.action === "fix" ? "Suggested fix" : "Suggested response"}
                  {eval_.summary && <span className="text-gray-600 ml-1">— {eval_.summary}</span>}
                </span>
              </button>
              {showSuggestion && (
                <div className="mt-1 p-2 bg-gray-800/50 rounded text-xs text-gray-300 whitespace-pre-wrap border border-gray-700">
                  {eval_.action === "fix" ? (eval_.fixDescription || eval_.summary) : (eval_.reply || eval_.summary)}
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          {eval_ && !isActedOn && !thread.isResolved && (
            <div className="flex items-center gap-2 mx-1 mt-2 pt-2 border-t border-gray-800">
              {eval_.action === "reply" && eval_.reply && (
                <button
                  onClick={() => handleAction("reply")}
                  disabled={acting}
                  className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-gray-400 text-white rounded transition-colors"
                >
                  {acting ? "Sending..." : "Send Reply"}
                </button>
              )}
              {eval_.action === "fix" && (
                <button
                  disabled
                  className="text-xs px-3 py-1 bg-gray-700 text-gray-500 rounded cursor-not-allowed"
                  title="Coming soon"
                >
                  Apply Fix
                </button>
              )}
              <button
                onClick={() => handleAction("resolve")}
                disabled={acting}
                className="text-xs px-3 py-1 bg-green-600/80 hover:bg-green-500/80 disabled:bg-green-800/50 disabled:text-gray-400 text-white rounded transition-colors"
              >
                Resolve
              </button>
              <button
                onClick={() => handleAction("dismiss")}
                disabled={acting}
                className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-400 text-gray-300 rounded transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CommentThreads({ comments, onSelectFile, repo, prNumber, onCommentAction }: CommentThreadsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const threads = buildThreads(comments);

  if (threads.length === 0) return null;

  const openCount = threads.filter((t) => !t.isResolved).length;
  const resolvedCount = threads.filter((t) => t.isResolved).length;

  return (
    <div className="border-b border-gray-800 flex-1 overflow-y-auto">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30 sticky top-0 bg-gray-950 z-10"
      >
        <span>
          Review Threads ({threads.length})
          {resolvedCount > 0 && (
            <span className="normal-case ml-2 text-gray-600">
              {openCount} open, {resolvedCount} resolved
            </span>
          )}
        </span>
        <span className="text-gray-600">{collapsed ? "▶" : "▼"}</span>
      </button>
      {!collapsed && (
        <div className="px-6 pb-3 space-y-3">
          {threads.map((thread) => (
            <ThreadItem
              key={thread.root.id}
              thread={thread}
              onSelectFile={onSelectFile}
              repo={repo}
              prNumber={prNumber}
              onCommentAction={onCommentAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/CommentThreads.tsx
git commit -m "feat: add evaluation badges and action buttons to comment threads"
```

---

### Task 7: Update App.tsx Layout — Threads-First, Files Collapsed

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Update App.tsx**

Key changes:
- Pass `repo` and `prNumber` to `CommentThreads`
- Add `onCommentAction` callback that reloads comments
- Wrap FileList + DiffView in a collapsible section, collapsed by default
- CommentThreads gets `flex-1 overflow-y-auto` to be the main scrollable area

Update the `CommentThreads` usage to pass new props:

```tsx
<CommentThreads
  comments={prComments}
  onSelectFile={(f) => { setFilesExpanded(true); setSelectedFile(f); }}
  repo={selectedPR!.repo}
  prNumber={selectedPR!.number}
  onCommentAction={reloadComments}
/>
```

Add state for file section collapse and reload function:

```typescript
const [filesExpanded, setFilesExpanded] = useState(false);

async function reloadComments() {
  if (!selectedPR) return;
  try {
    const comments = await api.getPullComments(selectedPR.number, selectedPR.repo);
    setPrComments(comments);
  } catch (err) {
    console.error("Failed to reload comments:", err);
  }
}
```

Wrap the FileList and DiffView in a collapsible section:

```tsx
{/* Collapsible files section */}
<div className="border-t border-gray-800 shrink-0">
  <button
    onClick={() => setFilesExpanded(!filesExpanded)}
    className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30"
  >
    <span>Files Changed ({prFiles.length})</span>
    <span className="text-gray-600">{filesExpanded ? "▼" : "▶"}</span>
  </button>
</div>
{filesExpanded && (
  <>
    <FileList
      files={prFiles}
      selectedFile={selectedFile}
      onSelectFile={setSelectedFile}
      comments={prComments}
    />
    <div className="flex-1 overflow-y-auto">
      {selectedFile ? (
        (() => {
          const file = prFiles.find((f) => f.filename === selectedFile);
          const fileComments = prComments.filter((c) => c.path === selectedFile);
          return file ? (
            <DiffView patch={file.patch} filename={file.filename} comments={fileComments} />
          ) : null;
        })()
      ) : (
        <div className="text-gray-500 text-center mt-12">Select a file to view its diff</div>
      )}
    </div>
  </>
)}
```

Remove the old non-collapsible FileList + DiffView section and replace with the above.

- [ ] **Step 2: Build everything**

```bash
npm run build:all
```

Expected: Both CLI and web build succeed.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: threads-first layout with collapsible files section"
```
