# Zustand Centralized Store Design

**Date:** 2026-04-14
**Status:** Approved

## Problem

`App.tsx` is a ~1020-line god component with ~30 `useState` hooks covering PR lists, PR detail, poll metadata, fix jobs, notifications, UI state, config, and more. All data flows via prop drilling, components can't share state, and several subsystems (SSE, notifications, polling) are tightly coupled in one place. `sessionStorage` and `localStorage` are used for caching and muted PRs respectively.

## Decision

Replace all frontend state management with a single Zustand store. The store owns all data fetching, SSE subscriptions, notification logic, and UI state. No component-local `useState`, no `sessionStorage`, no `localStorage`. Components become pure views that read from selectors and call store actions.

## Library: Zustand

- ~1KB, zero boilerplate
- `set()` model allows one action to update multiple slices atomically (critical for SSE events that touch polls + fix jobs + PR lists)
- `subscribeWithSelector` middleware replaces ref-based notification diffing
- No providers or context wrappers — components just call `useAppStore(selector)`

## Store Structure

```
useAppStore
├── app          — appGate, error, config, preferredEditor, currentUser, repos
├── pulls        — authored PRs, review-requested PRs, repoFilter, loading/refreshing
├── prDetail     — selected PR, detail, files, comments, selected file, active tab, loading
├── pollStatus   — SSE connection, poll metadata, countdown, rate-limit state
├── fixJobs      — fix job list, form state, actions (apply/discard/reply)
├── notifications — muted PRs set, permission state, notification subscriptions/diffing
├── ui           — sidebar collapsed, mobile drawer, settings modal, shortcuts modal, media query
```

Each slice is a plain object with state + actions, combined via Zustand's slice pattern into one store. Actions in one slice can read/write other slices via `get()`.

## Slice Details

### `app`

**State:**
- `appGate: "loading" | "setup" | "ready"`
- `error: string | null`
- `config: AppConfigPayload | null`
- `setupConfig: ConfigGetResponse | null`
- `preferredEditor: string`
- `currentUser: string | null`
- `repos: RepoInfo[]`
- `updateAvailable: { behind: number; localSha: string; remoteSha: string } | null`

**Actions:**
- `initialize()` — fetches config, sets appGate, then triggers parallel fetches (user, repos, pulls-bundle) and version check when ready
- `saveConfig(body)` — POST config, update preferredEditor, re-fetch repos and pulls

### `pulls`

**State:**
- `authored: PullRequest[]`
- `reviewRequested: PullRequest[]`
- `repoFilter: string`
- `loading: boolean`
- `refreshing: boolean`
- `githubUserUnavailable: boolean`
- `pullFetchGeneration: number`
- `fetchInFlight: Promise<void> | null` (internal, not exposed to selectors)

**Actions:**
- `fetchPulls(isInitial?, resetRepoPollOnRefresh?)` — calls `api.getPullsBundle()`, updates lists, coalesces in-flight requests, bumps generation counter. On initial load with no selection, auto-selects first PR via `prDetail.selectPR()`
- `setRepoFilter(filter)` — updates filter string

**Derived (selectors, not stored):**
- `filteredAuthored` — authored PRs filtered by repoFilter
- `filteredReviewRequested` — review PRs filtered by repoFilter, excluding muted
- `mutedReviewPulls` — review PRs filtered by repoFilter, only muted
- `flatPulls` — concatenation of filteredAuthored + filteredReviewRequested

### `prDetail`

**State:**
- `selectedPR: { number: number; repo: string } | null`
- `detail: PullRequestDetail | null`
- `files: PullFile[]`
- `comments: ReviewComment[]`
- `selectedFile: string | null`
- `activeTab: "overview" | "threads" | "files" | "checks"`
- `loading: boolean`
- `reviewBody: string`
- `showRequestChanges: boolean`

**Actions:**
- `selectPR(number, repo)` — clears selected file and stale detail/files/comments, sets selectedPR, fires parallel `getPull` + `getPullFiles` + `getPullComments`, calls `pushRoute()` as side effect
- `selectFile(filename)` — sets selectedFile, calls `pushRoute()`
- `setActiveTab(tab)` — updates active tab
- `reloadComments()` — re-fetches comments for current PR
- `refreshIfMatch(repo, prNumber)` — silent refresh of detail + comments if the given PR matches the currently selected one
- `handlePopState()` — reads URL, updates selectedPR and selectedFile accordingly
- `submitReview(event, body?)` — calls `api.submitReview()`, refreshes detail
- `setReviewBody(text)` — updates review form text
- `setShowRequestChanges(show)` — toggles review form visibility

### `pollStatus`

**State:**
- `polling: boolean`
- `intervalMs: number`
- `baseIntervalMs: number | null`
- `estimatedGithubRequestsPerHour: number | null`
- `estimatedPollRequests: number | null`
- `pollBudgetNote: string | null`
- `pollPaused: boolean`
- `pollPausedReason: string | null`
- `rateLimited: boolean`
- `rateLimitResetAt: number | null`
- `rateLimitRemaining: number | null`
- `rateLimitLimit: number | null`
- `rateLimitResource: string | null`
- `lastPollError: string | null`
- `claude: { activeEvals, activeFixJobs, evalConcurrencyCap, totalEvalsThisSession, totalFixesThisSession } | null`
- `nextPollDeadline: number`
- `countdown: number`
- `rateLimitNow: number`

**Actions:**
- `connectSSE()` — opens `EventSource("/api/events")`, handles `poll-status` and `eval-complete` events. `poll-status` updates poll metadata, fix jobs (via `fixJobs` slice), and triggers `pulls.fetchPulls()` when `lastPoll` advances. `eval-complete` triggers `prDetail.refreshIfMatch()`. Returns teardown function.
- `fetchInitialStatus()` — one-shot `GET /api/poll-status` before SSE connects
- `applyPollStatus(status)` — shared logic for processing a PollStatus payload (updates own state, delegates fix jobs to fixJobs slice, fires browser notifications directly for fix job state transitions — these bypass muted PR checks, matching current behavior)
- `startCountdownTimer()` — ticks every 1s to update countdown and rateLimitNow. Returns teardown function.
- `startRateLimitPoller()` — while rate-limited, re-fetches poll-status every 20s. Returns teardown function.

### `fixJobs`

**State:**
- `jobs: FixJobStatus[]`
- `replyText: Record<number, string>` — keyed by commentId, for conversational reply textarea
- `noChangesReply: Record<number, string>` — keyed by commentId, for editable suggested-reply field
- `acting: Record<number, boolean>` — keyed by commentId, tracks in-flight actions per job

**Actions:**
- `setJobs(jobs)` — called by pollStatus when SSE pushes new fix job state
- `setReplyText(commentId, text)` — updates reply textarea for a job
- `setNoChangesReply(commentId, text)` — updates suggested reply for a no_changes job
- `apply(repo, commentId, prNumber, branch)` — calls `api.fixApply()`, triggers comment reload
- `discard(branch, commentId?)` — calls `api.fixDiscard()`, triggers comment reload
- `sendReply(repo, commentId, message)` — calls `api.fixReply()`
- `sendReplyAndResolve(repo, commentId, prNumber, replyBody)` — calls `api.fixReplyAndResolve()`, triggers comment reload
- `startFix(repo, commentId, prNumber, branch, comment, userInstructions?)` — calls `api.fixWithClaude()`, adds job to list

### `notifications`

**State:**
- `mutedPRs: Set<string>`
- `permission: NotificationPermission`
- `initialized: boolean`
- `commentBaselineReady: boolean`
- `previousReviewPRKeys: Set<string>`
- `previousCommentKeys: Set<string>`
- `previousPendingKeys: Set<string>`
- `previousChecksStatus: Map<string, string>`
- `previousOpenComments: Map<string, number>`
- `lastReviewReminder: number`

**Actions:**
- `initialize()` — called after pulls first load. Fetches comments for all authored PRs to build baseline sets. Sets `initialized` and `commentBaselineReady`.
- `diffAndNotify()` — called after each pull data update. Compares current state against baselines, fires browser notifications for new review requests, CI changes, new comments, and newly analyzed comments. Updates baselines. Skips muted PRs.
- `mutePR(repo, number)` — adds to set
- `unmutePR(repo, number)` — removes from set
- `isPRMuted(repo, number)` — check (also available as a standalone selector)
- `requestPermission()` — requests browser notification permission, updates `permission`
- `testNotification()` — fires a test notification
- `startReminderInterval()` — 30-minute recurring check for unmuted review PRs. Returns teardown function.
- `checkPermissionPeriodically()` — polls `Notification.permission` every 5s to detect browser-level changes. Returns teardown function.

**Wiring:** `subscribeWithSelector` subscribes to `pulls.pullFetchGeneration` changes and triggers `diffAndNotify()`.

### `ui`

**State:**
- `sidebarCollapsed: boolean`
- `mobileDrawerOpen: boolean`
- `isWide: boolean`
- `showSettings: boolean`
- `settingsConfig: ConfigGetResponse | null`
- `shortcutsOpen: boolean`

**Actions:**
- `toggleSidebar()` — toggles collapsed state
- `setMobileDrawerOpen(open)` — controls drawer
- `openSettings()` — fetches config via `api.getConfig()`, sets both `settingsConfig` and `showSettings`
- `closeSettings()` — clears both
- `toggleShortcuts()` — toggles shortcuts modal
- `initMediaQuery()` — sets up `matchMedia("(min-width: 768px)")` listener, updates `isWide`, auto-closes mobile drawer when going wide. Returns teardown function.
- `initKeyboardListener()` — registers global `keydown` handler. Reads store state via `get()` for current selection, flat pull list, modal state. Dispatches store actions for PR navigation (`]`/`[`), shortcuts toggle (`?`), escape. Returns teardown function.

## Data Flow

### Initialization Sequence

1. Root component mounts, calls `app.initialize()`
2. `GET /api/config` → sets `appGate` to `"setup"` or `"ready"`, populates config
3. If ready: parallel fetch of `GET /api/user`, `GET /api/repos`, `GET /api/pulls-bundle`
4. `GET /api/version` → populates `updateAvailable` if behind
5. Once pulls load: `pollStatus.fetchInitialStatus()` snapshot, then `pollStatus.connectSSE()`
6. `notifications.initialize()` — fetches comments for all authored PRs to seed baseline
7. `ui.initMediaQuery()`, `ui.initKeyboardListener()`, `pollStatus.startCountdownTimer()`
8. `notifications.startReminderInterval()`, `notifications.checkPermissionPeriodically()`

### SSE Event Handling

- `poll-status` event → `pollStatus.applyPollStatus()` which:
  - Updates poll metadata in `pollStatus` slice
  - Calls `fixJobs.setJobs()` with new fix job list
  - Fires browser notifications for fix job state transitions (running→completed/failed/no_changes)
  - If `lastPoll` advanced: triggers `pulls.fetchPulls()` and `prDetail.refreshIfMatch()`
  - Handles `testNotification` flag

- `eval-complete` event → `prDetail.refreshIfMatch(repo, prNumber)`

### PR Selection

- `prDetail.selectPR(number, repo)` → clears file, sets selected, parallel-fetches detail+files+comments, pushes URL
- `popstate` → thin root `useEffect` calls `prDetail.handlePopState()`

## URL Routing

`pushRoute()` and `parseRoute()` from `router.ts` remain as-is. The store calls them as side effects within `prDetail.selectPR()`, `prDetail.selectFile()`, and `prDetail.handlePopState()`.

## File Structure

```
web/src/
├── store/
│   ├── index.ts          — createStore, combine slices, export useAppStore + selectors
│   ├── appSlice.ts       — app slice
│   ├── pullsSlice.ts     — pulls slice + derived selectors
│   ├── prDetailSlice.ts  — PR detail slice
│   ├── pollStatusSlice.ts — poll status + SSE slice
│   ├── fixJobsSlice.ts   — fix jobs slice
│   ├── notificationsSlice.ts — notifications + muted PRs slice
│   └── uiSlice.ts        — UI state slice
├── api.ts                — unchanged (pure fetch wrappers)
├── types.ts              — unchanged
├── router.ts             — unchanged
├── App.tsx               — thin shell: calls store.initialize() on mount, reads selectors, renders layout
├── components/           — all components become stateless views reading from useAppStore()
```

## What Gets Deleted

- All `useState` hooks in `App.tsx` (~30 hooks)
- `sessionStorage` caching (`CACHE_KEY_PULLS`, `CACHE_KEY_REVIEW`, `CACHE_KEY_TIME`)
- `localStorage` for muted PRs and sidebar state
- `useNotifications.ts` hook (absorbed into `notifications` slice)
- All prop drilling of state/callbacks through component trees
- `useRef` hacks for tracking previous state (`prevFixJobsRef`, `flatPullsRef`, `selectedPRRef`, etc.)

## What Stays Unchanged

- `api.ts` — pure fetch wrappers, no state
- `types.ts` — type definitions
- `router.ts` — URL parsing/pushing utilities
- `web/src/components/ui/` — shadcn components (stateless by nature)
- Component file structure — same files, but they import `useAppStore` instead of receiving props

## Migration Strategy

This is a full rewrite of the state layer. The recommended approach:

1. Create the store with all slices
2. Wire up `App.tsx` to use the store (replacing all useState/useEffect)
3. Migrate each component top-down, replacing props with store selectors
4. Delete `useNotifications.ts` and `sessionStorage`/`localStorage` usage
5. Verify SSE, notifications, and keyboard shortcuts work end-to-end
