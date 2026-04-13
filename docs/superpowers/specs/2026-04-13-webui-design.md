# cr-watch WebUI Design Spec

## Overview

Add a web-based UI to cr-watch that lets users view and interact with CodeRabbit review comments in a browser instead of (or alongside) the terminal. The CLI starts an HTTP API server that the React frontend consumes.

## Architecture

### Launch Flow

1. `cr-watch` starts its normal polling loop
2. Also starts an HTTP server on port 3100 (configurable via `--port`)
3. Prints "WebUI available at http://localhost:3100"
4. In production, the HTTP server serves the built React app as static files from `web/dist/`
5. In development, Vite dev server runs separately and proxies `/api/*` to the CLI server

### API Server (`src/server.ts`)

Uses Node's built-in `http` module (no new runtime dependencies). All GitHub data fetched via `gh` CLI, consistent with existing approach.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/user` | Current GitHub user login and avatar |
| GET | `/api/pulls` | Open PRs assigned to current user |
| GET | `/api/pulls/:number` | Single PR detail (title, branch, description, stats) |
| GET | `/api/pulls/:number/files` | Changed files with patch/diff content |
| GET | `/api/pulls/:number/files/*path` | Full file content for syntax highlighting |
| GET | `/api/pulls/:number/comments` | All review comments, grouped by file and line |
| GET | `/api/state` | cr-watch state (comment statuses) |

All endpoints return JSON. Errors return `{ error: string }` with appropriate HTTP status codes.

### React App (`web/`)

Separate package with its own `package.json`. Not a dependency of the CLI package.

**Tech stack:**
- Vite (build tool and dev server)
- React 18 + TypeScript
- Tailwind CSS v4
- highlight.js for syntax highlighting (lightweight, broad language support)

**File structure:**

```
web/
├── package.json
├── vite.config.ts
├── index.html
├── postcss.config.js
├── src/
│   ├── main.tsx           # React entry point
│   ├── App.tsx            # Root component, routing/state
│   ├── api.ts             # Fetch wrappers for /api/* endpoints
│   ├── types.ts           # Shared TypeScript types (mirroring CLI types)
│   ├── components/
│   │   ├── PRList.tsx     # Left sidebar - list of open PRs
│   │   ├── PRDetail.tsx   # Right panel - PR header and metadata
│   │   ├── FileList.tsx   # List of changed files in a PR
│   │   ├── DiffView.tsx   # Diff display with syntax highlighting
│   │   └── Comment.tsx    # Inline review comment display
│   └── index.css          # Tailwind imports
```

## UI Layout

### Two-Panel Design

```
+------------------+----------------------------------------------+
| PR List          | PR Detail                                    |
| (sidebar ~300px) | (main area, flex-1)                          |
|                  |                                              |
| #42 Fix auth     | PR #42: Fix auth middleware                  |
|   3 comments  >  | branch: fix/auth  ← main                    |
|                  |                                              |
| #38 Add search   | Files Changed (3)                            |
|   1 comment      | ├── src/auth.ts (+15, -3)                    |
|                  | ├── src/middleware.ts (+8, -2)               |
| #35 Refactor DB  | └── tests/auth.test.ts (+22)                 |
|   0 comments     |                                              |
|                  | [src/auth.ts - diff view]                    |
|                  | ┌─────────────────────────────────────────┐  |
|                  | │  15 | + if (token.expired) {             │  |
|                  | │  16 | +   return refreshToken(token);    │  |
|                  | │     │                                    │  |
|                  | │  💬 coderabbitai[bot]:                   │  |
|                  | │  "Consider adding a max retry limit..." │  |
|                  | │  Status: replied ✓                      │  |
|                  | │                                          │  |
|                  | │  17 | + }                                │  |
|                  | └─────────────────────────────────────────┘  |
+------------------+----------------------------------------------+
```

### Left Sidebar (PRList)

- Lists open PRs assigned to the authenticated GitHub user
- Each item shows: PR number, title, comment count badge
- Selected PR is visually highlighted
- Clicking a PR loads it in the main area

### Right Panel (PRDetail)

- **Header**: PR title, number, branch info, link to GitHub
- **File list**: Changed files with additions/deletions counts
- **Diff view**: Clicking a file shows its diff
  - Unified diff format
  - Syntax highlighting via highlight.js
  - Line numbers
  - Added/removed lines colored green/red
- **Inline comments**: Rendered at the line they reference
  - Shows author avatar, username, timestamp
  - Comment body rendered as markdown (or plain text initially)
  - cr-watch status badge (replied/fixed/skipped/seen)

## Data Flow

```
User opens browser → React app loads
  → GET /api/user (show current user)
  → GET /api/pulls (populate sidebar)
  → User clicks PR
    → GET /api/pulls/:number (PR detail)
    → GET /api/pulls/:number/files (file list with patches)
    → GET /api/pulls/:number/comments (review comments)
    → User clicks file
      → Display diff from already-fetched patch data
      → Overlay comments at their line positions
```

## Dev vs Prod

### Development
```bash
# Terminal 1: Start CLI with API server
cr-watch --repo owner/repo

# Terminal 2: Start Vite dev server
cd web && npm run dev
```

Vite proxies `/api/*` to `http://localhost:3100`.

### Production
```bash
# Build the web app
cd web && npm run build

# CLI serves web/dist/ as static files on the same port as the API
cr-watch --repo owner/repo
```

The CLI detects if `web/dist/` exists and serves it. If not, it just runs the API without static file serving.

## Non-Goals (for now)

- No WebSocket/SSE live updates (polling from the UI is fine for v1)
- No ability to trigger actions (reply/fix/resolve) from the UI — read-only view
- No authentication on the API server (localhost only)
- No markdown rendering for comments (plain text is fine for v1)
- No file tree hierarchy (flat file list is fine for v1)

## Future Considerations

- Add action buttons (resolve, reply) in the UI
- WebSocket for real-time comment updates
- Dark/light theme toggle
- Markdown rendering for comment bodies
- File tree with folder grouping
