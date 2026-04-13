# Multi-Repo Discovery Design Spec

## Overview

Replace the single `--repo` flag with automatic discovery of all GitHub repositories under a root directory. cr-watch scans for git repos with GitHub remotes and polls all of them for CodeRabbit comments.

## Discovery Module (`src/discovery.ts`)

New module that finds GitHub repos under a root directory.

**Algorithm:**
1. Walk directories under `root` up to max depth 3
2. Skip directories named: `node_modules`, `.git`, `vendor`, `dist`, `.cr-worktrees`, `.cache`, `.npm`
3. For each directory containing a `.git/` subdirectory, run `git remote get-url origin`
4. Parse GitHub remote URL to extract `owner/repo` (supports both SSH and HTTPS formats)
5. Return array of `{ repo: "owner/repo", localPath: "/absolute/path" }`

**Exports:**
- `discoverRepos(root: string): RepoInfo[]` — scan and return all found repos
- `RepoInfo` type: `{ repo: string; localPath: string }`

**Behavior:**
- Discovery runs once at startup
- Re-discoverable on demand via hotkey `d` (discover repos)
- Repos without a GitHub remote are silently skipped
- Non-git directories are silently skipped
- Errors reading individual directories don't abort the scan

## CLI Changes (`src/cli.ts`)

**Flags:**
- Remove: `--repo` as the primary mode
- Add: `--root` flag (type: string, default: `~/src`) — directory to scan for repos
- Keep: `--repo` as an override — if provided, skip discovery and track only that single repo (backward compatibility)

**Startup flow:**
1. If `--repo` provided: use single-repo mode (existing behavior)
2. Else: run `discoverRepos(root)`, print discovered repos, use multi-repo mode

**Poll loop:**
- Iterate over all discovered repos
- Call `fetchNewComments` once per repo
- Aggregate results, then process comments per repo

**New hotkey:**
- `d` — Re-discover repos (re-scan root directory)

## State Changes (`src/state.ts`)

**Current:** `comments: Record<string, CommentRecord>` keyed by comment ID.

**New:** Comment keys are prefixed with repo: `"owner/repo:commentId"`. This avoids collisions if two repos happen to have the same comment IDs (unlikely but possible).

**Functions affected:**
- `markComment` — prefix key with repo
- `isNewComment` — prefix key with repo
- `getCommentsByStatus` — works as-is (iterates all entries)

**Migration:** Old state files without the prefix will still work — `isNewComment` checks for both the prefixed and unprefixed key.

## Poller Changes (`src/poller.ts`)

No changes needed. `fetchNewComments(repo, isNewComment)` already accepts a repo string parameter.

The `getRepoFromGit()` function is no longer called from cli.ts in multi-repo mode but stays available for backward compatibility.

## Actioner Changes (`src/actioner.ts`)

No changes needed. `processComments` already accepts `repoPath` as a parameter.

## API Changes (`src/api.ts`)

**New endpoint:**
- `GET /api/repos` — returns array of `{ repo: string, localPath: string }`

**Modified endpoints — add `repo` query parameter:**
- `GET /api/pulls?repo=owner/repo` — PRs for a specific repo. If omitted, returns PRs across all discovered repos (each PR object includes a `repo` field).
- `GET /api/pulls/:number?repo=owner/repo` — required when in multi-repo mode (PR numbers are only unique within a repo)
- `GET /api/pulls/:number/files?repo=owner/repo` — same
- `GET /api/pulls/:number/comments?repo=owner/repo` — same
- `GET /api/pulls/:number/files/*path?repo=owner/repo` — same

The server needs access to the discovered repos list. `registerRoutes` receives the list (or a getter function that returns the current list, so re-discovery is reflected).

## WebUI Changes

**Sidebar:**
- Add a repo selector dropdown at the top of the sidebar, above the PR list
- Options: "All repos" + one entry per discovered repo
- When a specific repo is selected, PR list filters to that repo and API calls include `?repo=`
- When "All repos" is selected, show PRs from all repos, grouped or labeled by repo name

**PR List:**
- Each PR item shows the repo name (short form, e.g., "repo-name") when viewing "All repos"

**API client (`web/src/api.ts`):**
- Add `getRepos()` method
- All existing methods gain an optional `repo?: string` parameter, appended as query string

**Types (`web/src/types.ts`):**
- Add `RepoInfo` type
- Add `repo` field to `PullRequest` type

## Non-Goals

- No per-repo polling intervals (all repos share the same interval)
- No persistent repo config file (discovery is ephemeral, re-runs each startup)
- No WebUI for adding/removing repos manually
- No support for non-GitHub remotes (GitLab, Bitbucket)
