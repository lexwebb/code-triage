# Config, state, and worktrees

## Config (`~/.code-triage/config.json`)

Created or updated by first-run setup or `code-triage --config`.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `root` | string | `~/src` | Directory scanned for GitHub clones (unless `--repo`). |
| `port` | number | `3100` | HTTP server port. |
| `interval` | number | `1` | Poll interval in **minutes**. |
| `ignoredBots` | string[] | — | Extra GitHub logins treated like built-in ignored bots in `poller.ts`. |
| `accounts` | array | — | Optional multi-account PATs: `{ name, token, orgs: string[] }`. Repo **owner** matched against `orgs` selects `token`; otherwise `gh auth token` is used. |

CLI flags override config: `--root`, `--port`, `--interval`, `--repo`, `--dry-run`.

## State (`~/.code-triage/state.json`)

Atomic write: JSON written to `state.json.tmp` then renamed to `state.json`.

### Top-level shape

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

- CLI hotkey **`c`** or manual edit: clearing state drops all comment records and `lastPoll`; fix job list should be reconsidered if you clear while fixes run.
