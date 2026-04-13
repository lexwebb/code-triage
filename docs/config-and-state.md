# Config, state, and worktrees

## Config (`~/.code-triage/config.json`)

**How it is created**

- **First launch (no config file):** The CLI starts the HTTP server with in-memory defaults and **does not** prompt in the terminal. Open the web UI: it shows a **settings** screen until you save. That writes `config.json` and triggers an in-process reload (repo discovery, polling, token routing).
- **Terminal setup:** Run `code-triage --config` for interactive prompts (same file).
- **Web anytime:** From the main UI, use **Settings** (gear) to edit all fields; saving calls `POST /api/config` (see [`http-api.md`](./http-api.md)).

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `root` | string | `~/src` | Directory scanned for GitHub clones (unless `--repo`). |
| `port` | number | `3100` | HTTP server port (changing it in the UI requires **restarting** the CLI if the process is already listening on another port). |
| `interval` | number | `1` | Poll interval in **minutes**. |
| `evalConcurrency` | number | `2` | Max concurrent Claude evaluation processes (`claude -p`) per poll batch; clamped **1–8**. |
| `pollReviewRequested` | boolean | `false` | When `true`, the poller also scans **open PRs where you are a requested reviewer** (not the author) and runs Claude on new inline comments there. Increases GitHub and Claude usage. Matches **user** reviewers in `requested_reviewers` only (not requested teams). |
| `commentRetentionDays` | number | — | After each **successful** poll, delete SQLite comment rows with status `replied`, `dismissed`, or `fixed` whose `timestamp` is older than this many days. **`pending` is never removed.** Omitted or `0` disables compaction. |
| `ignoredBots` | string[] | — | Extra GitHub logins treated like built-in ignored bots in `poller.ts`. |
| `githubToken` | string | — | Optional default PAT in config (used when env tokens below are unset). Multi-account `accounts[]` still overrides per-repo owner. |
| `accounts` | array | — | Optional multi-account PATs: `{ name, token, orgs: string[] }`. Repo **owner** matched against `orgs` selects `token`; otherwise the default token chain applies. |
| `evalPromptAppend` | string | — | Appended to the Claude PR-comment evaluation prompt for all repos. |
| `evalPromptAppendByRepo` | object | — | Map of `owner/repo` → string; appended after `evalPromptAppend` for that repo. |
| `evalClaudeExtraArgs` | string[] | — | Extra arguments after `claude -p` / `--output-format json` (e.g. `["--model","opus"]`). |

**GitHub API token resolution (default account):** `GITHUB_TOKEN` or `GH_TOKEN` (if set) → `githubToken` from config → `gh auth token`. If none of these are available, the CLI requires `gh auth login` unless you configure a token in Settings or env. **`gh` is not required** when a PAT is supplied via env or config.

CLI flags override config: `--root`, `--port`, `--interval`, `--repo`, `--dry-run`, `--eval-concurrency`, `--poll-review-requested` (enables for this run; omit to use config), `--comment-retention-days`.

## State (`~/.code-triage/state.sqlite`)

SQLite (WAL mode) via **Drizzle ORM** and **better-sqlite3**. Schema lives in `src/db/schema.ts`; reads/writes go through `src/state.ts` (same `CrWatchState` shape as before).

**Migration:** On first creation of `state.sqlite`, if `state.json` is present it is imported into the database and then renamed to `state.json.migrated`. Corrupt JSON is left in place.

**Tests:** Set environment variable `CODE_TRIAGE_STATE_DIR` to a temporary directory so Vitest does not touch your real `~/.code-triage` database (see `src/state.test.ts`).

**Writes:** Each `saveState` runs a transaction that replaces all comment rows and fix-job rows and updates `lastPoll` (full snapshot, matching the old JSON file semantics).

### Top-level shape (in-memory / API)

- `lastPoll` — ISO timestamp of last successful poll completion (string or `null`).
- `comments` — map of comment records (see keys below).
- `fixJobs` — optional array of in-progress or stale fix job records for recovery.

### Comment keys

Keys are **`owner/repo:commentId`** when a repo is known, so the same numeric comment id cannot collide across repositories.

`isNewComment` in `state.ts` also treats a legacy unprefixed `commentId` key as “already seen” for migration.

### Comment record (`CommentRecord`)

- `status`: `pending` | `replied` | `fixed` | `dismissed`
- `prNumber`
- `repo` (optional; implied by key)
- `timestamp` — ISO string
- `evaluation` (optional): `{ action: reply|fix|resolve, summary, reply?, fixDescription? }`

**Dismissed** is local-only: GitHub thread is unchanged.

### Fix job record (`FixJobRecord`)

Persisted while a worktree fix runs so a crash or restart can reconcile:

- `commentId`, `repo`, `prNumber`, `branch`, `path`, `worktreePath`, `startedAt`

On success, the job is removed from state and completion lives in memory until the user applies or discards. On failure with no diff, the worktree is removed and the job cleared.

## Worktrees (`.cr-worktrees/`)

Per **repository root** (not global): `join(repoRoot, ".cr-worktrees", sanitizedBranchName)`.

- **Create:** `git worktree add` on the PR branch; falls back to **detached** checkout if the branch is already locked elsewhere.
- **Remove:** `git worktree remove --force` with filesystem fallback + `git worktree prune`.
- **Startup:** `pruneOrphanedWorktrees` deletes every directory under `.cr-worktrees` that is **not** listed in an active `fixJobs` record—cleaning leftovers from killed processes.

**Cleanup command:** `code-triage --cleanup` runs `cleanupAllWorktrees` from the **current** repo’s git root (used when invoked from a repo directory in that workflow—see CLI help in README).

## Debug logging

If `DEBUG=true` or `--debug` is passed, `src/logger.js` appends to `~/.code-triage/debug.log`. Otherwise only stderr is used.

## Clear state

- CLI hotkey **`c`**: clearing state drops all comment records, fix jobs, and `lastPoll`. Avoid clearing while a fix is running unless you intend to abandon recovery metadata.
