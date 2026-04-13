# cr-watch WebUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a React-based WebUI to cr-watch that shows open PRs, their diffs with syntax highlighting, and inline review comments.

**Architecture:** The CLI gains an HTTP API server using Node's built-in `http` module. A Vite + React + TypeScript + Tailwind app in `web/` consumes the API. In production the CLI serves `web/dist/` as static files; in dev, Vite proxies `/api/*` to the CLI.

**Tech Stack:** Node `http` module, React 18, TypeScript, Vite, Tailwind CSS v4, highlight.js

---

### Task 1: API Server Foundation (`src/server.ts`)

**Files:**
- Create: `src/server.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create the HTTP server module**

Create `src/server.ts` with a minimal HTTP server that routes requests and serves JSON:

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>;

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

export function startServer(port: number): void {
  const webDist = join(__dirname, "..", "web", "dist");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;

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
        await route.handler(req, res, params);
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

- [ ] **Step 2: Wire the server into the CLI**

In `src/cli.ts`, add the `--port` flag and start the server. Add to the `parseArgs` options:

```typescript
port: { type: "string", default: "3100" },
```

Add imports at the top of `src/cli.ts`:

```typescript
import { startServer } from "./server.js";
```

Add after the "cr-watch started" console.log block (after line 62):

```typescript
startServer(parseInt(flags.port!, 10));
```

- [ ] **Step 3: Build and verify the server starts**

Run: `npm run build && node dist/cli.js --repo owner/repo --port 3100`
Expected: See "WebUI: http://localhost:3100" in output, and `curl http://localhost:3100/api/user` returns a 404 or empty response (no routes registered yet).

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/cli.ts
git commit -m "feat: add HTTP API server foundation for WebUI"
```

---

### Task 2: API Endpoints (`src/api.ts`)

**Files:**
- Create: `src/api.ts`
- Modify: `src/server.ts` (import and call `registerRoutes`)

- [ ] **Step 1: Create the API routes module**

Create `src/api.ts` that registers all API endpoints using `gh` CLI calls:

```typescript
import { execFileSync } from "child_process";
import { addRoute, json } from "./server.js";
import { loadState } from "./state.js";
import type { ServerResponse } from "http";

let repoPath = "";

function gh<T>(endpoint: string): T {
  const result = execFileSync("gh", ["api", endpoint, "--paginate"], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return JSON.parse(result) as T;
}

function ghGraphQL<T>(query: string, variables: Record<string, unknown>): T {
  const payload = JSON.stringify({ query, variables });
  const result = execFileSync("gh", ["api", "graphql", "--input", "-"], {
    encoding: "utf-8",
    timeout: 30000,
    input: payload,
  });
  return JSON.parse(result) as T;
}

export function registerRoutes(repo: string): void {
  repoPath = repo;

  // GET /api/user
  addRoute("GET", "/api/user", (_req, res) => {
    const result = execFileSync("gh", ["api", "/user"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const user = JSON.parse(result) as { login: string; avatar_url: string; html_url: string };
    json(res, { login: user.login, avatarUrl: user.avatar_url, url: user.html_url });
  });

  // GET /api/pulls
  addRoute("GET", "/api/pulls", (_req, res) => {
    const username = execFileSync("gh", ["api", "/user", "--jq", ".login"], {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

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

    const pulls = gh<GhPull[]>(`/repos/${repoPath}/pulls?state=open`);
    const myPulls = pulls.filter((pr) => pr.user.login === username);

    const result = myPulls.map((pr) => ({
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
    }));

    json(res, result);
  });

  // GET /api/pulls/:number
  addRoute("GET", "/api/pulls/:number", (_req, res, params) => {
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
    }>(`/repos/${repoPath}/pulls/${params.number}`);

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
    });
  });

  // GET /api/pulls/:number/files
  addRoute("GET", "/api/pulls/:number/files", (_req, res, params) => {
    interface GhFile {
      sha: string;
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }

    const files = gh<GhFile[]>(`/repos/${repoPath}/pulls/${params.number}/files`);

    json(res, files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || "",
    })));
  });

  // GET /api/pulls/:number/comments
  addRoute("GET", "/api/pulls/:number/comments", (_req, res, params) => {
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

    const comments = gh<GhComment[]>(`/repos/${repoPath}/pulls/${params.number}/comments`);

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

  // GET /api/pulls/:number/files/*path (full file content)
  addRoute("GET", "/api/pulls/:number/files/*path", (_req, res, params) => {
    const pr = gh<{ head: { ref: string } }>(`/repos/${repoPath}/pulls/${params.number}`);
    const filePath = params.path;

    try {
      const content = execFileSync(
        "gh",
        ["api", `/repos/${repoPath}/contents/${filePath}?ref=${pr.head.ref}`, "--jq", ".content"],
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

- [ ] **Step 2: Register routes in server.ts**

Add to the top of `src/server.ts` after the existing imports:

```typescript
import { registerRoutes } from "./api.js";
```

Update `startServer` to accept `repo` and call `registerRoutes`:

```typescript
export function startServer(port: number, repo: string): void {
  registerRoutes(repo);
  // ... rest of the function stays the same
```

- [ ] **Step 3: Update CLI to pass repo to startServer**

In `src/cli.ts`, change the `startServer` call:

```typescript
startServer(parseInt(flags.port!, 10), repoPath);
```

- [ ] **Step 4: Build and test an endpoint**

Run: `npm run build && node dist/cli.js --port 3100`
In another terminal: `curl -s http://localhost:3100/api/user | jq .`
Expected: JSON with `login` and `avatarUrl` fields for the authenticated GitHub user.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/server.ts src/cli.ts
git commit -m "feat: add API endpoints for pulls, files, comments, and state"
```

---

### Task 3: Scaffold the React App (`web/`)

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/index.css`
- Create: `web/src/vite-env.d.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "cr-watch-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "highlight.js": "^11.11.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.2",
    "@types/react-dom": "^19.1.2",
    "@vitejs/plugin-react": "^4.4.1",
    "typescript": "^5.8.0",
    "vite": "^6.3.2",
    "tailwindcss": "^4.1.4",
    "@tailwindcss/vite": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3100",
    },
  },
  build: {
    outDir: "dist",
  },
});
```

- [ ] **Step 4: Create `web/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>cr-watch</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 5: Create `web/src/vite-env.d.ts`**

```typescript
/// <reference types="vite/client" />
```

- [ ] **Step 6: Create `web/src/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 7: Create `web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Create `web/src/App.tsx`**

```tsx
export default function App() {
  return (
    <div className="h-screen flex items-center justify-center bg-gray-950 text-white">
      <h1 className="text-2xl font-bold">cr-watch</h1>
    </div>
  );
}
```

- [ ] **Step 9: Update `.gitignore`**

Add these lines to the project's `.gitignore`:

```
web/node_modules
web/dist
```

- [ ] **Step 10: Install dependencies and verify**

```bash
cd web && npm install && npm run dev
```

Expected: Vite dev server starts on http://localhost:5173 showing "cr-watch" centered on a dark background.

- [ ] **Step 11: Commit**

```bash
git add web/ .gitignore
git commit -m "feat: scaffold React app with Vite, Tailwind, and TypeScript"
```

---

### Task 4: API Client and Types (`web/src/api.ts`, `web/src/types.ts`)

**Files:**
- Create: `web/src/types.ts`
- Create: `web/src/api.ts`

- [ ] **Step 1: Create `web/src/types.ts`**

```typescript
export interface User {
  login: string;
  avatarUrl: string;
  url: string;
}

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
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

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
}

export interface CrWatchState {
  lastPoll: string | null;
  comments: Record<string, {
    status: "seen" | "replied" | "fixed" | "skipped";
    prNumber: number;
    timestamp: string;
  }>;
}
```

- [ ] **Step 2: Create `web/src/api.ts`**

```typescript
import type { User, PullRequest, PullRequestDetail, PullFile, ReviewComment, CrWatchState } from "./types";

const BASE = "";

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getUser: () => fetchJSON<User>("/api/user"),
  getPulls: () => fetchJSON<PullRequest[]>("/api/pulls"),
  getPull: (number: number) => fetchJSON<PullRequestDetail>(`/api/pulls/${number}`),
  getPullFiles: (number: number) => fetchJSON<PullFile[]>(`/api/pulls/${number}/files`),
  getPullComments: (number: number) => fetchJSON<ReviewComment[]>(`/api/pulls/${number}/comments`),
  getFileContent: (prNumber: number, path: string) => fetchJSON<{ content: string; path: string }>(`/api/pulls/${prNumber}/files/${path}`),
  getState: () => fetchJSON<CrWatchState>("/api/state"),
};
```

- [ ] **Step 3: Commit**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat: add API client and TypeScript types for WebUI"
```

---

### Task 5: PR List Sidebar (`web/src/components/PRList.tsx`)

**Files:**
- Create: `web/src/components/PRList.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create `web/src/components/PRList.tsx`**

```tsx
import type { PullRequest, ReviewComment } from "../types";

interface PRListProps {
  pulls: PullRequest[];
  selectedPR: number | null;
  onSelectPR: (number: number) => void;
  commentCounts: Record<number, number>;
}

export default function PRList({ pulls, selectedPR, onSelectPR, commentCounts }: PRListProps) {
  if (pulls.length === 0) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        No open pull requests found.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {pulls.map((pr) => (
        <button
          key={pr.number}
          onClick={() => onSelectPR(pr.number)}
          className={`text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800/50 transition-colors ${
            selectedPR === pr.number ? "bg-gray-800 border-l-2 border-l-blue-500" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="text-gray-500 text-xs font-mono">#{pr.number}</span>
            {(commentCounts[pr.number] ?? 0) > 0 && (
              <span className="bg-blue-500/20 text-blue-400 text-xs px-1.5 py-0.5 rounded-full">
                {commentCounts[pr.number]}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-200 mt-0.5 line-clamp-2">{pr.title}</div>
          <div className="text-xs text-gray-500 mt-1">{pr.branch}</div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Update `web/src/App.tsx` to use PRList**

```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import type { PullRequest } from "./types";
import PRList from "./components/PRList";

export default function App() {
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [selectedPR, setSelectedPR] = useState<number | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const pullData = await api.getPulls();
        setPulls(pullData);

        // Fetch comment counts for each PR
        const counts: Record<number, number> = {};
        for (const pr of pullData) {
          try {
            const comments = await api.getPullComments(pr.number);
            counts[pr.number] = comments.length;
          } catch {
            counts[pr.number] = 0;
          }
        }
        setCommentCounts(counts);

        if (pullData.length > 0 && !selectedPR) {
          setSelectedPR(pullData[0].number);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

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
        <div className="overflow-y-auto flex-1">
          <PRList
            pulls={pulls}
            selectedPR={selectedPR}
            onSelectPR={setSelectedPR}
            commentCounts={commentCounts}
          />
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex items-center justify-center text-gray-500">
        {selectedPR ? `PR #${selectedPR} selected` : "Select a pull request"}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify sidebar renders**

Start both the CLI (`npm run build && npm start`) and the Vite dev server (`cd web && npm run dev`).
Open http://localhost:5173 — should see the sidebar with your open PRs listed.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/PRList.tsx web/src/App.tsx
git commit -m "feat: add PR list sidebar component"
```

---

### Task 6: PR Detail Header (`web/src/components/PRDetail.tsx`)

**Files:**
- Create: `web/src/components/PRDetail.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create `web/src/components/PRDetail.tsx`**

```tsx
import type { PullRequestDetail } from "../types";

interface PRDetailProps {
  pr: PullRequestDetail;
}

export default function PRDetail({ pr }: PRDetailProps) {
  return (
    <div className="px-6 py-4 border-b border-gray-800">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {pr.title}
            <span className="text-gray-500 font-normal ml-2">#{pr.number}</span>
          </h2>
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
            <span className="font-mono text-xs bg-gray-800 px-2 py-0.5 rounded">
              {pr.branch} &larr; {pr.baseBranch}
            </span>
            <span className="text-green-400">+{pr.additions}</span>
            <span className="text-red-400">-{pr.deletions}</span>
            <span>{pr.changedFiles} files</span>
          </div>
        </div>
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-400 hover:text-blue-300"
        >
          View on GitHub &rarr;
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx to load and show PR detail**

Add imports and state to `App.tsx`:

```tsx
import type { PullRequest, PullRequestDetail, PullFile, ReviewComment } from "./types";
import PRDetail from "./components/PRDetail";
```

Add state variables inside the `App` function:

```typescript
const [prDetail, setPrDetail] = useState<PullRequestDetail | null>(null);
const [prFiles, setPrFiles] = useState<PullFile[]>([]);
const [prComments, setPrComments] = useState<ReviewComment[]>([]);
const [loadingPR, setLoadingPR] = useState(false);
```

Add a `useEffect` that loads PR data when `selectedPR` changes:

```typescript
useEffect(() => {
  if (!selectedPR) return;
  let cancelled = false;

  async function loadPR() {
    setLoadingPR(true);
    try {
      const [detail, files, comments] = await Promise.all([
        api.getPull(selectedPR!),
        api.getPullFiles(selectedPR!),
        api.getPullComments(selectedPR!),
      ]);
      if (cancelled) return;
      setPrDetail(detail);
      setPrFiles(files);
      setPrComments(comments);
    } catch (err) {
      console.error("Failed to load PR:", err);
    } finally {
      if (!cancelled) setLoadingPR(false);
    }
  }
  loadPR();
  return () => { cancelled = true; };
}, [selectedPR]);
```

Replace the main area placeholder with:

```tsx
{/* Main area */}
<div className="flex-1 flex flex-col overflow-hidden">
  {loadingPR ? (
    <div className="flex-1 flex items-center justify-center text-gray-500">
      Loading...
    </div>
  ) : prDetail ? (
    <>
      <PRDetail pr={prDetail} />
      <div className="flex-1 overflow-y-auto p-6 text-gray-500">
        {prFiles.length} file(s), {prComments.length} comment(s)
      </div>
    </>
  ) : (
    <div className="flex-1 flex items-center justify-center text-gray-500">
      Select a pull request
    </div>
  )}
</div>
```

- [ ] **Step 3: Verify the PR detail header shows**

Reload http://localhost:5173, click a PR — header shows title, branch, additions/deletions, GitHub link.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/PRDetail.tsx web/src/App.tsx
git commit -m "feat: add PR detail header component"
```

---

### Task 7: File List (`web/src/components/FileList.tsx`)

**Files:**
- Create: `web/src/components/FileList.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create `web/src/components/FileList.tsx`**

```tsx
import type { PullFile, ReviewComment } from "../types";

interface FileListProps {
  files: PullFile[];
  selectedFile: string | null;
  onSelectFile: (filename: string) => void;
  comments: ReviewComment[];
}

export default function FileList({ files, selectedFile, onSelectFile, comments }: FileListProps) {
  // Count comments per file
  const commentsByFile: Record<string, number> = {};
  for (const c of comments) {
    commentsByFile[c.path] = (commentsByFile[c.path] || 0) + 1;
  }

  return (
    <div className="border-b border-gray-800">
      <div className="px-6 py-2 text-xs text-gray-500 uppercase tracking-wide">
        Files changed ({files.length})
      </div>
      <div className="max-h-48 overflow-y-auto">
        {files.map((file) => (
          <button
            key={file.filename}
            onClick={() => onSelectFile(file.filename)}
            className={`w-full text-left px-6 py-1.5 text-sm hover:bg-gray-800/50 flex items-center justify-between ${
              selectedFile === file.filename ? "bg-gray-800/70 text-white" : "text-gray-300"
            }`}
          >
            <span className="font-mono text-xs truncate">{file.filename}</span>
            <span className="flex items-center gap-2 shrink-0 ml-2">
              {(commentsByFile[file.filename] ?? 0) > 0 && (
                <span className="text-xs text-yellow-400">
                  {commentsByFile[file.filename]} 💬
                </span>
              )}
              <span className="text-green-400 text-xs">+{file.additions}</span>
              <span className="text-red-400 text-xs">-{file.deletions}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx to add file selection state and FileList**

Add import:

```tsx
import FileList from "./components/FileList";
```

Add state:

```typescript
const [selectedFile, setSelectedFile] = useState<string | null>(null);
```

Reset `selectedFile` when PR changes — add to the `loadPR` function after setting `setPrFiles`:

```typescript
setSelectedFile(null);
```

Replace the placeholder below `<PRDetail>`:

```tsx
<FileList
  files={prFiles}
  selectedFile={selectedFile}
  onSelectFile={setSelectedFile}
  comments={prComments}
/>
<div className="flex-1 overflow-y-auto p-6">
  {selectedFile ? (
    <div className="text-gray-500">Diff view for {selectedFile}</div>
  ) : (
    <div className="text-gray-500 text-center mt-12">Select a file to view its diff</div>
  )}
</div>
```

- [ ] **Step 3: Verify file list renders and selection works**

Reload, click a PR — file list appears. Clicking a file highlights it.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/FileList.tsx web/src/App.tsx
git commit -m "feat: add file list component with comment counts"
```

---

### Task 8: Diff View with Syntax Highlighting (`web/src/components/DiffView.tsx`)

**Files:**
- Create: `web/src/components/DiffView.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create `web/src/components/DiffView.tsx`**

```tsx
import { useEffect, useRef } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.min.css";
import type { ReviewComment } from "../types";
import Comment from "./Comment";

interface DiffViewProps {
  patch: string;
  filename: string;
  comments: ReviewComment[];
}

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

function parsePatch(patch: string): DiffLine[] {
  const lines = patch.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: "header", content: line, oldLine: null, newLine: null });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), oldLine: null, newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "remove", content: line.slice(1), oldLine, newLine: null });
      oldLine++;
    } else {
      result.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", sh: "bash", sql: "sql", swift: "swift", kt: "kotlin",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  };
  return ext ? map[ext] : undefined;
}

export default function DiffView({ patch, filename, comments }: DiffViewProps) {
  const codeRef = useRef<HTMLTableElement>(null);
  const diffLines = parsePatch(patch);
  const language = getLanguage(filename);

  // Group comments by line number (new line for context/add, original for remove)
  const commentsByLine: Record<number, ReviewComment[]> = {};
  for (const c of comments) {
    if (!commentsByLine[c.line]) commentsByLine[c.line] = [];
    commentsByLine[c.line].push(c);
  }

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.querySelectorAll("code[data-highlight]").forEach((el) => {
        hljs.highlightElement(el as HTMLElement);
      });
    }
  }, [patch, filename]);

  if (!patch) {
    return <div className="text-gray-500 text-sm p-4">No diff available for this file.</div>;
  }

  return (
    <div className="font-mono text-xs">
      <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-4 py-2 text-sm text-gray-300">
        {filename}
      </div>
      <table ref={codeRef} className="w-full border-collapse">
        <tbody>
          {diffLines.map((line, i) => {
            if (line.type === "header") {
              return (
                <tr key={i} className="bg-blue-500/10">
                  <td colSpan={3} className="px-4 py-1 text-blue-400 select-none">
                    {line.content}
                  </td>
                </tr>
              );
            }

            const bgClass =
              line.type === "add"
                ? "bg-green-500/10"
                : line.type === "remove"
                  ? "bg-red-500/10"
                  : "";

            const textClass =
              line.type === "add"
                ? "text-green-300"
                : line.type === "remove"
                  ? "text-red-300"
                  : "text-gray-300";

            const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

            const lineNum = line.newLine ?? line.oldLine ?? 0;
            const lineComments = lineNum ? commentsByLine[lineNum] || [] : [];

            return (
              <>
                <tr key={i} className={bgClass}>
                  <td className="w-12 text-right pr-2 text-gray-600 select-none align-top">
                    {line.oldLine ?? ""}
                  </td>
                  <td className="w-12 text-right pr-2 text-gray-600 select-none align-top">
                    {line.newLine ?? ""}
                  </td>
                  <td className={`pl-4 pr-4 whitespace-pre ${textClass}`}>
                    <span className="select-none text-gray-600 mr-2">{prefix}</span>
                    <code
                      data-highlight
                      className={language ? `language-${language}` : ""}
                    >
                      {line.content}
                    </code>
                  </td>
                </tr>
                {lineComments.map((comment) => (
                  <tr key={`comment-${comment.id}`}>
                    <td colSpan={3} className="px-4 py-0">
                      <Comment comment={comment} />
                    </td>
                  </tr>
                ))}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx to render DiffView**

Add import:

```tsx
import DiffView from "./components/DiffView";
```

Replace the diff placeholder in the main area:

```tsx
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
```

- [ ] **Step 3: Verify diff view with syntax highlighting**

Reload, click a PR, click a file — diff shows with green/red highlighting, line numbers, and syntax highlighting.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/DiffView.tsx web/src/App.tsx
git commit -m "feat: add diff view with syntax highlighting and line numbers"
```

---

### Task 9: Inline Comments (`web/src/components/Comment.tsx`)

**Files:**
- Create: `web/src/components/Comment.tsx`

- [ ] **Step 1: Create `web/src/components/Comment.tsx`**

```tsx
import type { ReviewComment } from "../types";

interface CommentProps {
  comment: ReviewComment;
}

export default function Comment({ comment }: CommentProps) {
  const isBot = comment.author.includes("[bot]");
  const timeAgo = getTimeAgo(comment.createdAt);

  return (
    <div className="my-2 ml-8 border border-gray-700 rounded-lg bg-gray-900/80 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/50 text-xs">
        <img
          src={comment.authorAvatar}
          alt={comment.author}
          className="w-4 h-4 rounded-full"
        />
        <span className={`font-medium ${isBot ? "text-purple-400" : "text-gray-300"}`}>
          {comment.author}
        </span>
        <span className="text-gray-500">{timeAgo}</span>
      </div>
      <div className="px-3 py-2 text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
        {comment.body}
      </div>
    </div>
  );
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHrs / 24);

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHrs > 0) return `${diffHrs}h ago`;
  if (diffMin > 0) return `${diffMin}m ago`;
  return "just now";
}
```

- [ ] **Step 2: Verify comments appear inline in the diff**

Reload, select a PR with CodeRabbit comments — comments should appear at their corresponding lines in the diff.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Comment.tsx
git commit -m "feat: add inline comment component with author info"
```

---

### Task 10: Build Integration and Final Wiring

**Files:**
- Modify: `package.json` (root)
- Modify: `web/src/App.tsx` (auto-select first file with comments)

- [ ] **Step 1: Add build scripts to root `package.json`**

Add to the `scripts` section of the root `package.json`:

```json
"build:web": "cd web && npm run build",
"dev:web": "cd web && npm run dev",
"build:all": "npm run build && npm run build:web"
```

- [ ] **Step 2: Auto-select first file with comments when loading a PR**

In `web/src/App.tsx`, update the PR loading effect. After setting `setPrFiles(files)` and `setPrComments(comments)`, add logic to auto-select:

```typescript
// Auto-select first file with comments, or first file
const fileWithComments = files.find((f) =>
  comments.some((c) => c.path === f.filename)
);
setSelectedFile(fileWithComments?.filename ?? files[0]?.filename ?? null);
```

Remove the previous `setSelectedFile(null)` line.

- [ ] **Step 3: Build everything and test production mode**

```bash
npm run build:all
node dist/cli.js --port 3100
```

Open http://localhost:3100 — should serve the full React app from the CLI server, with working API calls.

- [ ] **Step 4: Commit**

```bash
git add package.json web/src/App.tsx
git commit -m "feat: add build scripts and auto-select first file with comments"
```
