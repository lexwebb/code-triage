# Features and rationale

This document ties **what the product does** to **why it is shaped that way** in code. It reflects the current implementation.

## Problem being solved

Automated reviewers (notably **CodeRabbit**) leave many **inline review comments** on pull requests. Triaging them—deciding whether to reply, change code, or mark resolved—is repetitive. Code Triage batches **GitHub visibility**, **LLM classification**, and **one-click actions** so you stay in flow instead of jumping between the GitHub UI, local editor, and terminal.

The name *Code Triage* matches the workflow: **surface**, **prioritize**, **act**.

## Multi-repo discovery

**Feature:** Scan a directory tree for clones whose `origin` is GitHub; treat each as a tracked repo.

**Why:** Many developers keep dozens of repos under one folder (for example `~/src`). Enumerating them once avoids maintaining a manual list and keeps the sidebar aligned with what is actually on disk.

**Trade-off:** Discovery is depth-limited and skips heavy directories (`node_modules`, `.cr-worktrees`, etc.) so scans stay fast. **Single-repo mode** (`--repo owner/name`) skips the walk but leaves `localPath` empty unless you use full discovery—**Claude fixes require a local clone path** (see [Config and state](./config-and-state.md)).

## Two PR lists: “mine” vs “review requested”

**Feature:** The web UI shows:

1. **Your open PRs** (you are the author)—aligned with `GET /api/pulls`.
2. **PRs requesting your review**—aligned with `GET /api/pulls/review-requested`.

**Why:** Authors need to **respond to bot and human review comments** on their branches. Reviewers need a **queue of others’ PRs** to approve, request changes, or read diffs—without mixing the two mental models.

**Critical detail:** By default, the **background poller** that finds **new** comments and runs **Claude** only considers PRs where **you are the author** (`src/poller.ts`). Review-requested PRs are always fetched for the dashboard and actions (approve, comment, etc.). **Optional:** set `pollReviewRequested: true` in config (or pass `--poll-review-requested`) so the poller **also** scans open PRs where **you are a requested reviewer** and analyzes new inline comments there—same scope as the “review requested” list, at higher GitHub/Claude cost.

## Comment filtering (bots and resolved threads)

**Feature:** Ignore comments from known CI/bots; allow extra ignores via config. Skip comments that belong to **resolved** review threads (GraphQL).

**Why:** Noise from Vercel, Dependabot, etc. would flood the queue. Resolved-thread filtering avoids re-processing work GitHub already considers closed.

## Claude “evaluation” (reply / fix / resolve)

**Feature:** Each new eligible comment gets a short Claude run that returns structured JSON: suggested **action**, **summary**, and optional **reply** text.

**Why:** A single model pass cheaply separates “needs code” from “needs words” from “already handled,” so the UI can show consistent buttons. Strict JSON is requested; the code **falls back** if the model wraps output in markdown or free text—pragmatic for CLI output variability.

**Dry run:** `--dry-run` still records comments as `pending` but skips Claude—useful for connectivity or quota checks.

## Web dashboard

**Feature:** PR list, overview, file tree, diff view, threaded comments with markdown, deep URLs, repo/title filter, optional **mute** for review PRs (client-side).

**Why:** GitHub’s UI is powerful but heavy for repeating the same triage loop. A dedicated dashboard keeps **comment state** (`crStatus`, `evaluation`) next to **diff context** and actions.

## Actions: reply, resolve, dismiss, batch

**Feature:** Post a reply to a review comment, resolve the **thread** (GraphQL), or mark dismissed locally; batch variants for several comments.

**Why:** **Reply** uses the model-suggested text when present. **Resolve** optionally posts the evaluation reply first, then resolves the thread—mirroring “answer and close.” **Dismiss** only updates local state so you can hide items without touching GitHub (for example noise you will never act on).

**Note:** `POST /api/actions/reply` posts the reply and then calls `resolveThread` **without** a second reply body—implementation detail aimed at clearing the thread after responding.

## Fix with Claude (worktrees)

**Feature:** Create a **git worktree** under `.cr-worktrees/`, run Claude with permission skipping so it can edit files, show a **diff**, then **apply** (commit + push) or **discard**.

**Why:**

- **Isolation:** Your main working tree stays untouched; you can compare and abandon safely.
- **Concurrency guard:** The API rejects overlapping fixes on the same branch or PR to avoid conflicting worktrees.
- **Async job:** The HTTP handler returns immediately; the UI polls `/api/poll-status` for `running` / `completed` / `failed` and stores partial state in `state.json` for **recovery** after crashes (`GET /api/fix-jobs/recover`).

Using `--dangerously-skip-permissions` is a deliberate trade-off: fixes are meant to be **reviewed in the diff preview** before push.

## PR review (approve / request changes)

**Feature:** Submit a formal review on a PR from the UI.

**Why:** When you live in the dashboard for review-requested PRs, you should not need to return to GitHub for the final approve/request-changes step.

## Reviewer status and checks

**Feature:** PR detail aggregates **requested reviewers** with latest **review state** (pending, approved, changes requested) and surfaces **combined commit status** where available.

**Why:** Gives at-a-glance merge readiness without opening GitHub’s checks tab.

## Notifications

**Feature:** When the poller sees new comments, the CLI sends a desktop toast via **[node-notifier](https://github.com/mikaelbr/node-notifier)** (Notification Center on macOS, SnoreToast / balloons on Windows, `notify-send` or Growl fallbacks on Linux). If that fails, the terminal logs an error and points you to the **web UI**, which uses the browser **`Notification` API** (`useNotifications.ts`) for PR list changes, CI status, new comments, analysis results, and fix-job completion.

**Why:** `node-notifier` is the standard cross-platform Node integration; the web UI covers users who skip desktop toasts or run headless.

**Detail:** After the first load, the app refreshes PR lists when the CLI finishes a poll (`EventSource` on `/api/events`). That bumps a generation counter so notification logic can re-fetch per-PR comments and detect **new threads** and **new Claude evaluations** without a separate one-minute polling loop against the pull list.

## Live UI hints (SSE)

**Feature:** `GET /api/events` pushes **Server-Sent Events** when a poll cycle completes and when fix-job status changes, so the web UI can refresh without waiting for the next `/api/poll-status` interval.

**Why:** Snappier dashboard after the CLI finishes analyzing comments or when a fix job completes.

## Multi-account GitHub (optional config)

**Feature:** Extra PATs keyed by org owner in `config.json` via `accounts[]`.

**Why:** Work and personal GitHub identities often use different tokens; matching repo `owner` to an account picks the right credential for API calls.

## Rate limits and version hint

**Feature:** `exec.ts` backs off on HTTP 429; `/api/poll-status` can expose rate-limit state. `/api/version` compares local git HEAD to `origin/main` (cached).

**Why:** Heavy multi-repo polling can hit limits; surfacing that in the UI avoids mystery stalls. The version endpoint nudges developers who run from source to pull updates.

## Ink CLI + embedded server

**Feature:** Terminal UI alongside `http://localhost:3100`.

**Why:** Operators get **logs, hotkeys, and poll countdown** in the terminal while the **rich UI** lives in the browser—no need to choose one or the other.

## Minimal dependencies

**Feature:** CLI runtime deps are essentially **Ink + React** plus **`@octokit/rest`** for GitHub (helpers in `exec.ts` still expose `ghAsync` / `ghPost` / `ghGraphQL`).

**Why:** Typed, maintained client while keeping a custom `fetch` wrapper so rate-limit retries and tests stay predictable.
