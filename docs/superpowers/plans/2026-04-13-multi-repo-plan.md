# Multi-Repo Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `--repo` flag with automatic discovery of all GitHub repos under a root directory, and update the API + WebUI to support multiple repos.

**Architecture:** A new `discovery.ts` module scans a root directory for git repos with GitHub remotes. The CLI, poller, API, and WebUI all become multi-repo aware. State keys are prefixed with repo names to avoid collisions.

**Tech Stack:** Node.js `fs`, `child_process`, existing `gh` CLI patterns

---

### Task 1: Discovery Module (`src/discovery.ts`)

**Files:**
- Create: `src/discovery.ts`

- [ ] **Step 1: Create the discovery module**

Create `src/discovery.ts`:

```typescript
import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { homedir } from "os";

export interface RepoInfo {
  repo: string;      // "owner/repo"
  localPath: string;  // absolute path to repo root
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "vendor", "dist", ".cr-worktrees",
  ".cache", ".npm", ".pnpm", "build", "__pycache__",
]);

const MAX_DEPTH = 3;

function parseGitHubRemote(url: string): string | null {
  // SSH: git@github.com:owner/repo.git
  // HTTPS: https://github.com/owner/repo.git
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function getGitHubRepo(dir: string): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseGitHubRemote(remote);
  } catch {
    return null;
  }
}

function walkDirectory(dir: string, depth: number, results: RepoInfo[]): void {
  if (depth > MAX_DEPTH) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // permission denied, etc.
  }

  // If this directory is a git repo, check for GitHub remote
  if (entries.includes(".git")) {
    const repo = getGitHubRepo(dir);
    if (repo) {
      results.push({ repo, localPath: dir });
    }
    return; // Don't recurse into git repos
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        walkDirectory(fullPath, depth + 1, results);
      }
    } catch {
      // permission denied, broken symlink, etc.
    }
  }
}

export function discoverRepos(root: string): RepoInfo[] {
  const expandedRoot = root.replace(/^~/, homedir());
  if (!existsSync(expandedRoot)) {
    console.error(`  Root directory not found: ${expandedRoot}`);
    return [];
  }
  const results: RepoInfo[] = [];
  walkDirectory(expandedRoot, 0, results);
  results.sort((a, b) => a.repo.localeCompare(b.repo));
  return results;
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/discovery.ts
git commit -m "feat: add repo discovery module for scanning git directories"
```

---

### Task 2: Update CLI for Multi-Repo (`src/cli.ts`)

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Update cli.ts for multi-repo support**

Replace the entire contents of `src/cli.ts` with:

```typescript
#!/usr/bin/env node
import { parseArgs } from "util";
import { loadState, saveState, isNewComment, getCommentsByStatus } from "./state.js";
import { fetchNewComments, getRepoFromGit } from "./poller.js";
import { notifyNewComments } from "./notifier.js";
import { processComments, killAllChildren } from "./actioner.js";
import { cleanupAllWorktrees } from "./worktree.js";
import {
  enableRawMode,
  registerHotkeys,
  setNextPollTime,
  clearCountdown,
  setStatus,
  setProcessing,
  cleanup as cleanupTerminal,
} from "./terminal.js";
import { startServer } from "./server.js";
import { discoverRepos, type RepoInfo } from "./discovery.js";

const { values: flags } = parseArgs({
  options: {
    interval: { type: "string", default: "5" },
    repo: { type: "string" },
    root: { type: "string", default: "~/src" },
    cleanup: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    port: { type: "string", default: "3100" },
  },
});

function printStatus(): void {
  const state = loadState();
  const seen = getCommentsByStatus(state, "seen");
  const replied = getCommentsByStatus(state, "replied");
  const fixed = getCommentsByStatus(state, "fixed");
  const skipped = getCommentsByStatus(state, "skipped");

  console.log("\ncr-watch status:");
  console.log(`  Last poll: ${state.lastPoll || "never"}`);
  console.log(`  Comments: ${Object.keys(state.comments).length} total`);
  console.log(`    Pending:  ${seen.length}`);
  console.log(`    Replied:  ${replied.length}`);
  console.log(`    Fixed:    ${fixed.length}`);
  console.log(`    Skipped:  ${skipped.length}`);
  console.log("");
}

if (flags.cleanup) {
  cleanupAllWorktrees();
  process.exit(0);
}

if (flags.status) {
  printStatus();
  process.exit(0);
}

const intervalMs = parseInt(flags.interval!, 10) * 60 * 1000;
const dryRun = flags["dry-run"]!;

// Resolve repos: single repo mode or multi-repo discovery
let repos: RepoInfo[];
if (flags.repo) {
  repos = [{ repo: flags.repo, localPath: "" }];
} else {
  console.log(`Discovering repos in ${flags.root}...`);
  repos = discoverRepos(flags.root!);
  if (repos.length === 0) {
    console.error("No GitHub repos found. Use --root to specify a different directory, or --repo for a single repo.");
    process.exit(1);
  }
}

console.log(`cr-watch started`);
console.log(`  Repos: ${repos.length}`);
for (const r of repos) {
  console.log(`    ${r.repo}`);
}
console.log(`  Interval: ${flags.interval}m`);
console.log(`  Dry run: ${dryRun}\n`);

startServer(parseInt(flags.port!, 10), repos);

let running = false;
let shuttingDown = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  setNextPollTime(intervalMs);
  pollTimer = setTimeout(poll, intervalMs);
}

async function poll(): Promise<void> {
  if (running || shuttingDown) return;
  running = true;
  setProcessing(true);

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  clearCountdown();

  try {
    const state = loadState();
    setStatus(`Polling ${repos.length} repo(s)...`);

    for (const repoInfo of repos) {
      try {
        const { comments, pullsByNumber } = await fetchNewComments(repoInfo.repo, (id) =>
          isNewComment(state, id, repoInfo.repo),
        );

        if (comments.length > 0) {
          notifyNewComments(comments, pullsByNumber);
          await processComments(comments, pullsByNumber, state, repoInfo.repo, dryRun);
        }
      } catch (err) {
        console.error(`\n  Error polling ${repoInfo.repo}: ${(err as Error).message}`);
      }
    }

    state.lastPoll = new Date().toISOString();
    saveState(state);

    const now = new Date().toLocaleTimeString();
    setStatus(`[${now}] Polled ${repos.length} repo(s).`);
  } catch (err) {
    console.error(`\nPoll error: ${(err as Error).message}`);
    setStatus(`Error: ${(err as Error).message}`);
  }

  running = false;
  setProcessing(false);
  schedulePoll();
}

async function listPRs(): Promise<void> {
  if (running) return;
  running = true;
  setProcessing(true);

  try {
    for (const repoInfo of repos) {
      const state = loadState();
      const { comments, pullsByNumber } = await fetchNewComments(repoInfo.repo, (id) =>
        isNewComment(state, id, repoInfo.repo),
      );

      const prNumbers = Object.keys(pullsByNumber);
      if (prNumbers.length === 0) continue;

      console.log(`\n  ${repoInfo.repo} (${prNumbers.length} PRs):`);
      for (const prNum of prNumbers) {
        const pr = pullsByNumber[Number(prNum)];
        const prComments = comments.filter((c) => c.prNumber === Number(prNum));
        const commentStr = prComments.length > 0 ? ` — ${prComments.length} new comment(s)` : "";
        console.log(`    PR #${prNum}: ${pr.title} (${pr.branch})${commentStr}`);
      }
    }
    console.log("");
  } catch (err) {
    console.error(`\n  Error fetching PRs: ${(err as Error).message}\n`);
  }

  running = false;
  setProcessing(false);
}

function rediscover(): void {
  if (flags.repo) {
    console.log("\n  Single-repo mode, skipping discovery.\n");
    return;
  }
  console.log("\n  Re-discovering repos...");
  repos = discoverRepos(flags.root!);
  console.log(`  Found ${repos.length} repo(s).`);
  for (const r of repos) {
    console.log(`    ${r.repo}`);
  }
  console.log("");
  // Update the server's repo list
  startServer.updateRepos?.(repos);
}

function clearState(): void {
  saveState({ lastPoll: null, comments: {} });
  console.log("\n  State cleared.\n");
  setStatus("State cleared.");
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanupTerminal();
  console.log("\n\nShutting down cr-watch...");
  if (pollTimer) clearTimeout(pollTimer);
  killAllChildren();
  const check = setInterval(() => {
    if (!running) {
      clearInterval(check);
      console.log("Goodbye.");
      process.exit(0);
    }
  }, 100);
  setTimeout(() => {
    console.log("Force exiting.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Register hotkeys
registerHotkeys([
  { key: "r", label: "Refresh", handler: () => { poll(); } },
  { key: "d", label: "Discover", handler: rediscover },
  { key: "c", label: "Clear state", handler: clearState },
  { key: "s", label: "Status", handler: () => { printStatus(); } },
  { key: "p", label: "List PRs", handler: () => { listPRs(); } },
  { key: "q", label: "Quit", handler: shutdown },
]);

// Initial poll, then enter interactive mode
await poll();
enableRawMode();
```

Note: The `startServer.updateRepos?.()` call won't work yet — we'll handle that in Task 4 when we refactor the server. For now, remove that line and just leave the `rediscover` function without the server update. The server will be updated in Task 4.

Actually, let's simplify: make `repos` a module-level `let` and export a getter. But the cleanest approach is to just store repos in a mutable variable that the server module can access. We'll handle this properly in Task 4.

For this task, remove the `startServer.updateRepos?.(repos);` line from `rediscover()`.

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: update CLI for multi-repo discovery with --root flag"
```

---

### Task 3: Update State for Repo-Prefixed Keys (`src/state.ts`)

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Update state functions to support repo-prefixed keys**

Replace the entire contents of `src/state.ts` with:

```typescript
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CrWatchState, CommentStatus } from "./types.js";

const STATE_DIR = join(homedir(), ".cr-watch");
const STATE_FILE = join(STATE_DIR, "state.json");
const STATE_TMP = join(STATE_DIR, "state.json.tmp");

const DEFAULT_STATE: CrWatchState = {
  lastPoll: null,
  comments: {},
};

export function loadState(): CrWatchState {
  if (!existsSync(STATE_FILE)) {
    return { ...DEFAULT_STATE };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as CrWatchState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: CrWatchState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_TMP, JSON.stringify(state, null, 2));
  renameSync(STATE_TMP, STATE_FILE);
}

function commentKey(commentId: number, repo?: string): string {
  return repo ? `${repo}:${commentId}` : String(commentId);
}

export function markComment(
  state: CrWatchState,
  commentId: number,
  status: CommentStatus,
  prNumber: number,
  repo?: string,
): CrWatchState {
  const key = commentKey(commentId, repo);
  state.comments[key] = {
    status,
    prNumber,
    timestamp: new Date().toISOString(),
  };
  return state;
}

export function isNewComment(state: CrWatchState, commentId: number, repo?: string): boolean {
  // Check prefixed key first, then fall back to unprefixed (migration)
  const prefixedKey = commentKey(commentId, repo);
  if (state.comments[prefixedKey]) return false;
  // Backward compat: check unprefixed key
  if (state.comments[String(commentId)]) return false;
  return true;
}

export function getCommentsByStatus(state: CrWatchState, status: CommentStatus) {
  return Object.entries(state.comments)
    .filter(([, v]) => v.status === status)
    .map(([id, v]) => ({ id, ...v }));
}
```

- [ ] **Step 2: Update actioner.ts to pass repo to markComment**

In `src/actioner.ts`, the `processComments` function already receives `repoPath`. Update all `markComment` calls to pass `repoPath` as the last argument. There are many calls — find and replace all instances of:

```typescript
markComment(state, comment.id, "seen", prNumber)
```
with:
```typescript
markComment(state, comment.id, "seen", prNumber, repoPath)
```

And same for all other status strings ("replied", "fixed", "skipped"). Do this for every `markComment` call in the file. There are approximately 12 calls.

- [ ] **Step 3: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/state.ts src/actioner.ts
git commit -m "feat: namespace state comment keys by repo for multi-repo support"
```

---

### Task 4: Update Server and API for Multi-Repo (`src/server.ts`, `src/api.ts`)

**Files:**
- Modify: `src/server.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: Update server.ts to accept RepoInfo array and expose repo updater**

Replace the entire contents of `src/server.ts` with:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { registerRoutes } from "./api.js";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import type { RepoInfo } from "./discovery.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: URLSearchParams) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  }).replace(/\*(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "(.+)";
  });
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  const ext = extname(filePath);
  const contentType = mimeTypes[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  res.end(readFileSync(filePath));
  return true;
}

let currentRepos: RepoInfo[] = [];

export function updateRepos(repos: RepoInfo[]): void {
  currentRepos = repos;
}

export function getRepos(): RepoInfo[] {
  return currentRepos;
}

export function startServer(port: number, repos: RepoInfo[]): void {
  currentRepos = repos;
  registerRoutes();
  const webDist = join(__dirname, "..", "web", "dist");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;
    const query = url.searchParams;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

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
        await route.handler(req, res, params, query);
      } catch (err) {
        json(res, { error: (err as Error).message }, 500);
      }
      return;
    }

    // Static file serving (production)
    if (existsSync(webDist)) {
      const filePath = join(webDist, pathname === "/" ? "index.html" : pathname);
      if (serveStatic(res, filePath)) return;
      // SPA fallback
      if (!pathname.startsWith("/api")) {
        serveStatic(res, join(webDist, "index.html"));
        return;
      }
    }

    json(res, { error: "Not found" }, 404);
  });

  server.listen(port, () => {
    console.log(`  WebUI: http://localhost:${port}\n`);
  });
}

export { addRoute, json };
```

Key changes from before:
- `RouteHandler` now receives `query: URLSearchParams` as 4th argument
- `startServer` takes `RepoInfo[]` instead of a single `string`
- Added `updateRepos()` and `getRepos()` exports
- `registerRoutes()` no longer takes a repo argument — it reads from `getRepos()`

- [ ] **Step 2: Rewrite api.ts for multi-repo**

Replace the entire contents of `src/api.ts` with:

```typescript
import { execFileSync } from "child_process";
import { addRoute, json, getRepos } from "./server.js";
import { loadState } from "./state.js";

function gh<T>(endpoint: string): T {
  const result = execFileSync("gh", ["api", endpoint, "--paginate"], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return JSON.parse(result) as T;
}

function getUsername(): string {
  return execFileSync("gh", ["api", "/user", "--jq", ".login"], {
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
}

function requireRepo(query: URLSearchParams): string {
  const repo = query.get("repo");
  if (!repo) throw new Error("Missing required ?repo= query parameter");
  // Validate repo is in our discovered list
  const repos = getRepos();
  if (!repos.some((r) => r.repo === repo)) {
    throw new Error(`Repo "${repo}" is not tracked`);
  }
  return repo;
}

interface GhPull {
  number: number;
  title: string;
  user: { login: string; avatar_url: string };
  head: { ref: string };
  base: { ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
}

export function registerRoutes(): void {

  // GET /api/user
  addRoute("GET", "/api/user", (_req, res) => {
    const result = execFileSync("gh", ["api", "/user"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const user = JSON.parse(result) as { login: string; avatar_url: string; html_url: string };
    json(res, { login: user.login, avatarUrl: user.avatar_url, url: user.html_url });
  });

  // GET /api/repos
  addRoute("GET", "/api/repos", (_req, res) => {
    json(res, getRepos());
  });

  // GET /api/pulls?repo=owner/repo (optional — if omitted, returns all)
  addRoute("GET", "/api/pulls", (_req, res, _params, query) => {
    const username = getUsername();
    const repoFilter = query.get("repo");
    const targetRepos = repoFilter
      ? getRepos().filter((r) => r.repo === repoFilter)
      : getRepos();

    const allPulls: Array<Record<string, unknown>> = [];

    for (const repoInfo of targetRepos) {
      try {
        const pulls = gh<GhPull[]>(`/repos/${repoInfo.repo}/pulls?state=open`);
        const myPulls = pulls.filter((pr) => pr.user.login === username);

        for (const pr of myPulls) {
          allPulls.push({
            number: pr.number,
            title: pr.title,
            author: pr.user.login,
            authorAvatar: pr.user.avatar_url,
            branch: pr.head.ref,
            baseBranch: pr.base.ref,
            url: pr.html_url,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            draft: pr.draft,
            repo: repoInfo.repo,
          });
        }
      } catch {
        // Skip repos that fail (e.g., no access)
      }
    }

    json(res, allPulls);
  });

  // GET /api/pulls/:number?repo=owner/repo
  addRoute("GET", "/api/pulls/:number", (_req, res, params, query) => {
    const repo = requireRepo(query);
    const pr = gh<{
      number: number;
      title: string;
      body: string;
      user: { login: string; avatar_url: string };
      head: { ref: string };
      base: { ref: string };
      html_url: string;
      created_at: string;
      updated_at: string;
      draft: boolean;
      additions: number;
      deletions: number;
      changed_files: number;
    }>(`/repos/${repo}/pulls/${params.number}`);

    json(res, {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.user.login,
      authorAvatar: pr.user.avatar_url,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      draft: pr.draft,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      repo,
    });
  });

  // GET /api/pulls/:number/files?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/files", (_req, res, params, query) => {
    const repo = requireRepo(query);

    interface GhFile {
      sha: string;
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }

    const files = gh<GhFile[]>(`/repos/${repo}/pulls/${params.number}/files`);

    json(res, files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || "",
    })));
  });

  // GET /api/pulls/:number/comments?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/comments", (_req, res, params, query) => {
    const repo = requireRepo(query);

    interface GhComment {
      id: number;
      user: { login: string; avatar_url: string };
      path: string;
      line: number | null;
      original_line: number | null;
      diff_hunk: string;
      body: string;
      created_at: string;
      in_reply_to_id: number | null;
    }

    const comments = gh<GhComment[]>(`/repos/${repo}/pulls/${params.number}/comments`);

    json(res, comments.map((c) => ({
      id: c.id,
      author: c.user.login,
      authorAvatar: c.user.avatar_url,
      path: c.path,
      line: c.line || c.original_line || 0,
      diffHunk: c.diff_hunk,
      body: c.body,
      createdAt: c.created_at,
      inReplyToId: c.in_reply_to_id,
    })));
  });

  // GET /api/pulls/:number/files/*path?repo=owner/repo (full file content)
  addRoute("GET", "/api/pulls/:number/files/*path", (_req, res, params, query) => {
    const repo = requireRepo(query);
    const pr = gh<{ head: { ref: string } }>(`/repos/${repo}/pulls/${params.number}`);
    const filePath = params.path;

    try {
      const content = execFileSync(
        "gh",
        ["api", `/repos/${repo}/contents/${filePath}?ref=${pr.head.ref}`, "--jq", ".content"],
        { encoding: "utf-8", timeout: 15000 },
      ).trim();

      const decoded = Buffer.from(content, "base64").toString("utf-8");
      json(res, { content: decoded, path: filePath });
    } catch {
      json(res, { error: "File not found" }, 404);
    }
  });

  // GET /api/state
  addRoute("GET", "/api/state", (_req, res) => {
    json(res, loadState());
  });
}
```

- [ ] **Step 3: Fix cli.ts rediscover function**

In `src/cli.ts`, update the `rediscover` function to use the new `updateRepos` export. Add the import at the top:

```typescript
import { startServer, updateRepos } from "./server.js";
```

And in the `rediscover` function, replace the `startServer.updateRepos?.(repos);` line with:

```typescript
updateRepos(repos);
```

Also remove the duplicate `startServer` import if there was one — it should just be the one line:
```typescript
import { startServer, updateRepos } from "./server.js";
```

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/api.ts src/cli.ts
git commit -m "feat: update server and API endpoints for multi-repo support"
```

---

### Task 5: Update WebUI Types and API Client (`web/src/types.ts`, `web/src/api.ts`)

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`

- [ ] **Step 1: Update web types**

In `web/src/types.ts`, add the `RepoInfo` interface and add `repo` to `PullRequest`:

Add at the top of the file:

```typescript
export interface RepoInfo {
  repo: string;
  localPath: string;
}
```

Add `repo: string;` to the `PullRequest` interface (after `draft: boolean;`):

```typescript
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  authorAvatar: string;
  branch: string;
  baseBranch: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  repo: string;
}
```

Add `repo: string;` to `PullRequestDetail` as well (it extends PullRequest so it inherits it, but the API response includes it):

```typescript
export interface PullRequestDetail extends PullRequest {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}
```

No change needed to PullRequestDetail since it extends PullRequest which now has `repo`.

- [ ] **Step 2: Update web API client**

Replace the entire contents of `web/src/api.ts` with:

```typescript
import type { User, RepoInfo, PullRequest, PullRequestDetail, PullFile, ReviewComment, CrWatchState } from "./types";

const BASE = "";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function repoQuery(repo?: string): string {
  return repo ? `?repo=${encodeURIComponent(repo)}` : "";
}

function repoQueryAmp(repo: string): string {
  return `?repo=${encodeURIComponent(repo)}`;
}

export const api = {
  getUser: () => fetchJSON<User>("/api/user"),
  getRepos: () => fetchJSON<RepoInfo[]>("/api/repos"),
  getPulls: (repo?: string) => fetchJSON<PullRequest[]>(`/api/pulls${repoQuery(repo)}`),
  getPull: (number: number, repo: string) => fetchJSON<PullRequestDetail>(`/api/pulls/${number}${repoQueryAmp(repo)}`),
  getPullFiles: (number: number, repo: string) => fetchJSON<PullFile[]>(`/api/pulls/${number}/files${repoQueryAmp(repo)}`),
  getPullComments: (number: number, repo: string) => fetchJSON<ReviewComment[]>(`/api/pulls/${number}/comments${repoQueryAmp(repo)}`),
  getFileContent: (prNumber: number, path: string, repo: string) => fetchJSON<{ content: string; path: string }>(`/api/pulls/${prNumber}/files/${path}${repoQueryAmp(repo)}`),
  getState: () => fetchJSON<CrWatchState>("/api/state"),
};
```

- [ ] **Step 3: Build web to check types**

Run: `cd web && npx tsc --noEmit`
Expected: Type errors in `App.tsx` and `PRList.tsx` because we changed the API signatures. That's expected — we'll fix those in the next task.

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat: update WebUI types and API client for multi-repo"
```

---

### Task 6: Update WebUI Components for Multi-Repo

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/PRList.tsx`
- Create: `web/src/components/RepoSelector.tsx`

- [ ] **Step 1: Create RepoSelector component**

Create `web/src/components/RepoSelector.tsx`:

```tsx
import type { RepoInfo } from "../types";

interface RepoSelectorProps {
  repos: RepoInfo[];
  selectedRepo: string | null;
  onSelectRepo: (repo: string | null) => void;
}

export default function RepoSelector({ repos, selectedRepo, onSelectRepo }: RepoSelectorProps) {
  return (
    <div className="px-4 py-2 border-b border-gray-800">
      <select
        value={selectedRepo ?? ""}
        onChange={(e) => onSelectRepo(e.target.value || null)}
        className="w-full bg-gray-800 text-gray-200 text-sm rounded px-2 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none"
      >
        <option value="">All repos ({repos.length})</option>
        {repos.map((r) => (
          <option key={r.repo} value={r.repo}>
            {r.repo}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Update PRList to show repo name**

Replace the entire contents of `web/src/components/PRList.tsx` with:

```tsx
import type { PullRequest } from "../types";

interface PRListProps {
  pulls: PullRequest[];
  selectedPR: { number: number; repo: string } | null;
  onSelectPR: (number: number, repo: string) => void;
  commentCounts: Record<string, number>;
  showRepo: boolean;
}

function prKey(pr: PullRequest): string {
  return `${pr.repo}:${pr.number}`;
}

export default function PRList({ pulls, selectedPR, onSelectPR, commentCounts, showRepo }: PRListProps) {
  if (pulls.length === 0) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        No open pull requests found.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {pulls.map((pr) => {
        const key = prKey(pr);
        const isSelected = selectedPR?.number === pr.number && selectedPR?.repo === pr.repo;
        return (
          <button
            key={key}
            onClick={() => onSelectPR(pr.number, pr.repo)}
            className={`text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors ${
              isSelected ? "bg-gray-800 border-l-2 border-l-blue-500" : ""
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-gray-500 text-xs font-mono">#{pr.number}</span>
              {(commentCounts[key] ?? 0) > 0 && (
                <span className="bg-blue-500/20 text-blue-400 text-xs px-1.5 py-0.5 rounded-full">
                  {commentCounts[key]}
                </span>
              )}
            </div>
            <div className="text-sm text-gray-200 mt-0.5 line-clamp-2">{pr.title}</div>
            <div className="text-xs text-gray-500 mt-1">
              {showRepo && <span className="text-gray-600 mr-1">{pr.repo.split("/")[1]}</span>}
              {pr.branch}
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Rewrite App.tsx for multi-repo**

Replace the entire contents of `web/src/App.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import type { PullRequest, PullRequestDetail, PullFile, ReviewComment, RepoInfo } from "./types";
import RepoSelector from "./components/RepoSelector";
import PRList from "./components/PRList";
import PRDetail from "./components/PRDetail";
import FileList from "./components/FileList";
import DiffView from "./components/DiffView";

interface SelectedPR {
  number: number;
  repo: string;
}

export default function App() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [selectedPR, setSelectedPR] = useState<SelectedPR | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [prDetail, setPrDetail] = useState<PullRequestDetail | null>(null);
  const [prFiles, setPrFiles] = useState<PullFile[]>([]);
  const [prComments, setPrComments] = useState<ReviewComment[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loadingPR, setLoadingPR] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load repos on mount
  useEffect(() => {
    api.getRepos().then(setRepos).catch(() => {});
  }, []);

  // Load pulls when selectedRepo changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const pullData = await api.getPulls(selectedRepo ?? undefined);
        if (cancelled) return;
        setPulls(pullData);

        // Fetch comment counts
        const counts: Record<string, number> = {};
        for (const pr of pullData) {
          try {
            const comments = await api.getPullComments(pr.number, pr.repo);
            counts[`${pr.repo}:${pr.number}`] = comments.length;
          } catch {
            counts[`${pr.repo}:${pr.number}`] = 0;
          }
        }
        if (cancelled) return;
        setCommentCounts(counts);

        if (pullData.length > 0 && !selectedPR) {
          setSelectedPR({ number: pullData[0].number, repo: pullData[0].repo });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [selectedRepo]);

  // Load PR detail when selectedPR changes
  useEffect(() => {
    if (!selectedPR) return;
    let cancelled = false;

    async function loadPR() {
      setLoadingPR(true);
      try {
        const [detail, files, comments] = await Promise.all([
          api.getPull(selectedPR!.number, selectedPR!.repo),
          api.getPullFiles(selectedPR!.number, selectedPR!.repo),
          api.getPullComments(selectedPR!.number, selectedPR!.repo),
        ]);
        if (cancelled) return;
        setPrDetail(detail);
        setPrFiles(files);
        setPrComments(comments);
        const fileWithComments = files.find((f) =>
          comments.some((c) => c.path === f.filename)
        );
        setSelectedFile(fileWithComments?.filename ?? files[0]?.filename ?? null);
      } catch (err) {
        console.error("Failed to load PR:", err);
      } finally {
        if (!cancelled) setLoadingPR(false);
      }
    }
    loadPR();
    return () => { cancelled = true; };
  }, [selectedPR?.number, selectedPR?.repo]);

  function handleSelectPR(number: number, repo: string) {
    setSelectedPR({ number, repo });
  }

  function handleSelectRepo(repo: string | null) {
    setSelectedRepo(repo);
    setSelectedPR(null);
    setPrDetail(null);
    setPrFiles([]);
    setPrComments([]);
    setSelectedFile(null);
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Loading pull requests...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-red-400">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-gray-950 text-gray-200">
      {/* Sidebar */}
      <div className="w-72 border-r border-gray-800 flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-gray-800">
          <h1 className="text-sm font-semibold text-white">cr-watch</h1>
        </div>
        <RepoSelector
          repos={repos}
          selectedRepo={selectedRepo}
          onSelectRepo={handleSelectRepo}
        />
        <div className="overflow-y-auto flex-1">
          <PRList
            pulls={pulls}
            selectedPR={selectedPR}
            onSelectPR={handleSelectPR}
            commentCounts={commentCounts}
            showRepo={!selectedRepo}
          />
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {loadingPR ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Loading...
          </div>
        ) : prDetail ? (
          <>
            <PRDetail pr={prDetail} />
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
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Select a pull request
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build everything and verify**

```bash
npm run build:all
```

Expected: Both TypeScript CLI and Vite web build succeed.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/RepoSelector.tsx web/src/components/PRList.tsx web/src/App.tsx
git commit -m "feat: update WebUI for multi-repo with repo selector and per-repo PR list"
```
