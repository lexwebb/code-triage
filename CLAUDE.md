# CLAUDE.md

## Project Overview

Code Triage is a PR review dashboard that monitors GitHub pull requests, analyzes review comments with Claude, and lets users act on them from a web UI. It consists of a Node.js CLI backend and a React frontend.

## Documentation (`docs/`)

Longer explanations live under [`docs/`](./docs/README.md). Use them when you need more than this file’s summary:

| Document | When to read it |
|----------|-----------------|
| [`docs/architecture.md`](./docs/architecture.md) | System diagram, data flow, how CLI / poller / API / web fit together, GitHub vs Claude boundaries |
| [`docs/features-and-rationale.md`](./docs/features-and-rationale.md) | What a feature does and *why* (e.g. authored PRs vs review-requested list, worktrees, bot filtering) |
| [`docs/http-api.md`](./docs/http-api.md) | Adding or changing REST routes, request/response shapes, error codes |
| [`docs/config-and-state.md`](./docs/config-and-state.md) | `config.json` / `state.json`, comment keys, fix jobs, `.cr-worktrees/` behavior |

[`docs/README.md`](./docs/README.md) is the index. [`docs/superpowers/`](./docs/superpowers/) holds dated design notes; prefer the guides above for current behavior.

## Architecture

- **CLI Backend** (`src/`): TypeScript, ESM modules, Node16 module resolution. Uses `ink` for terminal UI. Runs an HTTP API server on port 3100.
- **Web Frontend** (`web/`): React 19, TypeScript, Vite, Tailwind CSS v4. Yarn workspace (`code-triage-web`).
- **GitHub API**: Direct `fetch` calls using a token from `gh auth token`. No `gh` CLI for API calls (too slow).
- **Claude CLI**: Used for comment evaluation (`claude -p`) and code fixes (`claude -p --dangerously-skip-permissions`).
- **State**: Persisted to `~/.code-triage/state.json`. Config at `~/.code-triage/config.json`.

## Build & Run

```bash
yarn install              # Install all dependencies (workspaces)
yarn build:all            # Build CLI + web
yarn start                # Run (or: node dist/cli.js)
```

Development:
```bash
yarn dev                  # Runs tsc watch + CLI auto-restart + Vite HMR concurrently
```

## Key Files

- `src/cli.ts` — Entry point, flag parsing, poll loop, hotkeys
- `src/api.ts` — HTTP API route handlers (all async, non-blocking)
- `src/server.ts` — HTTP server, static file serving, route dispatch
- `src/actioner.ts` — Claude evaluation and fix application
- `src/poller.ts` — GitHub polling for new comments
- `src/discovery.ts` — Scans directories for GitHub repos
- `src/exec.ts` — Async GitHub API helpers (`ghAsync`, `ghGraphQL`, `ghPost`)
- `src/state.ts` — State persistence with repo-prefixed comment keys
- `src/config.ts` — User config (root dir, port, interval)
- `src/worktree.ts` — Git worktree management for fixes
- `src/terminal.tsx` — Ink-based terminal UI
- `web/src/App.tsx` — Main React app with routing, polling, state management
- `web/src/components/CommentThreads.tsx` — Review thread display with action buttons
- `web/src/components/FixJobsBanner.tsx` — Fix job status banner with detail modal

## Code Conventions

- ESM modules — imports end with `.js` extension (even for `.ts` files)
- TSX for ink components (`terminal.tsx`), TS for everything else
- Zero runtime dependencies for the CLI except `ink` and `react`
- All GitHub API calls go through `src/exec.ts` helpers (never `execFileSync` for API calls)
- Route handlers in `api.ts` are all `async` to avoid blocking the event loop
- State comment keys are prefixed with repo: `owner/repo:commentId`
- Web frontend uses `sessionStorage` for caching, polls backend for status
- Tailwind CSS v4 with `@tailwindcss/vite` plugin (no postcss config needed)

## Testing

No test suite yet. To verify changes:
```bash
yarn build:all            # Must compile cleanly
yarn start                # Smoke test — should discover repos and start server
```

## Common Tasks

- **Adding an API endpoint**: Add route in `src/api.ts` inside `registerRoutes()`. Use `ghAsync`/`ghPost` for GitHub calls. All handlers must be `async`.
- **Adding a web component**: Create in `web/src/components/`. Import in `App.tsx`.
- **Adding a CLI flag**: Add to `parseArgs` options in `src/cli.ts`. Override config values below.
- **Modifying state shape**: Update `src/types.ts`, then `src/state.ts` helpers.
