# App.tsx Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom router with TanStack Router, split App.tsx into focused route/layout components, decompose large components, migrate URL state from Zustand to the router, and rename all web files to kebab-case.

**Architecture:** TanStack Router owns all URL-derived state (path params, search params, active mode). Zustand keeps non-URL app state (polling, data, UI ephemeral). Route components live in `web/src/routes/`, composed via code-based route definitions in `web/src/router.ts`. Layout is RootLayout (icon rail + gates) > SidebarLayout (sidebar + outlet) > Page components.

**Tech Stack:** TanStack Router v1 (code-based routes), React 19, Zustand, Vite, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-04-15-app-refactor-design.md`

---

### Task 1: Install TanStack Router

**Files:**
- Modify: `web/package.json`

- [ ] **Step 1: Install the package**

```bash
cd web && yarn add @tanstack/react-router
```

- [ ] **Step 2: Verify it installed**

```bash
cd web && node -e "require.resolve('@tanstack/react-router')"
```

Expected: prints the resolved path, no error.

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/yarn.lock
git commit -m "chore: add @tanstack/react-router dependency"
```

---

### Task 2: Rename all web files to kebab-case

**Files (renames):**
- `web/src/App.tsx` → `web/src/app.tsx`
- `web/src/components/RepoSelector.tsx` → `web/src/components/repo-selector.tsx`
- `web/src/components/PRList.tsx` → `web/src/components/pr-list.tsx`
- `web/src/components/PRDetail.tsx` → `web/src/components/pr-detail.tsx`
- `web/src/components/PROverview.tsx` → `web/src/components/pr-overview.tsx`
- `web/src/components/FileList.tsx` → `web/src/components/file-list.tsx`
- `web/src/components/DiffView.tsx` → `web/src/components/diff-view.tsx`
- `web/src/components/CommentThreads.tsx` → `web/src/components/comment-threads.tsx`
- `web/src/components/Comment.tsx` → `web/src/components/comment.tsx`
- `web/src/components/FixJobsBanner.tsx` → `web/src/components/fix-jobs-banner.tsx`
- `web/src/components/ChecksPanel.tsx` → `web/src/components/checks-panel.tsx`
- `web/src/components/SettingsView.tsx` → `web/src/components/settings-view.tsx`
- `web/src/components/KeyboardShortcutsModal.tsx` → `web/src/components/keyboard-shortcuts-modal.tsx`
- `web/src/components/IconRail.tsx` → `web/src/components/icon-rail.tsx`
- `web/src/components/TicketsSidebar.tsx` → `web/src/components/tickets-sidebar.tsx`
- `web/src/components/TicketIssueDetail.tsx` → `web/src/components/ticket-issue-detail.tsx`

Also rename store slice files if they aren't already kebab-case:
- `web/src/store/appSlice.ts` → `web/src/store/app-slice.ts`
- `web/src/store/fixJobsSlice.ts` → `web/src/store/fix-jobs-slice.ts`
- `web/src/store/notificationsSlice.ts` → `web/src/store/notifications-slice.ts`
- `web/src/store/pollStatusSlice.ts` → `web/src/store/poll-status-slice.ts`
- `web/src/store/prDetailSlice.ts` → `web/src/store/pr-detail-slice.ts`
- `web/src/store/pullsSlice.ts` → `web/src/store/pulls-slice.ts`
- `web/src/store/settingsForm.ts` → `web/src/store/settings-form.ts`
- `web/src/store/ticketsSlice.ts` → `web/src/store/tickets-slice.ts`
- `web/src/store/uiSlice.ts` → `web/src/store/ui-slice.ts`

**Note:** Use the `mcp__typescript-tools__rename_file_or_folder` tool for each rename — it updates all import paths automatically. If the tool is unavailable, use `git mv` and then update all imports manually.

- [ ] **Step 1: Rename component files**

Rename each component file listed above. After each rename, verify imports were updated correctly. Component export names stay PascalCase — only file names change.

- [ ] **Step 2: Rename store slice files**

Rename each store file listed above. Update the imports in `web/src/store/index.ts` accordingly.

- [ ] **Step 3: Rename App.tsx**

```bash
cd /Users/lex/src/cr-watch && git mv web/src/App.tsx web/src/app.tsx
```

Update import in `web/src/main.tsx`:

```typescript
import App from "./app";
```

- [ ] **Step 4: Verify build**

```bash
yarn build:all
```

Expected: clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(web): rename all files to kebab-case"
```

---

### Task 3: Create router.ts with route tree

**Files:**
- Create: `web/src/router.ts` (new — this will replace the existing `web/src/router.ts` custom router)
- Create: `web/src/routes/__root.tsx` (stub only — real content in Task 4)
- Create: `web/src/routes/_sidebar.tsx` (stub only — real content in Task 5)
- Create: `web/src/routes/_sidebar/index.tsx` (stub only)
- Create: `web/src/routes/_sidebar/tickets.tsx` (stub only)
- Create: `web/src/routes/settings.tsx` (stub only)

- [ ] **Step 1: Create stub route components**

Create minimal components that just render a placeholder. These will be filled in by subsequent tasks.

`web/src/routes/__root.tsx`:
```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: function RootLayout() {
    return <Outlet />;
  },
});
```

`web/src/routes/_sidebar.tsx`:
```tsx
import { createRoute, Outlet } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "sidebar",
  component: function SidebarLayout() {
    return <Outlet />;
  },
});
```

`web/src/routes/_sidebar/index.tsx`:
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "/",
  component: function CodeReviewIndex() {
    return <div>Code Review</div>;
  },
});
```

`web/src/routes/_sidebar/tickets.tsx`:
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "tickets",
  component: function TicketsIndex() {
    return <div>Tickets</div>;
  },
});
```

`web/src/routes/settings.tsx`:
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: function SettingsPage() {
    return <div>Settings</div>;
  },
});
```

- [ ] **Step 2: Create router.ts with the full route tree**

Replace the existing `web/src/router.ts` (the custom pushState/popState router) with TanStack Router setup:

```typescript
import { createRouter } from "@tanstack/react-router";
import { Route as rootRoute } from "./routes/__root";
import { Route as sidebarRoute } from "./routes/_sidebar";
import { Route as codeReviewIndexRoute } from "./routes/_sidebar/index";
import { Route as codeReviewRepoRoute } from "./routes/_sidebar/code-review-repo";
import { Route as codeReviewPRRoute } from "./routes/_sidebar/code-review-pr";
import { Route as ticketsIndexRoute } from "./routes/_sidebar/tickets";
import { Route as ticketsDetailRoute } from "./routes/_sidebar/tickets-detail";
import { Route as settingsRoute } from "./routes/settings";

const routeTree = rootRoute.addChildren([
  sidebarRoute.addChildren([
    codeReviewIndexRoute,
    codeReviewRepoRoute,
    codeReviewPRRoute,
    ticketsIndexRoute,
    ticketsDetailRoute,
  ]),
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

**Note:** This references route files that don't exist yet (`code-review-repo`, `code-review-pr`, `tickets-detail`). We need to create them. Rather than having a single `index.tsx` handle three different code review route patterns, create separate route files that share the same component:

`web/src/routes/_sidebar/code-review-repo.tsx`:
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "$owner/$repo",
  component: function CodeReviewRepo() {
    return <div>Code Review Repo</div>;
  },
});
```

`web/src/routes/_sidebar/code-review-pr.tsx`:
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "$owner/$repo/pull/$number",
  validateSearch: (search: Record<string, unknown>) => ({
    tab: (search.tab as "overview" | "threads" | "files" | "checks") ?? "threads",
    file: (search.file as string) ?? undefined,
  }),
  component: function CodeReviewPR() {
    return <div>Code Review PR</div>;
  },
});
```

`web/src/routes/_sidebar/tickets-detail.tsx`:
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "tickets/$ticketId",
  component: function TicketsDetail() {
    return <div>Ticket Detail</div>;
  },
});
```

- [ ] **Step 3: Verify build**

```bash
yarn build:all
```

Expected: clean build. The new router isn't wired into main.tsx yet — old App still renders.

- [ ] **Step 4: Commit**

```bash
git add web/src/router.ts web/src/routes/
git commit -m "feat(web): add TanStack Router route tree with stub components"
```

---

### Task 4: Build RootLayout

**Files:**
- Modify: `web/src/routes/__root.tsx`

The RootLayout contains everything that was in App.tsx at the top level: app gates, initialization effects, SSE connection, tab badge sync, banners, the icon rail, FixJobsBanner, and KeyboardShortcutsModal.

- [ ] **Step 1: Implement RootLayout**

Replace the stub `__root.tsx` with the full implementation. Move the following from `web/src/app.tsx`:

- All imports for components used at root level (IconRail, FixJobsBanner, KeyboardShortcutsModal, SettingsView for setup gate)
- Store selectors: `appGate`, `error`, `updateAvailable`, `pullsLoading`, `showNotifBanner`, `permission`, `jobs`, `authored`, `reviewRequested`, `isWide`
- Store actions: `initialize`, `dismissUpdate`, `subscribePush`
- `useEffect` for tab badge sync (lines 103-113)
- `useEffect` for `initialize()` (lines 116-118)
- `useEffect` for SSE + teardowns (lines 121-141)
- Gate rendering: loading, setup, pullsLoading, error (lines 151-180)
- Banners: notification, permission denied, update available (lines 185-220)
- FixJobsBanner and KeyboardShortcutsModal (rendered after `<Outlet />`)

**Key structure:**

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAppStore, selectShowNotifBanner } from "../store";
import { updateFaviconBadge, updateTitleBadge } from "../lib/tab-badge";
import { IconRail } from "../components/icon-rail";
import FixJobsBanner from "../components/fix-jobs-banner";
import KeyboardShortcutsModal from "../components/keyboard-shortcuts-modal";
import SettingsView from "../components/settings-view";
// ... other banner imports (X, ArrowRight, Bell, etc. from lucide-react)
// ... IconButton import

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  // Store selectors for gates, badges, banners
  const appGate = useAppStore((s) => s.appGate);
  const error = useAppStore((s) => s.error);
  // ... all gate/banner selectors from App.tsx lines 50-85

  // Store actions
  const initialize = useAppStore((s) => s.initialize);
  // ... other actions

  // Tab badge effect (from App.tsx lines 103-113)
  useEffect(() => { /* ... same as App.tsx ... */ }, [jobs, authored, reviewRequested]);

  // Initialize effect (from App.tsx lines 116-118)
  useEffect(() => { void initialize(); }, []);

  // SSE + teardowns effect (from App.tsx lines 121-141)
  useEffect(() => {
    if (appGate !== "ready") return;
    // ... same teardown setup as App.tsx
  }, [appGate]);

  // NOTE: Remove the popstate useEffect (lines 144-148) — TanStack Router handles this now.

  // Gates
  if (appGate === "loading") return <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">Starting…</div>;
  if (appGate === "setup") return <SettingsView mode="setup" />;
  if (pullsLoading) return <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">Loading pull requests...</div>;
  if (error) return <div className="h-screen flex items-center justify-center bg-gray-950 text-red-400">Error: {error}</div>;

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-200">
      {/* Banners: notification, permission, update — same JSX as App.tsx lines 185-220 */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {/* Icon rail — desktop only */}
        <div className="hidden md:flex">
          <IconRail />
        </div>
        {/* Outlet renders SidebarLayout or SettingsPage */}
        <Outlet />
      </div>
      <FixJobsBanner />
      <KeyboardShortcutsModal />
    </div>
  );
}
```

**Important:** Do NOT include the settings modal overlay (App.tsx lines 499-505) — settings is now a route.

- [ ] **Step 2: Verify build**

```bash
yarn build:all
```

Expected: clean build (router still not wired into main.tsx).

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/__root.tsx
git commit -m "feat(web): implement RootLayout with gates, badges, SSE, banners"
```

---

### Task 5: Build SidebarLayout

**Files:**
- Modify: `web/src/routes/_sidebar.tsx`

The SidebarLayout renders the sidebar panel (PR list or Tickets list depending on active route) with the mobile drawer, and an `<Outlet />` for the main content area.

- [ ] **Step 1: Implement SidebarLayout**

Move sidebar-related content from `web/src/app.tsx` (lines 221-390). This includes:
- The mobile header bar (lines 221-234)
- The mobile backdrop (lines 236-243)
- The sidebar `<div>` with conditional content:
  - Code Review mode: logo header, status bars, RepoFilter, PRList sections, MutedReviewSection
  - Tickets mode: TicketsSidebar
- The `MutedReviewSection` helper component (move from app.tsx)

**Determine which sidebar to show:** Use TanStack Router's `useMatchRoute` to check if the current route is under `/tickets`. If yes, show `TicketsSidebar`. Otherwise, show the Code Review sidebar.

```tsx
import { createRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { Route as rootRoute } from "./__root";
import {
  useAppStore,
  selectFilteredAuthored,
  selectFilteredReviewRequested,
  selectMutedReviewPulls,
  selectTimerText,
  formatDurationUntil,
} from "../store";
import RepoFilter from "../components/repo-selector";
import PRList from "../components/pr-list";
import { TicketsSidebar } from "../components/tickets-sidebar";
import { CollapsibleSection } from "../components/ui/collapsible-section";
import { IconButton } from "../components/ui/icon-button";
import { cn } from "../lib/utils";
import {
  Menu, RefreshCw, Pause, Bell, Minus, PanelLeftClose, PanelLeftOpen, HelpCircle,
} from "lucide-react";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  id: "sidebar",
  component: SidebarLayout,
});

function MutedReviewSection() {
  // Same as current App.tsx MutedReviewSection (lines 32-46)
  // ...
}

function SidebarLayout() {
  const matchRoute = useMatchRoute();
  const isTicketsRoute = matchRoute({ to: "/tickets", fuzzy: true });

  // All sidebar selectors from App.tsx...
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const mobileDrawerOpen = useAppStore((s) => s.mobileDrawerOpen);
  const isWide = useAppStore((s) => s.isWide);
  const polling = useAppStore((s) => s.polling);
  // ... etc.

  const filteredPulls = useAppStore(useShallow(selectFilteredAuthored));
  const filteredReviewPulls = useAppStore(useShallow(selectFilteredReviewRequested));
  const timerText = useAppStore(selectTimerText);

  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const fetchPulls = useAppStore((s) => s.fetchPulls);
  const permission = useAppStore((s) => s.permission);

  return (
    <>
      {/* Mobile header — same as App.tsx lines 221-234, but only for non-wide */}
      {!isWide && (
        <div className="flex shrink-0 items-center justify-between ...">
          {/* ... same mobile header JSX ... */}
        </div>
      )}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {/* Mobile backdrop — same as App.tsx lines 236-243 */}
        {!isWide && mobileDrawerOpen && (
          <button type="button" aria-label="Close menu" className="absolute inset-0 z-40 ..."
            onClick={() => setMobileDrawerOpen(false)} />
        )}
        {/* Sidebar panel — same as App.tsx lines 249-390 */}
        <div className={cn("z-50 flex shrink-0 flex-col ...", /* same classes */)}>
          {isTicketsRoute ? (
            <TicketsSidebar />
          ) : (
            <>
              {/* Code Review sidebar header, status bars, repo filter, PR lists */}
              {/* Same JSX as App.tsx lines 260-386 */}
              {/* Replace openSettings() click with navigate to /settings */}
            </>
          )}
        </div>
        {/* Main content area */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {isWide && sidebarCollapsed && (
            <IconButton description="Expand sidebar" icon={<PanelLeftOpen size={14} />}
              className="absolute left-0 top-1/2 z-10 ..." onClick={toggleSidebar} />
          )}
          <Outlet />
        </div>
      </div>
    </>
  );
}
```

**Key change:** The Settings button in the sidebar header should use `useNavigate` to navigate to `/settings` instead of calling `openSettings()`.

```tsx
import { useNavigate } from "@tanstack/react-router";
// ...
const navigate = useNavigate();
// ...
<IconButton
  description="Settings"
  icon={<Settings size={14} />}
  onClick={() => void navigate({ to: "/settings" })}
  size="sm"
/>
```

- [ ] **Step 2: Verify build**

```bash
yarn build:all
```

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/_sidebar.tsx
git commit -m "feat(web): implement SidebarLayout with PR list and tickets sidebar"
```

---

### Task 6: Build CodeReviewPage routes

**Files:**
- Modify: `web/src/routes/_sidebar/index.tsx` (code review index — `/`)
- Modify: `web/src/routes/_sidebar/code-review-repo.tsx` (`/$owner/$repo`)
- Modify: `web/src/routes/_sidebar/code-review-pr.tsx` (`/$owner/$repo/pull/$number`)
- Create: `web/src/components/code-review-detail.tsx` (shared component for the detail area)

All three code review routes render the same detail area (or empty state). The difference is what path params are available. Extract the shared detail rendering into a component.

- [ ] **Step 1: Create the shared CodeReviewDetail component**

`web/src/components/code-review-detail.tsx`:

This component receives optional `owner`, `repo`, `number`, `tab`, and `file` props and handles:
- Setting the repo filter when `owner`/`repo` are present
- Triggering PR detail fetch when `number` changes (via `useEffect`)
- Rendering the PR detail area with tab bar and tab content (from App.tsx lines 394-494)
- Rendering the empty state when no PR is selected

```tsx
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppStore } from "../store";
import PRDetail from "./pr-detail";
import FileList from "./file-list";
import DiffView from "./diff-view";
import CommentThreads from "./comment-threads";
import PROverview from "./pr-overview";
import ChecksPanel from "./checks-panel";
import { IconButton } from "./ui/icon-button";
import { PanelLeftOpen } from "lucide-react";
import { cn } from "../lib/utils";

interface Props {
  owner?: string;
  repo?: string;
  number?: number;
  tab?: "overview" | "threads" | "files" | "checks";
  file?: string;
}

export function CodeReviewDetail({ owner, repo, number, tab = "threads", file }: Props) {
  const navigate = useNavigate();
  const detail = useAppStore((s) => s.detail);
  const files = useAppStore((s) => s.files);
  const comments = useAppStore((s) => s.comments);
  const prDetailLoading = useAppStore((s) => s.prDetailLoading);
  const prToTickets = useAppStore((s) => s.prToTickets);
  const navigateToLinkedTicket = useAppStore((s) => s.navigateToLinkedTicket);

  // Fetch PR detail when path params change
  useEffect(() => {
    if (owner && repo && number) {
      const fullRepo = `${owner}/${repo}`;
      const store = useAppStore.getState();
      const current = store.selectedPR;
      if (!current || current.number !== number || current.repo !== fullRepo) {
        void store.selectPR(number, fullRepo);
      }
    } else {
      // No PR selected — clear detail
      useAppStore.setState({
        selectedPR: null,
        detail: null,
        files: [],
        comments: [],
      });
    }
  }, [owner, repo, number]);

  // Sync selected file from search params
  useEffect(() => {
    useAppStore.setState({ selectedFile: file ?? null });
  }, [file]);

  // Sync repo filter
  useEffect(() => {
    if (owner && repo) {
      useAppStore.getState().setRepoFilter(`${owner}/${repo}`);
    } else {
      useAppStore.getState().setRepoFilter("");
    }
  }, [owner, repo]);

  // Tab navigation helper — updates search params
  function setTab(newTab: "overview" | "threads" | "files" | "checks") {
    if (owner && repo && number) {
      void navigate({
        to: "/$owner/$repo/pull/$number",
        params: { owner, repo, number: String(number) },
        search: (prev) => ({ ...prev, tab: newTab }),
      });
    }
  }

  function selectFile(path: string | null) {
    if (owner && repo && number) {
      void navigate({
        to: "/$owner/$repo/pull/$number",
        params: { owner, repo, number: String(number) },
        search: (prev) => ({ ...prev, file: path ?? undefined, tab: "files" }),
      });
    }
  }

  if (prDetailLoading) {
    return <div className="flex-1 flex items-center justify-center text-gray-500">Loading...</div>;
  }

  if (!detail) {
    return <div className="flex-1 flex items-center justify-center text-gray-500">Select a pull request</div>;
  }

  return (
    <>
      <PRDetail />
      {/* Tab bar — same JSX as App.tsx lines 412-447 */}
      <div className="flex border-b border-gray-800 shrink-0">
        {([
          { id: "overview" as const, label: "Overview" },
          { id: "threads" as const, label: `Review (${comments.filter((c) => c.inReplyToId === null).length})` },
          { id: "files" as const, label: `Files (${files.length})` },
          { id: "checks" as const, label: detail.checksSummary
            ? detail.checksSummary.failure > 0
              ? `Checks (${detail.checksSummary.failure}/${detail.checksSummary.total})`
              : `Checks (${detail.checksSummary.total})`
            : "Checks" },
        ]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "px-5 py-2 text-sm transition-colors rounded-t focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950",
              tab === t.id
                ? "text-white border-b-2 border-blue-500 -mb-px"
                : "text-gray-500 hover:text-gray-300",
            )}
          >
            <span className="flex items-center gap-1.5">
              {t.id === "checks" && detail?.checksSummary && (
                <span className={cn(
                  "inline-block w-2 h-2 rounded-full",
                  detail.checksSummary.failure > 0 ? "bg-red-400" :
                  detail.checksSummary.pending > 0 ? "bg-yellow-400" :
                  "bg-green-400",
                )} />
              )}
              {t.label}
            </span>
          </button>
        ))}
      </div>
      {/* Tab content — same as App.tsx lines 450-484 */}
      {tab === "overview" && (
        <>
          <PROverview />
          {(() => {
            const prKey = `${detail.repo}#${detail.number}`;
            const linkedTicketIds = prToTickets[prKey];
            if (!linkedTicketIds?.length) return null;
            return (
              <div className="flex flex-wrap gap-2 mt-3 px-6 pb-4">
                {linkedTicketIds.map((id) => (
                  <button key={id} onClick={() => navigateToLinkedTicket(id)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-zinc-800 text-blue-400 hover:bg-zinc-700 transition-colors">
                    {id}
                  </button>
                ))}
              </div>
            );
          })()}
        </>
      )}
      {tab === "threads" && <CommentThreads />}
      {tab === "files" && (
        <>
          <FileList />
          <div className="flex-1 overflow-y-auto">
            {file ? <DiffView /> : (
              <div className="text-gray-500 text-center mt-12">Select a file to view its diff</div>
            )}
          </div>
        </>
      )}
      {tab === "checks" && <ChecksPanel />}
    </>
  );
}
```

**Note:** The `navigateToLinkedTicket` action in the store will need to be updated (in Task 9) to use router navigation instead of `set({ activeMode: "tickets" })`. For now, keep the existing store action — it will still work functionally.

- [ ] **Step 2: Update route components to use CodeReviewDetail**

`web/src/routes/_sidebar/index.tsx`:
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";
import { CodeReviewDetail } from "../../components/code-review-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "/",
  component: function CodeReviewIndex() {
    return <CodeReviewDetail />;
  },
});
```

`web/src/routes/_sidebar/code-review-repo.tsx`:
```tsx
import { createRoute, useParams } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";
import { CodeReviewDetail } from "../../components/code-review-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "$owner/$repo",
  component: function CodeReviewRepo() {
    const { owner, repo } = useParams({ from: Route.id });
    return <CodeReviewDetail owner={owner} repo={repo} />;
  },
});
```

`web/src/routes/_sidebar/code-review-pr.tsx`:
```tsx
import { createRoute, useParams, useSearch } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";
import { CodeReviewDetail } from "../../components/code-review-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "$owner/$repo/pull/$number",
  validateSearch: (search: Record<string, unknown>) => ({
    tab: (["overview", "threads", "files", "checks"].includes(search.tab as string)
      ? search.tab as "overview" | "threads" | "files" | "checks"
      : "threads"),
    file: typeof search.file === "string" ? search.file : undefined,
  }),
  component: function CodeReviewPR() {
    const { owner, repo, number } = useParams({ from: Route.id });
    const { tab, file } = useSearch({ from: Route.id });
    return (
      <CodeReviewDetail
        owner={owner}
        repo={repo}
        number={parseInt(number, 10)}
        tab={tab}
        file={file}
      />
    );
  },
});
```

- [ ] **Step 3: Verify build**

```bash
yarn build:all
```

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/_sidebar/ web/src/components/code-review-detail.tsx
git commit -m "feat(web): implement CodeReviewDetail and code review routes"
```

---

### Task 7: Build TicketsPage routes

**Files:**
- Modify: `web/src/routes/_sidebar/tickets.tsx`
- Modify: `web/src/routes/_sidebar/tickets-detail.tsx`

- [ ] **Step 1: Implement tickets routes**

`web/src/routes/_sidebar/tickets.tsx` — tickets index (no ticket selected):
```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as sidebarRoute } from "../_sidebar";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "tickets",
  component: function TicketsIndex() {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Select a ticket
      </div>
    );
  },
});
```

`web/src/routes/_sidebar/tickets-detail.tsx` — ticket detail:
```tsx
import { createRoute, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { Route as sidebarRoute } from "../_sidebar";
import { useAppStore } from "../../store";
import { TicketIssueDetail } from "../../components/ticket-issue-detail";

export const Route = createRoute({
  getParentRoute: () => sidebarRoute,
  path: "tickets/$ticketId",
  component: function TicketsDetailPage() {
    const { ticketId } = useParams({ from: Route.id });

    // Fetch ticket detail when ticketId changes
    useEffect(() => {
      if (ticketId) {
        void useAppStore.getState().selectTicket(ticketId);
      }
    }, [ticketId]);

    return <TicketIssueDetail />;
  },
});
```

- [ ] **Step 2: Verify build**

```bash
yarn build:all
```

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/_sidebar/tickets.tsx web/src/routes/_sidebar/tickets-detail.tsx
git commit -m "feat(web): implement tickets routes"
```

---

### Task 8: Build SettingsPage route

**Files:**
- Modify: `web/src/routes/settings.tsx`

- [ ] **Step 1: Implement settings route**

```tsx
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Route as rootRoute } from "./__root";
import { useAppStore } from "../store";
import SettingsView from "../components/settings-view";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: SettingsPage,
});

function SettingsPage() {
  // Load config when settings page mounts
  useEffect(() => {
    void useAppStore.getState().openSettings();
  }, []);

  return (
    <div className="flex-1 overflow-hidden">
      <SettingsView mode="settings" />
    </div>
  );
}
```

**Note:** The `SettingsView` component still has a "Close" button that calls `closeSettings()`. In Task 9, we'll update this to navigate back instead.

- [ ] **Step 2: Verify build**

```bash
yarn build:all
```

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/settings.tsx
git commit -m "feat(web): implement settings route as full page"
```

---

### Task 9: Update IconRail with Link navigation and gear icon

**Files:**
- Modify: `web/src/components/icon-rail.tsx`

- [ ] **Step 1: Rewrite IconRail with router Links**

Replace `setActiveMode` with `<Link>` components. Add gear icon at bottom. Use `useMatchRoute` for active state.

```tsx
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";

function GitPullRequestIcon({ className }: { className?: string }) {
  // Same SVG as current
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function TicketIcon({ className }: { className?: string }) {
  // Same SVG as current
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3.5a1.5 1.5 0 1 0 0 3V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V9.5a1.5 1.5 0 0 0 0-3Zm11 1H4v1h8Zm-8 3h6v1H4Zm6 3H4v1h6Z" />
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492ZM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0Z" />
      <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319Zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.421 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.421-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.318Z" />
    </svg>
  );
}

export function IconRail() {
  const hasLinearApiKey = useAppStore((s) => s.config?.hasLinearApiKey ?? false);
  const matchRoute = useMatchRoute();

  const isCodeReview = matchRoute({ to: "/", fuzzy: true }) && !matchRoute({ to: "/tickets", fuzzy: true }) && !matchRoute({ to: "/settings" });
  const isTickets = matchRoute({ to: "/tickets", fuzzy: true });
  const isSettings = matchRoute({ to: "/settings" });

  return (
    <div className="flex flex-col items-center w-12 shrink-0 bg-zinc-900 border-r border-zinc-800 py-3 gap-2">
      <Link
        to="/"
        className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
          isCodeReview
            ? "bg-zinc-700 text-white"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
        )}
        title="Code Review"
      >
        <GitPullRequestIcon />
      </Link>
      {hasLinearApiKey && (
        <Link
          to="/tickets"
          className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
            isTickets
              ? "bg-zinc-700 text-white"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          )}
          title="Tickets"
        >
          <TicketIcon />
        </Link>
      )}
      {/* Spacer */}
      <div className="flex-1" />
      {/* Settings gear at bottom */}
      <Link
        to="/settings"
        className={cn("flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
          isSettings
            ? "bg-zinc-700 text-white"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
        )}
        title="Settings"
      >
        <GearIcon />
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
yarn build:all
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/icon-rail.tsx
git commit -m "feat(web): update IconRail with router Links and gear icon"
```

---

### Task 10: Wire up RouterProvider in main.tsx (cutover)

**Files:**
- Modify: `web/src/main.tsx`

This is the cutover point. After this, App.tsx is dead code and the new route components handle everything.

- [ ] **Step 1: Update main.tsx**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- [ ] **Step 2: Verify build**

```bash
yarn build:all
```

- [ ] **Step 3: Manual smoke test**

Run `yarn dev` and verify:
- `/` loads Code Review with PR list
- Clicking a PR navigates to `/$owner/$repo/pull/$number`
- Tab switching updates `?tab=` search param
- File selection updates `?file=` search param
- Back/forward buttons work
- `/tickets` shows tickets sidebar
- `/settings` shows full-page settings
- Icon rail highlights correctly for each route
- Gear icon visible at bottom of icon rail

- [ ] **Step 4: Commit**

```bash
git add web/src/main.tsx
git commit -m "feat(web): wire RouterProvider in main.tsx — cutover from App component"
```

---

### Task 11: Migrate Zustand state — remove URL-derived state

**Files:**
- Modify: `web/src/store/types.ts`
- Modify: `web/src/store/pr-detail-slice.ts`
- Modify: `web/src/store/ui-slice.ts`
- Modify: `web/src/store/tickets-slice.ts`
- Modify: `web/src/components/settings-view.tsx`
- Modify: any component still using old state/actions

- [ ] **Step 1: Clean up prDetailSlice**

In `web/src/store/pr-detail-slice.ts`:
- Remove `import { parseRoute, pushRoute } from "../router"` (the old router)
- Remove `handlePopState` action entirely — TanStack Router handles this
- In `selectPR`: remove the `pushRoute()` call (line 97). The route components trigger `selectPR` in response to route params, so the URL is already correct.
- In `selectFile`: remove the `pushRoute()` call (line 124). The route component handles URL updates.
- Keep `selectedPR`, `selectedFile`, `activeTab` as Zustand state for now — they're still read by many components. The route components set them via `useEffect`. Over time these can be removed, but that's a larger refactor and not needed for this task.

In `web/src/store/types.ts`:
- Remove `handlePopState` from `PrDetailSlice`
- Remove `showSettings`, `openSettings`, `closeSettings` from `UiSlice` (but keep `openSettings` as a data-loading action — rename to `loadSettingsConfig`)
- Remove `activeMode`, `setActiveMode` from `TicketsSlice`

- [ ] **Step 2: Clean up uiSlice**

In `web/src/store/ui-slice.ts`:
- Remove `showSettings` state
- Rename `openSettings` to `loadSettingsConfig` — keep the config-fetching logic, just remove the `showSettings: true` set call
- Remove `closeSettings` — navigation handles this now
- In `submitSettings`: remove `showSettings: false` sets. Instead, after successful save, the settings route component should navigate away. For now, just remove the showSettings references.
- In `initKeyboardListener`: the `[` and `]` keyboard shortcuts call `selectPR()`. These will need to use router navigation instead. Update to use `router.navigate()`:

```typescript
import { router } from "../router";
// ...
if (next) {
  const [owner, repo] = next.repo.split("/");
  void router.navigate({
    to: "/$owner/$repo/pull/$number",
    params: { owner: owner!, repo: repo!, number: String(next.number) },
  });
}
```

- [ ] **Step 3: Clean up ticketsSlice**

In `web/src/store/tickets-slice.ts`:
- Remove `activeMode` state and `setActiveMode` action
- Update `navigateToLinkedPR` to use router navigation:

```typescript
import { router } from "../router";
// ...
navigateToLinkedPR: (number, repo) => {
  const [owner, repoName] = repo.split("/");
  void router.navigate({
    to: "/$owner/$repo/pull/$number",
    params: { owner: owner!, repo: repoName!, number: String(number) },
  });
},
navigateToLinkedTicket: (identifier) => {
  const issue = get().myTickets.find((t) => t.identifier === identifier)
    ?? get().repoLinkedTickets.find((t) => t.identifier === identifier);
  if (issue) {
    void router.navigate({
      to: "/tickets/$ticketId",
      params: { ticketId: issue.id },
    });
    get().selectTicket(issue.id);
  }
},
```

- [ ] **Step 4: Update SettingsView**

In `web/src/components/settings-view.tsx`:
- Replace `closeSettings` with router navigation:

```tsx
import { useNavigate } from "@tanstack/react-router";
// ...
const navigate = useNavigate();
// Replace closeSettings() calls with:
void navigate({ to: "/" });
```

- Update `submitSettings` in the store: after successful save, don't clear `showSettings`. The settings page component will handle navigation after save.

- [ ] **Step 5: Delete old router.ts references**

Verify no file still imports from the old `web/src/router.ts`. The file itself was already overwritten in Task 3 with TanStack Router content.

- [ ] **Step 6: Verify build**

```bash
yarn build:all
```

- [ ] **Step 7: Run tests**

```bash
yarn test
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(web): migrate URL state from Zustand to TanStack Router"
```

---

### Task 12: Delete App.tsx and clean up dead code

**Files:**
- Delete: `web/src/app.tsx`

- [ ] **Step 1: Delete app.tsx**

```bash
rm web/src/app.tsx
```

- [ ] **Step 2: Remove any remaining imports of App**

Search for any leftover `import App from "./app"` or similar. There should be none after Task 10 updated main.tsx.

```bash
cd /Users/lex/src/cr-watch && grep -r "from.*['\"].*app['\"]" web/src/ --include="*.ts" --include="*.tsx" || echo "No remaining App imports"
```

- [ ] **Step 3: Verify build**

```bash
yarn build:all
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(web): delete App.tsx — fully replaced by route components"
```

---

### Task 13: Decompose CommentThreads

**Files:**
- Create: `web/src/components/thread-utils.ts`
- Create: `web/src/components/thread-filters.tsx`
- Create: `web/src/components/thread-item.tsx`
- Modify: `web/src/components/comment-threads.tsx`

- [ ] **Step 1: Extract thread-utils.ts**

Move from `comment-threads.tsx`:
- `Thread` interface (lines 53-57)
- `buildThreads()` function (lines 59-88)
- `isSnoozed()` function (lines 90-94)
- `buildEditorUri()` function (lines 33-51)
- `EDITOR_LABELS` constant (lines 23-31)
- `EvalBadge` component (lines 96-112)
- `ThreadStatusBadge` component (lines 114-120)

```typescript
// web/src/components/thread-utils.ts
import type { ReviewComment } from "../types";
import { StatusBadge } from "./ui/status-badge";
import { Check } from "lucide-react";

export interface Thread {
  root: ReviewComment;
  replies: ReviewComment[];
  isResolved: boolean;
}

export const EDITOR_LABELS: Record<string, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  webstorm: "WebStorm",
  idea: "IDEA",
  zed: "Zed",
  sublime: "Sublime",
  windsurf: "Windsurf",
};

export function buildEditorUri(editor: string, absPath: string, line: number): string {
  // Same switch statement as current lines 33-51
  // ...
}

export function buildThreads(comments: ReviewComment[]): Thread[] {
  // Same implementation as current lines 59-88
  // ...
}

export function isSnoozed(c: ReviewComment): boolean {
  if (!c.snoozeUntil) return false;
  const t = new Date(c.snoozeUntil).getTime();
  return Number.isFinite(t) && t > Date.now();
}

export function EvalBadge({ action }: { action: string }) {
  // Same as current lines 96-112
  // ...
}

export function ThreadStatusBadge({ status }: { status: string }) {
  // Same as current lines 114-120
  // ...
}
```

- [ ] **Step 2: Extract thread-filters.tsx**

Move the filter/search bar and bulk actions toolbar from `comment-threads.tsx` (lines 731-804).

```tsx
// web/src/components/thread-filters.tsx
import { useAppStore } from "../store";
import { Checkbox } from "./ui/checkbox";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { HelpCircle } from "lucide-react";
import { cn } from "../lib/utils";

interface ThreadFiltersProps {
  actionableCount: number;
  allSelected: boolean;
  selectedCount: number;
  batching: boolean;
  onToggleSelectAll: () => void;
  onBatchAction: (action: "reply" | "resolve" | "dismiss") => void;
}

export function ThreadFilters({
  actionableCount, allSelected, selectedCount, batching,
  onToggleSelectAll, onBatchAction,
}: ThreadFiltersProps) {
  const filterText = useAppStore((s) => s.threadFilterText);
  const filterAction = useAppStore((s) => s.threadFilterAction);
  const showSnoozed = useAppStore((s) => s.threadShowSnoozed);
  const setFilterText = useAppStore((s) => s.setThreadFilterText);
  const setFilterAction = useAppStore((s) => s.setThreadFilterAction);
  const setShowSnoozed = useAppStore((s) => s.setThreadShowSnoozed);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const toggleShortcuts = useAppStore((s) => s.toggleShortcuts);

  return (
    <>
      {/* Search/filter bar — same JSX as current lines 732-778 */}
      <div className="px-6 py-1.5 flex items-center gap-2 border-b border-gray-800/50 bg-gray-900/20">
        {/* ... input, filter buttons, snoozed checkbox, keys help ... */}
      </div>
      {/* Bulk action toolbar — same JSX as current lines 780-804 */}
      {actionableCount > 0 && (
        <div className="px-6 py-1.5 flex items-center gap-3 border-b border-gray-800/50 bg-gray-900/30">
          {/* ... select all checkbox, batch action buttons ... */}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Extract thread-item.tsx**

Move `ThreadItem` component (lines 185-556) and `FixConversation` component (lines 122-183) from `comment-threads.tsx`.

```tsx
// web/src/components/thread-item.tsx
import React, { useEffect, useLayoutEffect } from "react";
import { useAppStore } from "../store";
import Comment from "./comment";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { StatusBadge } from "./ui/status-badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { ChevronRight, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import type { Thread } from "./thread-utils";
import { EDITOR_LABELS, buildEditorUri, EvalBadge, ThreadStatusBadge, isSnoozed } from "./thread-utils";

// ThreadKeyActions type
export type ThreadKeyActions = {
  toggleExpand: () => void;
  reply: () => void;
  resolve: () => void;
  dismiss: () => void;
  fix: () => void;
  reEvaluate: () => void;
};

function FixConversation({ commentId, repo }: { commentId: number; repo: string }) {
  // Same as current lines 122-183
  // ...
}

export function ThreadItem({ rootId, thread, fixBlocked, queuedCommentIds, isFocused, registerRowEl, threadActionsRef }: {
  rootId: number;
  thread: Thread;
  fixBlocked: boolean;
  queuedCommentIds: number[];
  isFocused: boolean;
  registerRowEl: (id: number, el: HTMLDivElement | null) => void;
  threadActionsRef: React.RefObject<Map<number, ThreadKeyActions>>;
}) {
  // Same as current lines 185-556
  // Note: selectFile and setActiveTab calls should use router navigation
  // For selectFile: use the navigate function from router to update search params
  // ...
}
```

**Important:** The `ThreadItem` currently calls `selectFile` and `setActiveTab` from the store. These should eventually use router navigation, but for now they can still call the store actions since the store still has these. The CodeReviewDetail component syncs store state with route params.

- [ ] **Step 4: Update comment-threads.tsx to import from new files**

Slim down `comment-threads.tsx` to ~150 lines — it keeps the main `CommentThreads` export with:
- The thread list rendering
- Keyboard navigation logic (j/k, enter/space, action keys)
- The `useEffect` hooks for focus management

```tsx
// web/src/components/comment-threads.tsx
import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { CollapsibleSection } from "./ui/collapsible-section";
import { Checkbox } from "./ui/checkbox";
import type { Thread } from "./thread-utils";
import { buildThreads, isSnoozed } from "./thread-utils";
import { ThreadFilters } from "./thread-filters";
import { ThreadItem, type ThreadKeyActions } from "./thread-item";

export default function CommentThreads() {
  // Same store selectors as current lines 559-577
  // Same refs as current lines 578-581
  // Same thread building + filtering as current lines 583-593
  // Same effects as current lines 595-688
  // Same render as current lines 692-835, but using:
  //   - <ThreadFilters ... /> for the filter bar + bulk toolbar
  //   - <ThreadItem ... /> for each thread row
  // ...
}
```

- [ ] **Step 5: Verify build**

```bash
yarn build:all
```

- [ ] **Step 6: Commit**

```bash
git add web/src/components/thread-utils.ts web/src/components/thread-filters.tsx web/src/components/thread-item.tsx web/src/components/comment-threads.tsx
git commit -m "refactor(web): decompose CommentThreads into focused files"
```

---

### Task 14: Decompose FixJobsBanner

**Files:**
- Create: `web/src/components/fix-job-row.tsx`
- Create: `web/src/components/fix-job-modal.tsx`
- Modify: `web/src/components/fix-jobs-banner.tsx`

- [ ] **Step 1: Extract fix-job-row.tsx**

Move `JobRow` component (lines 306-337) and shared helpers.

```tsx
// web/src/components/fix-job-row.tsx
import type { FixJobStatus } from "../api";
import { Clock, Check, X, HelpCircle } from "lucide-react";
import { cn } from "../lib/utils";

export function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export const statusColors: Record<string, string> = {
  running: "text-yellow-400",
  completed: "text-green-400",
  failed: "text-red-400",
  no_changes: "text-blue-400",
  awaiting_response: "text-indigo-400",
};

const statusIcons: Record<string, React.ReactNode> = {
  running: <Clock size={12} />,
  completed: <Check size={12} />,
  failed: <X size={12} />,
  no_changes: <HelpCircle size={12} />,
  awaiting_response: <HelpCircle size={12} />,
};

export function FixJobRow({ job, onSelect }: { job: FixJobStatus; onSelect: () => void }) {
  // Same as current lines 306-337, using the shared helpers above
  // ...
}
```

- [ ] **Step 2: Extract fix-job-modal.tsx**

Move `JobModal` component (lines 17-304).

```tsx
// web/src/components/fix-job-modal.tsx
import { useAppStore } from "../store";
import { X } from "lucide-react";
import { IconButton } from "./ui/icon-button";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { elapsed, statusColors } from "./fix-job-row";

export function FixJobModal({ commentId }: { commentId: number }) {
  // Same as current lines 17-304
  // Uses `elapsed` and `statusColors` imported from fix-job-row
  // ...
}
```

- [ ] **Step 3: Slim down fix-jobs-banner.tsx**

```tsx
// web/src/components/fix-jobs-banner.tsx
import { useAppStore } from "../store";
import { ListOrdered } from "lucide-react";
import { FixJobRow } from "./fix-job-row";
import { FixJobModal } from "./fix-job-modal";

export default function FixJobsBanner() {
  const fixJobs = useAppStore((s) => s.jobs);
  const selectedJobId = useAppStore((s) => s.selectedJobId);
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId);
  const queue = useAppStore((s) => s.queue);
  const cancelQueued = useAppStore((s) => s.cancelQueued);

  if (fixJobs.length === 0 && queue.length === 0) return null;

  const running = fixJobs.filter((j) => j.status === "running").length;
  const awaiting = fixJobs.filter((j) => j.status === "awaiting_response").length;
  const completed = fixJobs.filter((j) => j.status === "completed").length;
  const failed = fixJobs.filter((j) => j.status === "failed").length;
  const noChanges = fixJobs.filter((j) => j.status === "no_changes").length;

  return (
    <>
      <div className="border-t border-gray-800 bg-gray-900/80 shrink-0">
        {/* Status summary bar — same as current lines 357-365 */}
        {/* Job list — same as current lines 366-369, using <FixJobRow /> */}
        {/* Queue list — same as current lines 370-387 */}
      </div>
      {selectedJobId != null && <FixJobModal commentId={selectedJobId} />}
    </>
  );
}
```

- [ ] **Step 4: Verify build**

```bash
yarn build:all
```

- [ ] **Step 5: Commit**

```bash
git add web/src/components/fix-job-row.tsx web/src/components/fix-job-modal.tsx web/src/components/fix-jobs-banner.tsx
git commit -m "refactor(web): decompose FixJobsBanner into focused files"
```

---

### Task 15: Final verification and cleanup

**Files:**
- Possibly modify: any files with lingering issues

- [ ] **Step 1: Full build**

```bash
yarn build:all
```

- [ ] **Step 2: Run tests**

```bash
yarn test
```

- [ ] **Step 3: Check for dead imports**

```bash
cd /Users/lex/src/cr-watch
grep -r "from.*router.*parseRoute\|from.*router.*pushRoute\|from.*router.*replaceRoute\|from.*router.*buildPath" web/src/ --include="*.ts" --include="*.tsx" || echo "No old router imports"
grep -r "from.*['\"].*App['\"]" web/src/ --include="*.ts" --include="*.tsx" || echo "No App imports"
grep -r "activeMode" web/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules || echo "No activeMode references"
grep -r "showSettings" web/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules || echo "No showSettings references"
```

Fix any remaining references.

- [ ] **Step 4: Manual smoke test**

Comprehensive test:
1. Navigate to `/` — see PR list, select a PR
2. URL updates to `/$owner/$repo/pull/$number`
3. Click "Files" tab — URL updates to `?tab=files`
4. Select a file — URL updates to `?tab=files&file=path`
5. Browser back — returns to previous tab
6. Navigate to `/tickets` — sidebar switches to tickets
7. Select a ticket — URL updates to `/tickets/$ticketId`
8. Click gear icon — navigates to `/settings`
9. Save settings — navigates back
10. Browser back/forward works throughout
11. Direct URL entry works (paste a PR URL, loads correctly)
12. Mobile responsive layout still works

- [ ] **Step 5: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "refactor(web): final cleanup for App.tsx refactor"
```
