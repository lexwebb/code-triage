# HTTP API

The CLI embeds an HTTP server (default port **3100**, configurable). All routes return JSON unless static files are served. `POST` bodies are JSON with `Content-Type: application/json`.

**Repo scoping:** Most PR-scoped routes require `?repo=owner/name`. The repo must be in the server’s tracked list (`GET /api/repos`).

## Read-only

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/user` | Authenticated GitHub user (`login`, `avatarUrl`, `url`). |
| `GET` | `/api/repos` | Tracked repos with `repo` and `localPath` from discovery / CLI. |
| `GET` | `/api/pulls` | Open PRs **you authored** across tracked repos; includes checks, open comment count, human approval flag. Optional `?repo=`. |
| `GET` | `/api/pulls/review-requested` | Open PRs where **you** are in `requested_reviewers` and you are **not** the author. Optional `?repo=`. |
| `GET` | `/api/pulls/:number` | PR detail + reviewer map with states. Requires `?repo=`. |
| `GET` | `/api/pulls/:number/files` | List of changed files with patches. Requires `?repo=`. |
| `GET` | `/api/pulls/:number/comments` | Review comments with `isResolved`, merged `evaluation` and `crStatus` from `state.json`. Requires `?repo=`. |
| `GET` | `/api/pulls/:number/files/*path` | File content at `path` on the PR head ref. Requires `?repo=`. |
| `GET` | `/api/state` | Full `CrWatchState` (comments map, fix job records, `lastPoll`). |
| `GET` | `/api/health` | Readiness snapshot: `status`, `uptimeMs`, `repos`, poll timers, `lastPollError` (if the last full poll run failed), GitHub rate-limit hint, `fixJobsRunning`, and `persistedLastPoll` (ISO from SQLite). Does **not** consume the one-shot test-notification flag (unlike `/api/poll-status`). |
| `GET` | `/api/events` | **Server-Sent Events** (`text/event-stream`). Emits `poll` after each poll cycle (`{ ok, at, error? }`) and `fix-job` when fix-job status updates (`commentId`, `repo`, `prNumber`, `status`, …). Browser reconnects automatically on disconnect. |
| `GET` | `/api/poll-status` | Server poll timer state, in-memory fix-job statuses, test-notification flag, rate-limit hint. |
| `GET` | `/api/version` | Short SHAs and “commits behind `origin/main`” (best-effort; cached ~10 min). |
| `GET` | `/api/reviews/companion/session` | PR assistant chat transcript for a PR. Query: `repo` (`owner/name`), `prNumber`. Returns `messages` (`role` `user` \| `assistant`, `content`), `bundleThreadCount`, `bundleUpdatedAtMs`. |
| `GET` | `/api/fix-jobs/recover` | Lists persisted fix jobs from state; includes whether a worktree diff exists; prunes dead entries. |
| `GET` | `/api/config` | Settings for the web UI and `config.json`. Returns `config` (same fields as on disk, but **account tokens are never sent**—each account has `hasToken` instead; default PAT is indicated by **`hasGithubToken`** only), `needsSetup` (`true` when `~/.code-triage/config.json` does not exist yet), and `listenPort` (the port the server process is actually bound to). |

## Config (`POST`)

| Path | Body (summary) | Response | Purpose |
|------|----------------|----------|---------|
| `/api/config` | Full or partial [`config.json`](./config-and-state.md) shape: `root`, `port`, `interval`, `evalConcurrency`, `pollReviewRequested`, `commentRetentionDays`, `ignoredBots`, `githubToken`, `accounts[]` (`name`, `orgs`, optional `token`), `evalPromptAppend`, `evalPromptAppendByRepo`, `evalClaudeExtraArgs`. | `{ ok: true, restartRequired: boolean }` | Writes `~/.code-triage/config.json`, then reloads in-process state (repo discovery, poll schedule, multi-account token resolver). **`restartRequired`** is `true` when the saved `port` differs from `listenPort`—restart the CLI so the HTTP server listens on the new port. |

**Account tokens on `POST`:** For an existing account (same `name` as in the current file), an **empty or omitted `token`** keeps the previously saved token. New accounts must include a token.

## Actions (`POST`)

| Path | Body (summary) | Purpose |
|------|----------------|---------|
| `/api/actions/reply` | `repo`, `commentId`, `prNumber` | Post `evaluation.reply`, resolve thread, mark `replied`. |
| `/api/actions/resolve` | `repo`, `commentId`, `prNumber` | Optional reply from evaluation, resolve thread, mark `replied`. |
| `/api/actions/dismiss` | `repo`, `commentId`, `prNumber` | Mark `dismissed` locally only. |
| `/api/actions/batch` | `action`, `items[]` | Same as reply/resolve/dismiss for many comments. |
| `/api/actions/re-evaluate` | `repo`, `commentId`, `prNumber` | Fetch comment from GitHub, run Claude, update evaluation. |
| `/api/actions/fix` | `repo`, `commentId`, `prNumber`, `branch`, `comment{path,line,body,diffHunk}` | Start async worktree + Claude fix; returns immediately with `status: running`. |
| `/api/actions/batch-fix` | `repo`, `prNumber`, `branch`, `threads` (`{ commentId, path, line, body, diffHunk }[]`, min 2, max 12) | One Claude run over multiple review threads in a single worktree; one diff / one apply. Returns `status: running`. Requires no other in-flight fix. |
| `/api/actions/fix-apply` | `repo`, `commentId`, `prNumber`, `branch` | Commit, push, remove worktree, mark `fixed`. |
| `/api/actions/fix-discard` | `branch`, optional `repo`, `commentId` | Remove worktree; clear fix status if `commentId` set. |
| `/api/actions/review` | `repo`, `prNumber`, `event` (`APPROVE` \| `REQUEST_CHANGES` \| `COMMENT`), optional `body` | Submit PR review. |
| `/api/actions/comment` | `repo`, `prNumber`, `commitId`, `path`, `line`, `side`, `body` | Create a new review line comment. |
| `/api/actions/clear-repo-poll-schedule` | _(empty)_ | Deletes SQLite `repo_poll` rows so the **CLI poller** recomputes adaptive hot/cold on the next cycle. Used by the web refresh control. |

## Reviews PR assistant (`POST`)

Companion chat for the web reviews page: summarizes review threads and answers questions in prose. The model may include a machine-readable **queue-fixes** or **batch-fix** fenced block; the server strips it from `messages` / `assistantMessage`. **`queueFixes`** drives per-thread **`POST /api/actions/fix`** calls (same as thread buttons). **`batchFix`** drives **`POST /api/actions/batch-fix`** so multiple threads are addressed in one job (single push when applied). If both blocks appear in one reply, **batch wins** and queue entries are ignored. Nothing is auto-applied to GitHub from the companion endpoint alone.

| Path | Body (summary) | Response |
|------|----------------|----------|
| `/api/reviews/companion/message` | `repo`, `prNumber`, `userMessage`, optional `threadBundle` (array of thread objects from the UI), optional `refreshContext` | `assistantMessage`, `messages` (full transcript), `contextNote`, `bundleThreadCount`, `bundleUpdatedAtMs`, optional `queueFixes`, optional `batchFix` (`{ commentIds: number[], userInstructions? }`) |
| `/api/reviews/companion/reset` | `repo`, `prNumber` | `{ ok: true }` — clears stored session for that PR |

**`threadBundle`:** Required for the first message in a PR session (or whenever `refreshContext` is `true`). Omit on later turns to reuse the last stored bundle; the web UI typically sends an updated bundle on every message to keep context fresh.

**Queue directive:** Fence label `code-triage-queue-fixes`, body JSON `{"queueFixes":[{"commentId":123,"userInstructions":"optional"}]}`. **Batch directive:** Fence label `code-triage-batch-fix`, body JSON `{"commentIds":[123,456],"userInstructions":"optional"}` (at least two ids). Documented in the PR assistant system prompt; not shown in the saved chat transcript.

**Errors:** **413** if the serialized bundle exceeds the server limit; **400** for missing `repo` / `prNumber` / `userMessage` or invalid body.

## Errors

- **400** — missing/invalid body, missing `localPath` for fix, missing evaluation for reply.
- **404** — unknown static path; API routes return JSON `{ error }`.
- **409** — fix already running for branch or PR.
- **500** — GitHub or Claude failures; message in JSON `error`.

## CORS

`Access-Control-Allow-Origin: *` with `OPTIONS` preflight support for `GET`, `POST`, and `Content-Type`.
