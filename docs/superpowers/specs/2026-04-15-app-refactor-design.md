# App.tsx Refactor: TanStack Router + Component Decomposition

## Summary

Replace the custom `pushState`/`popState` router with TanStack Router, split the 508-line `App.tsx` god component into focused route/layout components, decompose the three largest components (`CommentThreads`, `FixJobsBanner`, `SettingsView`), aggressively migrate URL-derived state out of Zustand into the router, make Settings a routed full page, and rename all web files to kebab-case.

## Goals

1. **App.tsx is no longer a god component** -- it gets deleted entirely, replaced by route components and layouts.
2. **URL state has a single source of truth** -- TanStack Router owns path params, search params, and active mode. Zustand owns only non-URL app state.
3. **Large components are decomposed** -- `CommentThreads` (835 lines), `FixJobsBanner` (395 lines) broken into focused files.
4. **Settings becomes a routed page** -- full page at `/settings`, gear icon in the icon rail.
5. **Consistent file naming** -- all files in `web/src/` use kebab-case.

## Non-Goals

- No changes to data fetching patterns (polling, SSE, Zustand actions stay as-is).
- No adoption of TanStack Router loaders/actions -- data flow remains event-driven.
- No changes to the backend or API.
- No functional changes to the UI -- this is a structural refactor.

## Route Tree

```
/                                       -> redirects to /reviews
/reviews                                -> CodeReviewPage (all repos)
/reviews/$owner/$repo                   -> CodeReviewPage (filtered to repo)
/reviews/$owner/$repo/pull/$number      -> CodeReviewPage (PR detail)
/tickets                                -> TicketsPage (index)
/tickets/$ticketId                      -> TicketsPage (ticket detail)
/settings                               -> SettingsPage (full page, no sidebar)
```

Code review lives under `/reviews` to avoid route ambiguity with dynamic `$owner/$repo` params matching static routes like `tickets` or `settings`.

### Search Params (PR detail route only)

| Param  | Type                                           | Default      |
|--------|-------------------------------------------------|-------------|
| `tab`  | `"overview" \| "threads" \| "files" \| "checks"` | `"threads"` |
| `file` | `string \| undefined`                           | `undefined` |

Validated via TanStack Router's `validateSearch` with a Zod schema (or equivalent manual validator).

## Layout Architecture

```
RootLayout (icon rail + app gates + SSE + FixJobsBanner)
+-- SidebarLayout (sidebar panel + <Outlet />)
|   +-- CodeReviewPage (PR list sidebar + detail area)
|   +-- TicketsPage (ticket list sidebar + detail area)
+-- SettingsPage (full page, no sidebar -- icon rail still visible)
```

### RootLayout (`routes/__root.tsx`)

Responsibilities:
- Render the `IconRail` (always visible)
- App gate logic: loading spinner, setup redirect, error display
- Initialize app (`useEffect` calling `initialize()`)
- SSE connection setup and event listeners
- Tab badge sync (`useEffect` updating `document.title`)
- Render `FixJobsBanner` (global, always visible when jobs exist)
- Render `KeyboardShortcutsModal` (global)
- Render notification/permission/update banners
- `<Outlet />` for child routes

### SidebarLayout (`routes/_sidebar.tsx`)

Responsibilities:
- Render sidebar panel (collapsible, mobile drawer)
- Sidebar content determined by active child route:
  - Code Review routes: `RepoSelector` + `PRList` (authored + review-requested sections)
  - Tickets routes: `TicketsSidebar`
- Mobile header bar
- `<Outlet />` for the main content area

### CodeReviewPage (`routes/_sidebar/index.tsx`)

Covers all three code review route patterns (`/reviews`, `/reviews/$owner/$repo`, `/reviews/$owner/$repo/pull/$number`). These are defined as three separate TanStack route objects in `router.ts` that all render the same `CodeReviewPage` component. The component reads optional path params (`owner`, `repo`, `number`) to determine what to show -- all params absent means "all repos, no PR selected".

Responsibilities:
- Read path params to determine repo filter and selected PR
- Read search params for `tab` and `file`
- Trigger PR detail fetch when params change (via `useEffect`)
- Render PR detail area with tab content (Overview, Threads, Files, Checks)
- Empty state when no PR is selected

### TicketsPage (`routes/_sidebar/tickets.tsx`)

Covers `/tickets` and `/tickets/$ticketId`.

Responsibilities:
- Read `$ticketId` param
- Render `TicketIssueDetail` when a ticket is selected
- Empty state when no ticket is selected

### SettingsPage (`routes/settings.tsx`)

Responsibilities:
- Render `SettingsView` component (existing form, `mode="settings"`)
- No sidebar, no sidebar layout -- just the icon rail from RootLayout + the settings form
- Navigation back via icon rail buttons or browser back

## Icon Rail Changes

- Code Review and Tickets buttons become TanStack Router `<Link>` components instead of `setActiveMode()` calls.
- Active state determined by route matching (`useMatchRoute()` or similar), not `activeMode` from Zustand.
- New gear icon pinned to the bottom of the rail (below a `flex-1` spacer), linking to `/settings`.
- `activeMode` is deleted from Zustand entirely.
- Tickets button visibility still gated on `hasLinearApiKey` from config.

## State Migration

### Deleted from Zustand (moved to router)

| State                | Router equivalent                                  |
|----------------------|----------------------------------------------------|
| `activeMode`         | Current route determines mode                      |
| `selectedPR` (identity) | Path params `/reviews/$owner/$repo/pull/$number`  |
| `activeTab`          | Search param `tab`                                 |
| `selectedFile`       | Search param `file`                                |
| `showSettings`       | Route is `/settings`                               |
| `openSettings()`     | `navigate({ to: '/settings' })`                    |
| `closeSettings()`    | `navigate({ to: '/reviews' })` or `router.history.back()` |

### Stays in Zustand

- Polling/status: `polling`, `pollPaused`, `rateLimited`, `rateLimitRemaining`, `timerText`, `lastPollError`, etc.
- Claude status: `claude` (activeEvals, activeFixJobs, totals)
- PR detail data: `detail`, `comments`, `files` (fetched data, not identity)
- Fix jobs: `jobs`, `queue`, `selectedJobId`, `acting`, `replyText`, etc.
- UI ephemeral: `sidebarCollapsed`, `mobileDrawerOpen`, `expandedThreads`, `threadFilterText`, etc.
- App gate: `appGate`, `error`, `updateAvailable`
- Config: `config`, `settingsForm`, etc.

### Navigation Actions

Current Zustand actions that touch URL state become router navigation calls:

```typescript
// Before (Zustand)
selectPR(repo, number)
setActiveTab(tab)
selectFile(path)
navigateToLinkedTicket(id)

// After (router)
navigate({ to: '/reviews/$owner/$repo/pull/$number', params: { owner, repo, number } })
navigate({ search: (prev) => ({ ...prev, tab }) })
navigate({ search: (prev) => ({ ...prev, file: path, tab: 'files' }) })
navigate({ to: '/tickets/$ticketId', params: { ticketId } })
```

Data-fetching side effects (loading PR detail when a PR is selected) move to `useEffect` hooks in route components watching the route params, rather than being triggered imperatively by `selectPR()`.

## Component Decomposition

### CommentThreads (835 lines -> 4 files)

| File                  | ~Lines | Contents                                                        |
|-----------------------|--------|-----------------------------------------------------------------|
| `comment-threads.tsx` | 150    | Main export: thread list rendering, keyboard navigation, bulk actions |
| `thread-item.tsx`     | 260    | Single thread: header, expand/collapse, action buttons, fix modal, triage panel, `FixConversation` inline |
| `thread-filters.tsx`  | 80     | Search input, action filter buttons, snoozed toggle, keyboard help |
| `thread-utils.ts`     | 60     | `buildThreads()`, `isSnoozed()`, `buildEditorUri()`, `EvalBadge`, `ThreadStatusBadge` |

### FixJobsBanner (395 lines -> 3 files)

| File                  | ~Lines | Contents                                                        |
|-----------------------|--------|-----------------------------------------------------------------|
| `fix-jobs-banner.tsx` | 60     | Banner bar: status summary counts, job list, queue list         |
| `fix-job-modal.tsx`   | 230    | Detail modal: info grid, conversation, diff, error, actions (apply/discard/retry/reply) |
| `fix-job-row.tsx`     | 40     | Single job row in the banner list                               |

Shared helpers (`elapsed()`, `statusColors`, `statusIcons`) consolidate into whichever file needs them, or into a small shared constant if both `fix-job-row.tsx` and `fix-job-modal.tsx` use them.

### SettingsView (433 lines -> no split)

Stays as a single file (`settings-view.tsx`). It's a cohesive form -- splitting by section would create artificial boundaries with excessive prop threading for `updateField`. The only change is removing the modal/overlay wrapper (`closeSettings` button becomes a back-navigation link or is removed since the icon rail handles navigation).

## File Structure

```
web/src/
+-- routes/
|   +-- __root.tsx              # RootLayout
|   +-- _sidebar.tsx            # SidebarLayout
|   +-- _sidebar/
|   |   +-- index.tsx           # CodeReviewPage
|   |   +-- tickets.tsx         # TicketsPage
|   +-- settings.tsx            # SettingsPage
+-- router.ts                   # Route tree, createRouter()
+-- components/
|   +-- icon-rail.tsx           # Renamed + updated with Link nav, gear icon
|   +-- comment-threads.tsx     # Renamed + slimmed
|   +-- thread-item.tsx         # NEW
|   +-- thread-filters.tsx      # NEW
|   +-- thread-utils.ts         # NEW
|   +-- fix-jobs-banner.tsx     # Renamed + slimmed
|   +-- fix-job-modal.tsx       # NEW
|   +-- fix-job-row.tsx         # NEW
|   +-- settings-view.tsx       # Renamed, modal wrapper removed
|   +-- pr-list.tsx             # Renamed
|   +-- pr-detail.tsx           # Renamed
|   +-- pr-overview.tsx         # Renamed
|   +-- file-list.tsx           # Renamed
|   +-- diff-view.tsx           # Renamed
|   +-- checks-panel.tsx        # Renamed
|   +-- comment.tsx             # Renamed
|   +-- keyboard-shortcuts-modal.tsx  # Renamed
|   +-- tickets-sidebar.tsx     # Renamed
|   +-- ticket-issue-detail.tsx # Renamed
|   +-- ui/
|       +-- badge.tsx           # Already kebab
|       +-- button.tsx
|       +-- checkbox.tsx
|       +-- collapsible-section.tsx
|       +-- dialog.tsx
|       +-- icon-button.tsx
|       +-- input.tsx
|       +-- separator.tsx
|       +-- status-badge.tsx
|       +-- switch.tsx
|       +-- tabs.tsx
+-- store.ts                    # Zustand store (URL state removed)
+-- api.ts                      # API client
+-- main.tsx                    # RouterProvider
+-- lib/
|   +-- utils.ts
+-- types.ts
```

### Deleted Files

- `web/src/App.tsx` -- replaced by route components
- `web/src/router.ts` (current custom router) -- replaced by TanStack Router setup

### Renamed Files (kebab-case)

All PascalCase component files become kebab-case. Exports (component names) remain PascalCase -- only file names change. All imports across the codebase are updated.

## Router Setup

Using **code-based route definitions** (not TanStack's file-based routing plugin). The `routes/` directory is organizational only.

`router.ts` will contain:
- `createRootRoute()` with the RootLayout component
- `createRoute()` for each route, with path params and search param validation
- `createRouter()` assembling the tree
- TypeScript module declaration for type-safe route references

`main.tsx` will render `<RouterProvider router={router} />` instead of `<App />`.

## Setup Flow

The app has a setup gate (`appGate === "setup"`) that shows `SettingsView` with `mode="setup"` before the app is usable. This is handled in the `RootLayout` -- if `appGate === "setup"`, render the setup view instead of `<Outlet />`. The router still mounts, but the gate intercepts rendering. This is not a route -- it's a one-time first-run experience.

## Testing

- `yarn build:all` must compile cleanly
- `yarn test` must pass (existing tests don't test web components, so no test changes expected)
- Manual smoke test: navigate between Code Review, Tickets, Settings; verify URL updates; verify back/forward buttons work; verify bookmarkable URLs; verify search params (tab, file) persist correctly
