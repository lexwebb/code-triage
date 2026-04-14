# Zustand Centralized Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all frontend state management with a single Zustand store, eliminating prop drilling, sessionStorage/localStorage, and component-local useState.

**Architecture:** Single Zustand store with 7 slices (app, pulls, prDetail, pollStatus, fixJobs, notifications, ui), combined via slice pattern. `subscribeWithSelector` middleware enables notification diffing. Store owns all data fetching, SSE, and side effects. Components become pure views.

**Tech Stack:** Zustand 5.x, React 19, TypeScript, ESM

**Spec:** `docs/superpowers/specs/2026-04-14-zustand-store-design.md`

---

### Task 1: Install Zustand and create store skeleton

**Files:**
- Modify: `web/package.json`
- Create: `web/src/store/index.ts`
- Create: `web/src/store/types.ts`

- [ ] **Step 1: Install Zustand**

```bash
cd web && yarn add zustand
```

- [ ] **Step 2: Create store types file**

Create `web/src/store/types.ts`:

```typescript
import type { StateCreator } from "zustand";
import type {
  RepoInfo,
  PullRequest,
  PullRequestDetail,
  PullFile,
  ReviewComment,
  CheckSuite,
} from "../types";
import type {
  FixJobStatus,
  AppConfigPayload,
  ConfigGetResponse,
  PollStatus,
} from "../api";

// ── App Slice ──

export interface AppSlice {
  appGate: "loading" | "setup" | "ready";
  error: string | null;
  config: AppConfigPayload | null;
  setupConfig: ConfigGetResponse | null;
  preferredEditor: string;
  currentUser: string | null;
  repos: RepoInfo[];
  updateAvailable: { behind: number; localSha: string; remoteSha: string } | null;

  initialize: () => Promise<void>;
  saveConfig: (body: Record<string, unknown>) => Promise<{ restartRequired: boolean }>;
  dismissUpdate: () => void;
}

// ── Pulls Slice ──

export interface PullsSlice {
  authored: PullRequest[];
  reviewRequested: PullRequest[];
  repoFilter: string;
  pullsLoading: boolean;
  pullsRefreshing: boolean;
  githubUserUnavailable: boolean;
  pullFetchGeneration: number;
  _fetchInFlight: Promise<void> | null;

  fetchPulls: (isInitial?: boolean, resetRepoPollOnRefresh?: boolean) => Promise<void>;
  setRepoFilter: (filter: string) => void;
}

// ── PR Detail Slice ──

export interface PrDetailSlice {
  selectedPR: { number: number; repo: string } | null;
  detail: PullRequestDetail | null;
  files: PullFile[];
  comments: ReviewComment[];
  selectedFile: string | null;
  activeTab: "overview" | "threads" | "files" | "checks";
  prDetailLoading: boolean;

  // Review form
  reviewBody: string;
  showRequestChanges: boolean;
  reviewSubmitting: boolean;
  reviewError: string | null;

  // Thread UI
  threadFilterText: string;
  threadFilterAction: "all" | "fix" | "reply" | "resolve";
  threadShowSnoozed: boolean;
  threadFocusedIdx: number | null;
  threadSelected: Set<number>;
  threadBatching: boolean;
  expandedThreads: Set<number>;
  actingThreads: Set<number>;
  showSuggestionThreads: Set<number>;
  triageBusyThreads: Set<number>;
  noteDrafts: Record<number, string>;
  priorityDrafts: Record<number, string>;
  fixingThreads: Set<number>;
  fixErrors: Record<number, string | null>;
  fixModalOpenThreads: Set<number>;
  threadFixInstructions: Record<number, string>;
  reEvaluatingThreads: Set<number>;

  // Diff view
  commentingLine: { line: number; side: "LEFT" | "RIGHT" } | null;
  commentBody: string;
  commentSubmitting: boolean;

  // Checks
  checkSuites: CheckSuite[] | null;
  checksError: string | null;
  checksKey: string;

  selectPR: (number: number, repo: string) => Promise<void>;
  selectFile: (filename: string | null) => void;
  setActiveTab: (tab: PrDetailSlice["activeTab"]) => void;
  reloadComments: () => Promise<void>;
  refreshIfMatch: (repo: string, prNumber: number) => Promise<void>;
  handlePopState: () => void;
  submitReview: (event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body?: string) => Promise<void>;
  setReviewBody: (text: string) => void;
  setShowRequestChanges: (show: boolean) => void;

  // Thread actions
  setThreadFilterText: (text: string) => void;
  setThreadFilterAction: (action: PrDetailSlice["threadFilterAction"]) => void;
  setThreadShowSnoozed: (show: boolean) => void;
  setThreadFocusedIdx: (idx: number | null) => void;
  toggleThreadSelected: (id: number) => void;
  selectAllThreads: (ids: number[]) => void;
  clearThreadSelected: () => void;
  toggleThreadExpanded: (id: number) => void;
  setShowSuggestion: (id: number, show: boolean) => void;
  setNoteDraft: (id: number, text: string) => void;
  setPriorityDraft: (id: number, text: string) => void;
  setFixModalOpen: (id: number, open: boolean) => void;
  setThreadFixInstructions: (id: number, text: string) => void;

  // Thread API actions
  replyToComment: (commentId: number) => Promise<void>;
  resolveComment: (commentId: number) => Promise<void>;
  dismissComment: (commentId: number) => Promise<void>;
  reEvaluateComment: (commentId: number) => Promise<void>;
  updateCommentTriage: (commentId: number, patch: { snoozeUntil?: string | null; priority?: number | null; triageNote?: string | null }) => Promise<void>;
  startFix: (commentId: number, comment: { path: string; line: number; body: string; diffHunk: string }, userInstructions?: string) => Promise<void>;
  batchAction: (action: "reply" | "resolve" | "dismiss") => Promise<void>;

  // Diff actions
  setCommentingLine: (line: { line: number; side: "LEFT" | "RIGHT" } | null) => void;
  setCommentBody: (body: string) => void;
  submitInlineComment: (commitId: string, filename: string) => Promise<void>;

  // Checks actions
  fetchChecks: (headSha?: string) => Promise<void>;
}

// ── Poll Status Slice ──

export interface PollStatusSlice {
  polling: boolean;
  intervalMs: number;
  baseIntervalMs: number | null;
  estimatedGithubRequestsPerHour: number | null;
  estimatedPollRequests: number | null;
  pollBudgetNote: string | null;
  pollPaused: boolean;
  pollPausedReason: string | null;
  rateLimited: boolean;
  rateLimitResetAt: number | null;
  rateLimitRemaining: number | null;
  rateLimitLimit: number | null;
  rateLimitResource: string | null;
  lastPollError: string | null;
  claude: {
    activeEvals: number;
    activeFixJobs: number;
    evalConcurrencyCap: number;
    totalEvalsThisSession: number;
    totalFixesThisSession: number;
  } | null;
  nextPollDeadline: number;
  countdown: number;
  rateLimitNow: number;
  _eventSource: EventSource | null;
  _countdownInterval: ReturnType<typeof setInterval> | null;
  _rateLimitPollInterval: ReturnType<typeof setInterval> | null;
  _lastPoll: number;

  connectSSE: () => () => void;
  disconnectSSE: () => void;
  fetchInitialStatus: () => Promise<void>;
  applyPollStatus: (status: PollStatus) => void;
  startCountdownTimer: () => () => void;
  stopCountdownTimer: () => void;
  startRateLimitPoller: () => () => void;
  stopRateLimitPoller: () => void;
}

// ── Fix Jobs Slice ──

export interface FixJobsSlice {
  jobs: FixJobStatus[];
  replyText: Record<number, string>;
  noChangesReply: Record<number, string>;
  acting: Record<number, boolean>;
  selectedJobId: number | null;

  setJobs: (jobs: FixJobStatus[]) => void;
  setReplyText: (commentId: number, text: string) => void;
  setNoChangesReply: (commentId: number, text: string) => void;
  setSelectedJobId: (id: number | null) => void;
  apply: (repo: string, commentId: number, prNumber: number, branch: string) => Promise<void>;
  discard: (branch: string, commentId?: number) => Promise<void>;
  sendReply: (repo: string, commentId: number, message: string) => Promise<void>;
  sendReplyAndResolve: (repo: string, commentId: number, prNumber: number, replyBody: string) => Promise<void>;
  retryFix: (repo: string, commentId: number, prNumber: number, branch: string, originalComment: { path: string; line: number; body: string; diffHunk: string }) => Promise<void>;
}

// ── Notifications Slice ──

export interface NotificationsSlice {
  mutedPRs: Set<string>;
  permission: NotificationPermission;
  initialized: boolean;
  commentBaselineReady: boolean;
  _previousReviewPRKeys: Set<string>;
  _previousCommentKeys: Set<string>;
  _previousPendingKeys: Set<string>;
  _previousChecksStatus: Map<string, string>;
  _previousOpenComments: Map<string, number>;
  _lastReviewReminder: number;
  _reminderInterval: ReturnType<typeof setInterval> | null;
  _permissionInterval: ReturnType<typeof setInterval> | null;

  initializeBaseline: () => Promise<void>;
  diffAndNotify: () => Promise<void>;
  mutePR: (repo: string, number: number) => void;
  unmutePR: (repo: string, number: number) => void;
  isPRMuted: (repo: string, number: number) => boolean;
  requestPermission: () => Promise<void>;
  testNotification: () => void;
  startReminderInterval: () => () => void;
  checkPermissionPeriodically: () => () => void;
}

// ── UI Slice ──

export interface UiSlice {
  sidebarCollapsed: boolean;
  mobileDrawerOpen: boolean;
  isWide: boolean;
  showSettings: boolean;
  settingsConfig: ConfigGetResponse | null;
  shortcutsOpen: boolean;

  // Settings form
  settingsForm: SettingsFormState | null;
  settingsSaving: boolean;
  settingsError: string | null;
  settingsRestartHint: boolean;

  toggleSidebar: () => void;
  setMobileDrawerOpen: (open: boolean) => void;
  openSettings: () => Promise<void>;
  closeSettings: () => void;
  toggleShortcuts: () => void;
  initMediaQuery: () => () => void;
  initKeyboardListener: () => () => void;

  // Settings form actions
  setSettingsForm: (form: SettingsFormState) => void;
  updateSettingsField: <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => void;
  submitSettings: () => Promise<void>;
}

export interface SettingsFormState {
  root: string;
  port: number;
  interval: number;
  evalConcurrency: number;
  pollReviewRequested: boolean;
  commentRetentionDays: number;
  repoPollStaleAfterDays: number;
  repoPollColdIntervalMinutes: number;
  pollApiHeadroom: number;
  pollRateLimitAware: boolean;
  preferredEditor: string;
  ignoredBots: string;
  githubToken: string;
  hasGithubToken: boolean;
  accounts: Array<{ name: string; orgs: string; token: string; hasToken: boolean }>;
  evalPromptAppend: string;
  evalPromptAppendByRepoJson: string;
  evalClaudeExtraArgsJson: string;
  fixConversationMaxTurns: number;
}

// ── Combined Store ──

export type AppStore = AppSlice &
  PullsSlice &
  PrDetailSlice &
  PollStatusSlice &
  FixJobsSlice &
  NotificationsSlice &
  UiSlice;

export type SliceCreator<T> = StateCreator<AppStore, [["zustand/subscribeWithSelector", never]], [], T>;
```

- [ ] **Step 3: Create store index**

Create `web/src/store/index.ts`:

```typescript
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AppStore } from "./types";
import { createAppSlice } from "./appSlice";
import { createPullsSlice } from "./pullsSlice";
import { createPrDetailSlice } from "./prDetailSlice";
import { createPollStatusSlice } from "./pollStatusSlice";
import { createFixJobsSlice } from "./fixJobsSlice";
import { createNotificationsSlice } from "./notificationsSlice";
import { createUiSlice } from "./uiSlice";

export const useAppStore = create<AppStore>()(
  subscribeWithSelector((...a) => ({
    ...createAppSlice(...a),
    ...createPullsSlice(...a),
    ...createPrDetailSlice(...a),
    ...createPollStatusSlice(...a),
    ...createFixJobsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createUiSlice(...a),
  })),
);

// ── Derived selectors ──

export function selectFilteredAuthored(s: AppStore) {
  if (!s.repoFilter) return s.authored;
  const lower = s.repoFilter.toLowerCase();
  return s.authored.filter(
    (pr) => pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower),
  );
}

export function selectFilteredReviewRequested(s: AppStore) {
  const base = s.repoFilter
    ? s.reviewRequested.filter((pr) => {
        const lower = s.repoFilter.toLowerCase();
        return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
      })
    : s.reviewRequested;
  return base.filter((pr) => !s.mutedPRs.has(`${pr.repo}:${pr.number}`));
}

export function selectMutedReviewPulls(s: AppStore) {
  const base = s.repoFilter
    ? s.reviewRequested.filter((pr) => {
        const lower = s.repoFilter.toLowerCase();
        return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
      })
    : s.reviewRequested;
  return base.filter((pr) => s.mutedPRs.has(`${pr.repo}:${pr.number}`));
}

export function selectFlatPulls(s: AppStore) {
  return [...selectFilteredAuthored(s), ...selectFilteredReviewRequested(s)];
}

export function selectTimerText(s: AppStore) {
  const minutes = Math.floor(s.countdown / 60000);
  const seconds = Math.floor((s.countdown % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function selectShowNotifBanner(s: AppStore) {
  return s.permission === "default";
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd /Users/lex/src/cr-watch && yarn build:all
```

Note: This will fail until slices are created. That's expected — proceed to Task 2.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/yarn.lock web/src/store/
git commit -m "feat: install zustand, create store skeleton and types"
```

---

### Task 2: Create appSlice

**Files:**
- Create: `web/src/store/appSlice.ts`

- [ ] **Step 1: Create appSlice**

```typescript
import { api } from "../api";
import type { SliceCreator, AppSlice } from "./types";
import { payloadToForm } from "./settingsForm";

export const createAppSlice: SliceCreator<AppSlice> = (set, get) => ({
  appGate: "loading",
  error: null,
  config: null,
  setupConfig: null,
  preferredEditor: "vscode",
  currentUser: null,
  repos: [],
  updateAvailable: null,

  initialize: async () => {
    try {
      const r = await api.getConfig();
      set({
        setupConfig: r,
        config: r.config,
        preferredEditor: r.config.preferredEditor ?? "vscode",
        appGate: r.needsSetup ? "setup" : "ready",
        // For setup mode, initialize settings form so SettingsView can render immediately
        ...(r.needsSetup ? { settingsConfig: r, settingsForm: payloadToForm(r.config) } : {}),
      });

      if (r.needsSetup) return;

      // Parallel init fetches
      const [, , ,] = await Promise.allSettled([
        api.getUser().then((u) => set({ currentUser: u.login || null })),
        api.getRepos().then((repos) => set({ repos })),
        get().fetchPulls(true),
        api.getVersion().then((v) => {
          if (v.behind > 0) set({ updateAvailable: v });
        }),
      ]);
    } catch (err) {
      set({ error: (err as Error).message, appGate: "ready" });
    }
  },

  saveConfig: async (body) => {
    const result = await api.saveConfig(body);
    if (typeof body.preferredEditor === "string") {
      set({ preferredEditor: body.preferredEditor });
    }
    // Refresh repos and pulls after config change
    await Promise.allSettled([
      api.getRepos().then((repos) => set({ repos })),
      get().fetchPulls(false),
    ]);
    return result;
  },

  dismissUpdate: () => set({ updateAvailable: null }),
});
```

- [ ] **Step 2: Commit**

```bash
git add web/src/store/appSlice.ts
git commit -m "feat: create app slice with initialize and saveConfig"
```

---

### Task 3: Create pullsSlice

**Files:**
- Create: `web/src/store/pullsSlice.ts`

- [ ] **Step 1: Create pullsSlice**

```typescript
import { api } from "../api";
import type { SliceCreator, PullsSlice } from "./types";

export const createPullsSlice: SliceCreator<PullsSlice> = (set, get) => ({
  authored: [],
  reviewRequested: [],
  repoFilter: "",
  pullsLoading: true,
  pullsRefreshing: false,
  githubUserUnavailable: false,
  pullFetchGeneration: 0,
  _fetchInFlight: null,

  fetchPulls: async (isInitial = false, resetRepoPollOnRefresh = false) => {
    // Coalesce overlapping fetches
    const existing = get()._fetchInFlight;
    if (existing) return existing;

    const run = (async () => {
      if (!isInitial) set({ pullsRefreshing: true });
      try {
        if (resetRepoPollOnRefresh) {
          await api.clearRepoPollSchedule();
        }
        const { authored, reviewRequested, githubUserUnavailable } =
          await api.getPullsBundle();
        set((s) => ({
          authored,
          reviewRequested,
          githubUserUnavailable: githubUserUnavailable === true,
          pullFetchGeneration: s.pullFetchGeneration + 1,
        }));

        // Auto-select first PR on initial load if nothing selected
        if (isInitial && authored.length > 0 && !get().selectedPR) {
          void get().selectPR(authored[0].number, authored[0].repo);
        }
      } catch (err) {
        if (isInitial) set({ error: (err as Error).message });
      } finally {
        if (isInitial) set({ pullsLoading: false });
        set({ pullsRefreshing: false });
      }
    })();

    set({ _fetchInFlight: run });
    try {
      await run;
    } finally {
      set({ _fetchInFlight: null });
    }
  },

  setRepoFilter: (filter) => set({ repoFilter: filter }),
});
```

- [ ] **Step 2: Commit**

```bash
git add web/src/store/pullsSlice.ts
git commit -m "feat: create pulls slice with fetch coalescing"
```

---

### Task 4: Create prDetailSlice

**Files:**
- Create: `web/src/store/prDetailSlice.ts`

- [ ] **Step 1: Create prDetailSlice**

```typescript
import { api } from "../api";
import { parseRoute, pushRoute } from "../router";
import type { SliceCreator, PrDetailSlice } from "./types";

export const createPrDetailSlice: SliceCreator<PrDetailSlice> = (set, get) => ({
  selectedPR: (() => {
    const initial = parseRoute();
    return initial.repo && initial.prNumber
      ? { repo: initial.repo, number: initial.prNumber }
      : null;
  })(),
  detail: null,
  files: [],
  comments: [],
  selectedFile: parseRoute().file,
  activeTab: "threads",
  prDetailLoading: false,

  // Review form
  reviewBody: "",
  showRequestChanges: false,
  reviewSubmitting: false,
  reviewError: null,

  // Thread UI
  threadFilterText: "",
  threadFilterAction: "all",
  threadShowSnoozed: false,
  threadFocusedIdx: null,
  threadSelected: new Set(),
  threadBatching: false,
  expandedThreads: new Set(),
  actingThreads: new Set(),
  showSuggestionThreads: new Set(),
  triageBusyThreads: new Set(),
  noteDrafts: {},
  priorityDrafts: {},
  fixingThreads: new Set(),
  fixErrors: {},
  fixModalOpenThreads: new Set(),
  threadFixInstructions: {},
  reEvaluatingThreads: new Set(),

  // Diff view
  commentingLine: null,
  commentBody: "",
  commentSubmitting: false,

  // Checks
  checkSuites: null,
  checksError: null,
  checksKey: "",

  selectPR: async (number, repo) => {
    set({
      selectedPR: { number, repo },
      selectedFile: null,
      detail: null,
      files: [],
      comments: [],
      prDetailLoading: true,
      // Reset thread UI state
      threadFilterText: "",
      threadFilterAction: "all",
      threadShowSnoozed: false,
      threadFocusedIdx: null,
      threadSelected: new Set(),
      threadBatching: false,
      expandedThreads: new Set(),
      actingThreads: new Set(),
      showSuggestionThreads: new Set(),
      triageBusyThreads: new Set(),
      noteDrafts: {},
      priorityDrafts: {},
      fixingThreads: new Set(),
      fixErrors: {},
      fixModalOpenThreads: new Set(),
      threadFixInstructions: {},
      reEvaluatingThreads: new Set(),
      // Reset review form
      reviewBody: "",
      showRequestChanges: false,
      reviewSubmitting: false,
      reviewError: null,
      // Reset diff
      commentingLine: null,
      commentBody: "",
      commentSubmitting: false,
      // Reset checks
      checkSuites: null,
      checksError: null,
      checksKey: "",
    });
    pushRoute({ repo, prNumber: number, file: null });

    try {
      const [detail, files, comments] = await Promise.all([
        api.getPull(number, repo),
        api.getPullFiles(number, repo),
        api.getPullComments(number, repo),
      ]);
      // Bail if user navigated away
      const current = get().selectedPR;
      if (!current || current.number !== number || current.repo !== repo) return;

      const selectedFile =
        files.find((f) => comments.some((c) => c.path === f.filename))?.filename ??
        files[0]?.filename ??
        null;

      set({ detail, files, comments, selectedFile, prDetailLoading: false });
    } catch (err) {
      console.error("Failed to load PR:", err);
      set({ prDetailLoading: false });
    }
  },

  selectFile: (filename) => {
    set({ selectedFile: filename });
    const pr = get().selectedPR;
    pushRoute({ repo: pr?.repo ?? null, prNumber: pr?.number ?? null, file: filename });
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  reloadComments: async () => {
    const pr = get().selectedPR;
    if (!pr) return;
    try {
      const comments = await api.getPullComments(pr.number, pr.repo);
      set({ comments });
    } catch (err) {
      console.error("Failed to reload comments:", err);
    }
  },

  refreshIfMatch: async (repo, prNumber) => {
    const current = get().selectedPR;
    if (!current || current.repo !== repo || current.number !== prNumber) return;
    try {
      const [detail, comments] = await Promise.all([
        api.getPull(prNumber, repo),
        api.getPullComments(prNumber, repo),
      ]);
      set({ detail, comments });
    } catch {
      /* background refresh — ignore */
    }
  },

  handlePopState: () => {
    const route = parseRoute();
    if (route.repo && route.prNumber) {
      // Only re-fetch if PR actually changed
      const current = get().selectedPR;
      if (!current || current.number !== route.prNumber || current.repo !== route.repo) {
        void get().selectPR(route.prNumber, route.repo);
      }
    } else {
      set({
        selectedPR: null,
        detail: null,
        files: [],
        comments: [],
      });
    }
    set({ selectedFile: route.file });
  },

  submitReview: async (event, body) => {
    const pr = get().selectedPR;
    const detail = get().detail;
    if (!pr || !detail) return;
    set({ reviewSubmitting: true, reviewError: null });
    try {
      await api.submitReview(pr.repo, pr.number, event, body);
      set({ showRequestChanges: false, reviewBody: "" });
      // Refresh detail to update reviewer states
      try {
        const updated = await api.getPull(pr.number, pr.repo);
        set({ detail: updated });
      } catch { /* ignore */ }
    } catch (err) {
      set({ reviewError: (err as Error).message });
    } finally {
      set({ reviewSubmitting: false });
    }
  },

  setReviewBody: (text) => set({ reviewBody: text }),
  setShowRequestChanges: (show) => set({ showRequestChanges: show }),

  // Thread UI actions
  setThreadFilterText: (text) => set({ threadFilterText: text }),
  setThreadFilterAction: (action) => set({ threadFilterAction: action }),
  setThreadShowSnoozed: (show) => set({ threadShowSnoozed: show }),
  setThreadFocusedIdx: (idx) => set({ threadFocusedIdx: idx }),

  toggleThreadSelected: (id) =>
    set((s) => {
      const next = new Set(s.threadSelected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { threadSelected: next };
    }),

  selectAllThreads: (ids) => set({ threadSelected: new Set(ids) }),
  clearThreadSelected: () => set({ threadSelected: new Set() }),

  toggleThreadExpanded: (id) =>
    set((s) => {
      const next = new Set(s.expandedThreads);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedThreads: next };
    }),

  setShowSuggestion: (id, show) =>
    set((s) => {
      const next = new Set(s.showSuggestionThreads);
      if (show) next.add(id);
      else next.delete(id);
      return { showSuggestionThreads: next };
    }),

  setNoteDraft: (id, text) =>
    set((s) => ({ noteDrafts: { ...s.noteDrafts, [id]: text } })),

  setPriorityDraft: (id, text) =>
    set((s) => ({ priorityDrafts: { ...s.priorityDrafts, [id]: text } })),

  setFixModalOpen: (id, open) =>
    set((s) => {
      const next = new Set(s.fixModalOpenThreads);
      if (open) next.add(id);
      else next.delete(id);
      return { fixModalOpenThreads: next };
    }),

  setThreadFixInstructions: (id, text) =>
    set((s) => ({ threadFixInstructions: { ...s.threadFixInstructions, [id]: text } })),

  // Thread API actions
  replyToComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ actingThreads: new Set(s.actingThreads).add(commentId) }));
    try {
      await api.replyToComment(pr.repo, commentId, pr.number);
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.actingThreads);
        next.delete(commentId);
        return { actingThreads: next };
      });
    }
  },

  resolveComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ actingThreads: new Set(s.actingThreads).add(commentId) }));
    try {
      await api.resolveComment(pr.repo, commentId, pr.number);
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.actingThreads);
        next.delete(commentId);
        return { actingThreads: next };
      });
    }
  },

  dismissComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ actingThreads: new Set(s.actingThreads).add(commentId) }));
    try {
      await api.dismissComment(pr.repo, commentId, pr.number);
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.actingThreads);
        next.delete(commentId);
        return { actingThreads: next };
      });
    }
  },

  reEvaluateComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ reEvaluatingThreads: new Set(s.reEvaluatingThreads).add(commentId) }));
    try {
      await api.reEvaluate(pr.repo, commentId, pr.number);
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.reEvaluatingThreads);
        next.delete(commentId);
        return { reEvaluatingThreads: next };
      });
    }
  },

  updateCommentTriage: async (commentId, patch) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ triageBusyThreads: new Set(s.triageBusyThreads).add(commentId) }));
    try {
      await api.updateCommentTriage(pr.repo, commentId, pr.number, patch);
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.triageBusyThreads);
        next.delete(commentId);
        return { triageBusyThreads: next };
      });
    }
  },

  startFix: async (commentId, comment, userInstructions) => {
    const pr = get().selectedPR;
    const detail = get().detail;
    if (!pr || !detail) return;
    set((s) => ({
      fixingThreads: new Set(s.fixingThreads).add(commentId),
      fixErrors: { ...s.fixErrors, [commentId]: null },
    }));
    try {
      const result = await api.fixWithClaude(
        pr.repo, commentId, pr.number, detail.branch, comment, userInstructions,
      );
      if (result.success) {
        // Optimistic: add fix job
        get().setJobs([
          ...get().jobs.filter((j) => j.commentId !== commentId),
          {
            commentId,
            repo: pr.repo,
            prNumber: pr.number,
            path: comment.path,
            startedAt: Date.now(),
            status: "running",
            branch: result.branch,
          },
        ]);
        set((s) => {
          const next = new Set(s.fixModalOpenThreads);
          next.delete(commentId);
          return { fixModalOpenThreads: next };
        });
      }
    } catch (err) {
      set((s) => ({ fixErrors: { ...s.fixErrors, [commentId]: (err as Error).message } }));
    } finally {
      set((s) => {
        const next = new Set(s.fixingThreads);
        next.delete(commentId);
        return { fixingThreads: next };
      });
    }
  },

  batchAction: async (action) => {
    const pr = get().selectedPR;
    if (!pr) return;
    const selected = get().threadSelected;
    if (selected.size === 0) return;
    set({ threadBatching: true });
    try {
      const items = [...selected].map((commentId) => ({
        repo: pr.repo,
        commentId,
        prNumber: pr.number,
      }));
      await api.batchAction(action, items);
      set({ threadSelected: new Set() });
      await get().reloadComments();
    } finally {
      set({ threadBatching: false });
    }
  },

  // Diff actions
  setCommentingLine: (line) => set({ commentingLine: line, commentBody: "" }),
  setCommentBody: (body) => set({ commentBody: body }),

  submitInlineComment: async (commitId, filename) => {
    const pr = get().selectedPR;
    const line = get().commentingLine;
    const body = get().commentBody.trim();
    if (!pr || !line || !body) return;
    set({ commentSubmitting: true });
    try {
      await api.createComment(pr.repo, pr.number, commitId, filename, line.line, line.side, body);
      set({ commentingLine: null, commentBody: "" });
      await get().reloadComments();
    } finally {
      set({ commentSubmitting: false });
    }
  },

  // Checks actions
  fetchChecks: async (headSha) => {
    const pr = get().selectedPR;
    if (!pr) return;
    const key = `${pr.repo}:${pr.number}:${headSha ?? ""}`;
    if (key === get().checksKey && get().checkSuites !== null) return;
    set({ checksKey: key, checkSuites: null, checksError: null });
    try {
      const suites = await api.getChecks(pr.number, pr.repo, headSha);
      // Bail if PR changed while loading
      if (get().checksKey !== key) return;
      set({ checkSuites: suites });
    } catch (err) {
      if (get().checksKey !== key) return;
      set({ checksError: (err as Error).message });
    }
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add web/src/store/prDetailSlice.ts
git commit -m "feat: create prDetail slice with thread, diff, and checks state"
```

---

### Task 5: Create pollStatusSlice

**Files:**
- Create: `web/src/store/pollStatusSlice.ts`

- [ ] **Step 1: Create pollStatusSlice**

```typescript
import { api } from "../api";
import type { PollStatus } from "../api";
import type { SliceCreator, PollStatusSlice } from "./types";

export const createPollStatusSlice: SliceCreator<PollStatusSlice> = (set, get) => ({
  polling: false,
  intervalMs: 0,
  baseIntervalMs: null,
  estimatedGithubRequestsPerHour: null,
  estimatedPollRequests: null,
  pollBudgetNote: null,
  pollPaused: false,
  pollPausedReason: null,
  rateLimited: false,
  rateLimitResetAt: null,
  rateLimitRemaining: null,
  rateLimitLimit: null,
  rateLimitResource: null,
  lastPollError: null,
  claude: null,
  nextPollDeadline: 0,
  countdown: 0,
  rateLimitNow: Date.now(),
  _eventSource: null,
  _countdownInterval: null,
  _rateLimitPollInterval: null,
  _lastPoll: 0,

  connectSSE: () => {
    get().disconnectSSE();
    const es = new EventSource("/api/events");

    es.addEventListener("poll-status", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { status?: PollStatus };
        if (data.status) get().applyPollStatus(data.status);
      } catch { /* ignore */ }
    });

    es.addEventListener("eval-complete", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { repo?: string; prNumber?: number };
        if (data.repo && data.prNumber) {
          void get().refreshIfMatch(data.repo, data.prNumber);
        }
      } catch { /* ignore */ }
    });

    es.onerror = () => { /* browser auto-reconnects */ };

    set({ _eventSource: es });
    return () => {
      es.close();
      set({ _eventSource: null });
    };
  },

  disconnectSSE: () => {
    const es = get()._eventSource;
    if (es) {
      es.close();
      set({ _eventSource: null });
    }
  },

  fetchInitialStatus: async () => {
    try {
      const status = await api.getPollStatus();
      get().applyPollStatus(status);
    } catch { /* ignore */ }
  },

  applyPollStatus: (status: PollStatus) => {
    const prevJobs = get().jobs;
    const prevJobMap = new Map(prevJobs.map((j) => [j.commentId, j.status]));

    set({
      nextPollDeadline: status.nextPoll,
      pullsRefreshing: status.polling,
      polling: status.polling,
      intervalMs: status.intervalMs,
      baseIntervalMs: status.baseIntervalMs ?? null,
      estimatedGithubRequestsPerHour: status.estimatedGithubRequestsPerHour ?? null,
      estimatedPollRequests: status.estimatedPollRequests ?? null,
      pollBudgetNote: status.pollBudgetNote ?? null,
      pollPaused: status.pollPaused ?? false,
      pollPausedReason: status.pollPausedReason ?? null,
      rateLimited: status.rateLimited ?? false,
      rateLimitResetAt: status.rateLimitResetAt ?? null,
      rateLimitRemaining: status.rateLimitRemaining ?? null,
      rateLimitLimit: status.rateLimitLimit ?? null,
      rateLimitResource: status.rateLimitResource ?? null,
      lastPollError: status.lastPollError ?? null,
      claude: status.claude ?? null,
    });

    get().setJobs(status.fixJobs);

    // Fire browser notifications for fix job state transitions
    for (const job of status.fixJobs) {
      const prev = prevJobMap.get(job.commentId);
      if (prev !== "running") continue;
      const repoShort = job.repo.split("/")[1] ?? job.repo;
      if (job.status === "completed" && "Notification" in window && Notification.permission === "granted") {
        new Notification(`Fix ready: ${repoShort}#${job.prNumber}`, {
          body: `${job.path} — review and apply the changes`,
        });
      } else if (job.status === "no_changes" && "Notification" in window && Notification.permission === "granted") {
        new Notification(`No changes needed: ${repoShort}#${job.prNumber}`, {
          body: `${job.path} — review suggested reply`,
        });
      } else if (job.status === "failed" && "Notification" in window && Notification.permission === "granted") {
        new Notification(`Fix failed: ${repoShort}#${job.prNumber}`, {
          body: `${job.path} — ${job.error ?? "unknown error"}`,
        });
      }
    }

    // Test notification handling
    if (status.testNotification) {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Code Triage — Test Notification", {
          body: "Notifications are working!",
          icon: "/logo.png",
        });
      }
      void api.getPollStatus().catch(() => {});
    }

    // Refresh pulls if backend has new data
    if (status.lastPoll > get()._lastPoll && get()._lastPoll > 0) {
      void get().fetchPulls();
      void get().refreshIfMatch(
        get().selectedPR?.repo ?? "",
        get().selectedPR?.number ?? 0,
      );
    }
    if (status.lastPoll > 0) {
      set({ _lastPoll: status.lastPoll });
    }
  },

  startCountdownTimer: () => {
    get().stopCountdownTimer();
    const id = setInterval(() => {
      const { nextPollDeadline, rateLimited, rateLimitResetAt } = get();
      const now = Date.now();
      if (nextPollDeadline > 0) {
        set({ countdown: Math.max(0, nextPollDeadline - now) });
      }
      if (rateLimited && rateLimitResetAt != null) {
        set({ rateLimitNow: now });
      }
    }, 1000);
    set({ _countdownInterval: id });
    return () => {
      clearInterval(id);
      set({ _countdownInterval: null });
    };
  },

  stopCountdownTimer: () => {
    const id = get()._countdownInterval;
    if (id) {
      clearInterval(id);
      set({ _countdownInterval: null });
    }
  },

  startRateLimitPoller: () => {
    get().stopRateLimitPoller();
    const id = setInterval(() => {
      if (get().rateLimited) {
        void api.getPollStatus().then((s) => get().applyPollStatus(s)).catch(() => {});
      }
    }, 20_000);
    set({ _rateLimitPollInterval: id });
    return () => {
      clearInterval(id);
      set({ _rateLimitPollInterval: null });
    };
  },

  stopRateLimitPoller: () => {
    const id = get()._rateLimitPollInterval;
    if (id) {
      clearInterval(id);
      set({ _rateLimitPollInterval: null });
    }
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add web/src/store/pollStatusSlice.ts
git commit -m "feat: create pollStatus slice with SSE and countdown"
```

---

### Task 6: Create fixJobsSlice

**Files:**
- Create: `web/src/store/fixJobsSlice.ts`

- [ ] **Step 1: Create fixJobsSlice**

```typescript
import { api } from "../api";
import type { SliceCreator, FixJobsSlice } from "./types";

export const createFixJobsSlice: SliceCreator<FixJobsSlice> = (set, get) => ({
  jobs: [],
  replyText: {},
  noChangesReply: {},
  acting: {},
  selectedJobId: null,

  setJobs: (jobs) => {
    // Initialize noChangesReply for new no_changes jobs
    const newReplies = { ...get().noChangesReply };
    for (const job of jobs) {
      if (job.status === "no_changes" && job.suggestedReply && !(job.commentId in newReplies)) {
        newReplies[job.commentId] = job.suggestedReply;
      }
    }
    set({ jobs, noChangesReply: newReplies });
  },

  setReplyText: (commentId, text) =>
    set((s) => ({ replyText: { ...s.replyText, [commentId]: text } })),

  setNoChangesReply: (commentId, text) =>
    set((s) => ({ noChangesReply: { ...s.noChangesReply, [commentId]: text } })),

  setSelectedJobId: (id) => set({ selectedJobId: id }),

  apply: async (repo, commentId, prNumber, branch) => {
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixApply(repo, commentId, prNumber, branch);
      set({ selectedJobId: null });
      await get().reloadComments();
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },

  discard: async (branch, commentId) => {
    if (commentId != null) {
      set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    }
    try {
      await api.fixDiscard(branch, commentId);
      set({ selectedJobId: null });
      await get().reloadComments();
    } catch (err) {
      console.error("Discard failed:", err);
    } finally {
      if (commentId != null) {
        set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
      }
    }
  },

  sendReply: async (repo, commentId, message) => {
    if (!message.trim()) return;
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixReply(repo, commentId, message.trim());
      set((s) => ({ replyText: { ...s.replyText, [commentId]: "" } }));
    } catch (err) {
      console.error("Reply failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },

  sendReplyAndResolve: async (repo, commentId, prNumber, replyBody) => {
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixReplyAndResolve(repo, commentId, prNumber, replyBody);
      set({ selectedJobId: null });
      await get().reloadComments();
    } catch (err) {
      console.error("Reply & resolve failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },

  retryFix: async (repo, commentId, prNumber, branch, originalComment) => {
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixWithClaude(repo, commentId, prNumber, branch, originalComment);
    } catch (err) {
      console.error("Retry failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add web/src/store/fixJobsSlice.ts
git commit -m "feat: create fixJobs slice with apply, discard, reply actions"
```

---

### Task 7: Create notificationsSlice

**Files:**
- Create: `web/src/store/notificationsSlice.ts`

- [ ] **Step 1: Create notificationsSlice**

```typescript
import { api } from "../api";
import type { PullRequest } from "../types";
import type { SliceCreator, NotificationsSlice } from "./types";

function prKey(pr: PullRequest): string {
  return `${pr.repo}:${pr.number}`;
}

function commentKey(id: number, repo: string, prNumber: number): string {
  return `${repo}:${prNumber}:${id}`;
}

function notify(title: string, body: string, onClick?: () => void) {
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(title, { body, icon: "/logo.png" });
    if (onClick) {
      n.onclick = () => {
        window.focus();
        onClick();
        n.close();
      };
    }
  }
}

export const createNotificationsSlice: SliceCreator<NotificationsSlice> = (set, get) => ({
  mutedPRs: new Set(),
  permission: "Notification" in window ? Notification.permission : "denied",
  initialized: false,
  commentBaselineReady: false,
  _previousReviewPRKeys: new Set(),
  _previousCommentKeys: new Set(),
  _previousPendingKeys: new Set(),
  _previousChecksStatus: new Map(),
  _previousOpenComments: new Map(),
  _lastReviewReminder: Date.now(),
  _reminderInterval: null,
  _permissionInterval: null,

  initializeBaseline: async () => {
    const { authored, reviewRequested } = get();
    if (authored.length === 0 || get().initialized) return;

    // Seed review PR keys
    set({ _previousReviewPRKeys: new Set(reviewRequested.map(prKey)) });

    // Seed checks status and open comment counts
    const checksMap = new Map<string, string>();
    const openCommentsMap = new Map<string, number>();
    for (const pr of authored) {
      checksMap.set(prKey(pr), pr.checksStatus);
      openCommentsMap.set(prKey(pr), pr.openComments);
    }
    set({ _previousChecksStatus: checksMap, _previousOpenComments: openCommentsMap });

    // Fetch all comments to build baseline
    const allKeys = new Set<string>();
    const pendingKeys = new Set<string>();
    for (const pr of authored) {
      try {
        const comments = await api.getPullComments(pr.number, pr.repo);
        for (const c of comments) {
          allKeys.add(commentKey(c.id, pr.repo, pr.number));
          if (c.crStatus === "pending" && c.evaluation) {
            pendingKeys.add(commentKey(c.id, pr.repo, pr.number));
          }
        }
      } catch { /* ignore */ }
    }

    set({
      _previousCommentKeys: allKeys,
      _previousPendingKeys: pendingKeys,
      initialized: true,
      commentBaselineReady: true,
    });
  },

  diffAndNotify: async () => {
    const state = get();
    if (!state.initialized || !state.commentBaselineReady) return;
    if (state.authored.length === 0) return;

    const muted = state.mutedPRs;

    // ── Review PRs: detect new ones ──
    const currentReviewKeys = new Set(state.reviewRequested.map(prKey));
    for (const pr of state.reviewRequested) {
      const key = prKey(pr);
      if (!state._previousReviewPRKeys.has(key) && !muted.has(key)) {
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `Review requested: ${repoShort}#${pr.number}`,
          pr.title,
          () => get().selectPR(pr.number, pr.repo),
        );
      }
    }
    set({ _previousReviewPRKeys: currentReviewKeys });

    // ── CI status changes ──
    const newChecks = new Map<string, string>();
    for (const pr of state.authored) {
      const key = prKey(pr);
      const prev = state._previousChecksStatus.get(key);
      if (prev && prev !== pr.checksStatus && !muted.has(key)) {
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        if (pr.checksStatus === "success") {
          notify(`Checks passed: ${repoShort}#${pr.number}`, pr.title,
            () => get().selectPR(pr.number, pr.repo));
        } else if (pr.checksStatus === "failure") {
          notify(`Checks failed: ${repoShort}#${pr.number}`, pr.title,
            () => get().selectPR(pr.number, pr.repo));
        }
      }
      newChecks.set(key, pr.checksStatus);
    }
    set({ _previousChecksStatus: newChecks });

    // ── Open comment count changes ──
    const newOpenComments = new Map<string, number>();
    for (const pr of state.authored) {
      const key = prKey(pr);
      const prev = state._previousOpenComments.get(key) ?? 0;
      if (pr.openComments > prev && !muted.has(key)) {
        const newCount = pr.openComments - prev;
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `${newCount} new comment${newCount > 1 ? "s" : ""}: ${repoShort}#${pr.number}`,
          pr.title,
          () => get().selectPR(pr.number, pr.repo),
        );
      }
      newOpenComments.set(key, pr.openComments);
    }
    set({ _previousOpenComments: newOpenComments });

    // ── Detailed comment diff (new comments, newly analyzed) ──
    const newAllKeys = new Set<string>();
    const newPendingKeys = new Set<string>();
    const newlyAnalyzed: Array<{ pr: PullRequest; c: Awaited<ReturnType<typeof api.getPullComments>>[0] }> = [];

    for (const pr of state.authored) {
      const pk = prKey(pr);
      try {
        const comments = await api.getPullComments(pr.number, pr.repo);
        for (const c of comments) {
          const key = commentKey(c.id, pr.repo, pr.number);
          newAllKeys.add(key);

          if (!state._previousCommentKeys.has(key) && !muted.has(pk)) {
            if (!c.author.includes("[bot]")) {
              const repoShort = pr.repo.split("/")[1] ?? pr.repo;
              notify(
                `New comment on ${repoShort}#${pr.number}`,
                `${c.author} commented on ${c.path}:${c.line}`,
                () => get().selectPR(pr.number, pr.repo),
              );
            }
          }

          if (c.crStatus === "pending" && c.evaluation) {
            newPendingKeys.add(key);
            if (!state._previousPendingKeys.has(key) && !muted.has(pk)) {
              newlyAnalyzed.push({ pr, c });
            }
          }
        }
      } catch { /* ignore */ }
    }

    // Grouped notifications for newly analyzed comments
    if (newlyAnalyzed.length === 1) {
      const { pr, c } = newlyAnalyzed[0]!;
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      const actionLabel = c.evaluation!.action === "fix" ? "Needs fix"
        : c.evaluation!.action === "reply" ? "Needs reply" : "Can resolve";
      notify(
        `${actionLabel}: ${repoShort}#${pr.number}`,
        `${c.path}:${c.line} — ${c.evaluation!.summary}`,
        () => get().selectPR(pr.number, pr.repo),
      );
    } else if (newlyAnalyzed.length > 1) {
      const fixes = newlyAnalyzed.filter((e) => e.c.evaluation?.action === "fix").length;
      const replies = newlyAnalyzed.filter((e) => e.c.evaluation?.action === "reply").length;
      const parts: string[] = [];
      if (fixes > 0) parts.push(`${fixes} fix${fixes > 1 ? "es" : ""}`);
      if (replies > 0) parts.push(`${replies} repl${replies > 1 ? "ies" : "y"}`);
      if (parts.length === 0) parts.push(`${newlyAnalyzed.length} comments`);
      notify(
        `${newlyAnalyzed.length} comments need action`,
        parts.join(", ") + " across your PRs",
      );
    }

    set({
      _previousCommentKeys: newAllKeys,
      _previousPendingKeys: newPendingKeys,
    });
  },

  mutePR: (repo, number) =>
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.add(`${repo}:${number}`);
      return { mutedPRs: next };
    }),

  unmutePR: (repo, number) =>
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.delete(`${repo}:${number}`);
      return { mutedPRs: next };
    }),

  isPRMuted: (repo, number) => get().mutedPRs.has(`${repo}:${number}`),

  requestPermission: async () => {
    if ("Notification" in window && Notification.permission === "default") {
      const result = await Notification.requestPermission();
      set({ permission: result });
    }
  },

  testNotification: () => {
    if ("Notification" in window) {
      if (Notification.permission === "granted") {
        new Notification("Code Triage — Test", { body: "Notifications are working!", icon: "/logo.png" });
      } else if (Notification.permission === "default") {
        Notification.requestPermission().then((p) => {
          set({ permission: p });
          if (p === "granted") {
            new Notification("Code Triage — Test", { body: "Notifications are working!", icon: "/logo.png" });
          }
        });
      } else {
        alert("Notifications are blocked. Please enable them in your browser settings.");
      }
    }
  },

  startReminderInterval: () => {
    const existing = get()._reminderInterval;
    if (existing) clearInterval(existing);

    const id = setInterval(() => {
      const s = get();
      if (s.reviewRequested.length === 0) return;
      const now = Date.now();
      if (now - s._lastReviewReminder < 30 * 60_000) return;
      set({ _lastReviewReminder: now });

      const unmuted = s.reviewRequested.filter((pr) => !s.mutedPRs.has(prKey(pr)));
      if (unmuted.length === 0) return;

      if (unmuted.length === 1) {
        const pr = unmuted[0];
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `Waiting for your review: ${repoShort}#${pr.number}`,
          pr.title,
          () => get().selectPR(pr.number, pr.repo),
        );
      } else {
        notify(
          `${unmuted.length} PRs waiting for your review`,
          unmuted.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}: ${pr.title}`).join("\n"),
        );
      }
    }, 60_000);

    set({ _reminderInterval: id });
    return () => {
      clearInterval(id);
      set({ _reminderInterval: null });
    };
  },

  checkPermissionPeriodically: () => {
    const existing = get()._permissionInterval;
    if (existing) clearInterval(existing);

    const id = setInterval(() => {
      if ("Notification" in window && Notification.permission !== get().permission) {
        set({ permission: Notification.permission });
      }
    }, 5000);

    set({ _permissionInterval: id });
    return () => {
      clearInterval(id);
      set({ _permissionInterval: null });
    };
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add web/src/store/notificationsSlice.ts
git commit -m "feat: create notifications slice with diffing and muted PRs"
```

---

### Task 8: Create uiSlice and settings form utility

**Files:**
- Create: `web/src/store/settingsForm.ts`
- Create: `web/src/store/uiSlice.ts`

- [ ] **Step 1: Create settingsForm.ts utility**

This is shared between `appSlice` (setup mode initialization) and `uiSlice` (settings modal).

Create `web/src/store/settingsForm.ts`:

```typescript
import type { AppConfigPayload } from "../api";
import type { SettingsFormState } from "./types";

export function payloadToForm(c: AppConfigPayload): SettingsFormState {
  return {
    root: c.root,
    port: c.port,
    interval: c.interval,
    evalConcurrency: c.evalConcurrency,
    pollReviewRequested: c.pollReviewRequested,
    commentRetentionDays: c.commentRetentionDays,
    repoPollStaleAfterDays: c.repoPollStaleAfterDays ?? 7,
    repoPollColdIntervalMinutes: c.repoPollColdIntervalMinutes ?? 60,
    pollApiHeadroom: c.pollApiHeadroom ?? 0.35,
    pollRateLimitAware: c.pollRateLimitAware !== false,
    preferredEditor: c.preferredEditor ?? "vscode",
    ignoredBots: (c.ignoredBots ?? []).join("\n"),
    githubToken: "",
    hasGithubToken: Boolean(c.hasGithubToken),
    accounts: (c.accounts ?? []).map((a) => ({
      name: a.name,
      orgs: a.orgs.join(", "),
      token: "",
      hasToken: a.hasToken,
    })),
    evalPromptAppend: c.evalPromptAppend ?? "",
    evalPromptAppendByRepoJson: c.evalPromptAppendByRepo
      ? JSON.stringify(c.evalPromptAppendByRepo, null, 2)
      : "{}",
    evalClaudeExtraArgsJson: c.evalClaudeExtraArgs
      ? JSON.stringify(c.evalClaudeExtraArgs, null, 2)
      : "[]",
    fixConversationMaxTurns: c.fixConversationMaxTurns ?? 5,
  };
}
```

- [ ] **Step 2: Create uiSlice**

```typescript
import { api } from "../api";
import type { SliceCreator, UiSlice, SettingsFormState } from "./types";
import { selectFlatPulls } from "./selectors";
import { payloadToForm } from "./settingsForm";

export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  sidebarCollapsed: false,
  mobileDrawerOpen: false,
  isWide: typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true,
  showSettings: false,
  settingsConfig: null,
  shortcutsOpen: false,

  settingsForm: null,
  settingsSaving: false,
  settingsError: null,
  settingsRestartHint: false,

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  setMobileDrawerOpen: (open) => set({ mobileDrawerOpen: open }),

  openSettings: async () => {
    try {
      const r = await api.getConfig();
      set({
        settingsConfig: r,
        showSettings: true,
        settingsForm: payloadToForm(r.config),
        settingsSaving: false,
        settingsError: null,
        settingsRestartHint: false,
      });
    } catch { /* ignore */ }
  },

  closeSettings: () => set({
    showSettings: false,
    settingsConfig: null,
    settingsForm: null,
    settingsError: null,
    settingsRestartHint: false,
  }),

  toggleShortcuts: () => set((s) => ({ shortcutsOpen: !s.shortcutsOpen })),

  initMediaQuery: () => {
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      set({ isWide: e.matches });
      if (e.matches) set({ mobileDrawerOpen: false });
    };
    mql.addEventListener("change", handler);
    set({ isWide: mql.matches });
    return () => mql.removeEventListener("change", handler);
  },

  initKeyboardListener: () => {
    const onKey = (e: KeyboardEvent) => {
      const s = get();

      if (e.key === "Escape") {
        set({ shortcutsOpen: false });
        return;
      }

      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;

      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        set((prev) => ({ shortcutsOpen: !prev.shortcutsOpen }));
        return;
      }
      if (s.shortcutsOpen) return;

      if ((e.key === "]" || e.key === "[") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const list = selectFlatPulls(s);
        const cur = s.selectedPR;
        if (list.length === 0) return;
        e.preventDefault();

        let idx: number;
        if (cur) {
          const i = list.findIndex((p) => p.number === cur.number && p.repo === cur.repo);
          if (e.key === "]") {
            idx = i < 0 ? 0 : Math.min(list.length - 1, i + 1);
          } else {
            idx = i < 0 ? 0 : Math.max(0, i - 1);
          }
        } else {
          idx = e.key === "[" ? list.length - 1 : 0;
        }
        const next = list[idx];
        if (next) {
          void s.selectPR(next.number, next.repo);
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  },

  setSettingsForm: (form) => set({ settingsForm: form }),

  updateSettingsField: (key, value) =>
    set((s) => {
      if (!s.settingsForm) return {};
      return { settingsForm: { ...s.settingsForm, [key]: value } };
    }),

  submitSettings: async () => {
    const s = get();
    if (!s.settingsForm || !s.settingsConfig) return;
    const form = s.settingsForm;

    set({ settingsSaving: true, settingsError: null });

    try {
      let evalPromptAppendByRepo: Record<string, string> = {};
      try { evalPromptAppendByRepo = JSON.parse(form.evalPromptAppendByRepoJson); } catch { /* ignore */ }
      let evalClaudeExtraArgs: string[] = [];
      try { evalClaudeExtraArgs = JSON.parse(form.evalClaudeExtraArgsJson); } catch { /* ignore */ }

      const body: Record<string, unknown> = {
        root: form.root,
        port: form.port,
        interval: form.interval,
        evalConcurrency: form.evalConcurrency,
        pollReviewRequested: form.pollReviewRequested,
        commentRetentionDays: form.commentRetentionDays,
        repoPollStaleAfterDays: form.repoPollStaleAfterDays,
        repoPollColdIntervalMinutes: form.repoPollColdIntervalMinutes,
        pollApiHeadroom: form.pollApiHeadroom,
        pollRateLimitAware: form.pollRateLimitAware,
        preferredEditor: form.preferredEditor,
        ignoredBots: form.ignoredBots.split("\n").map((s) => s.trim()).filter(Boolean),
        evalPromptAppend: form.evalPromptAppend,
        evalPromptAppendByRepo,
        evalClaudeExtraArgs,
        fixConversationMaxTurns: form.fixConversationMaxTurns,
        accounts: form.accounts.map((a) => ({
          name: a.name,
          orgs: a.orgs.split(",").map((o) => o.trim()).filter(Boolean),
          ...(a.token ? { token: a.token } : {}),
        })),
      };
      if (form.githubToken) body.githubToken = form.githubToken;

      const result = await s.saveConfig(body);

      if (result.restartRequired || form.port !== s.settingsConfig!.listenPort) {
        set({ settingsRestartHint: true });
      }

      if (s.appGate === "setup") {
        set({ appGate: "ready", pullsLoading: true, error: null, showSettings: false, settingsConfig: null, settingsForm: null });
      } else {
        set({ showSettings: false, settingsConfig: null, settingsForm: null });
      }
    } catch (err) {
      set({ settingsError: (err as Error).message });
    } finally {
      set({ settingsSaving: false });
    }
  },
});
```

Note: `uiSlice` imports `selectFlatPulls` from `./selectors` (not `./index`) to avoid a circular import, since `index.ts` imports `./uiSlice`.

- [ ] **Step 2: Extract selectors to avoid circular import**

Move the selectors from `web/src/store/index.ts` to `web/src/store/selectors.ts`:

Create `web/src/store/selectors.ts`:

```typescript
import type { AppStore } from "./types";

export function selectFilteredAuthored(s: AppStore) {
  if (!s.repoFilter) return s.authored;
  const lower = s.repoFilter.toLowerCase();
  return s.authored.filter(
    (pr) => pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower),
  );
}

export function selectFilteredReviewRequested(s: AppStore) {
  const base = s.repoFilter
    ? s.reviewRequested.filter((pr) => {
        const lower = s.repoFilter.toLowerCase();
        return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
      })
    : s.reviewRequested;
  return base.filter((pr) => !s.mutedPRs.has(`${pr.repo}:${pr.number}`));
}

export function selectMutedReviewPulls(s: AppStore) {
  const base = s.repoFilter
    ? s.reviewRequested.filter((pr) => {
        const lower = s.repoFilter.toLowerCase();
        return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
      })
    : s.reviewRequested;
  return base.filter((pr) => s.mutedPRs.has(`${pr.repo}:${pr.number}`));
}

export function selectFlatPulls(s: AppStore) {
  return [...selectFilteredAuthored(s), ...selectFilteredReviewRequested(s)];
}

export function selectTimerText(s: AppStore) {
  const minutes = Math.floor(s.countdown / 60000);
  const seconds = Math.floor((s.countdown % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function selectShowNotifBanner(s: AppStore) {
  return s.permission === "default";
}

export function formatDurationUntil(targetMs: number, nowMs: number): string {
  const ms = Math.max(0, targetMs - nowMs);
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

Update `web/src/store/index.ts` to re-export from selectors instead of defining them inline:

```typescript
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AppStore } from "./types";
import { createAppSlice } from "./appSlice";
import { createPullsSlice } from "./pullsSlice";
import { createPrDetailSlice } from "./prDetailSlice";
import { createPollStatusSlice } from "./pollStatusSlice";
import { createFixJobsSlice } from "./fixJobsSlice";
import { createNotificationsSlice } from "./notificationsSlice";
import { createUiSlice } from "./uiSlice";

export const useAppStore = create<AppStore>()(
  subscribeWithSelector((...a) => ({
    ...createAppSlice(...a),
    ...createPullsSlice(...a),
    ...createPrDetailSlice(...a),
    ...createPollStatusSlice(...a),
    ...createFixJobsSlice(...a),
    ...createNotificationsSlice(...a),
    ...createUiSlice(...a),
  })),
);

// Wire subscriptions: trigger notification diffing when pull data changes
useAppStore.subscribe(
  (s) => s.pullFetchGeneration,
  () => {
    void useAppStore.getState().diffAndNotify();
  },
);

export { useAppStore as default };
export type { AppStore } from "./types";
export {
  selectFilteredAuthored,
  selectFilteredReviewRequested,
  selectMutedReviewPulls,
  selectFlatPulls,
  selectTimerText,
  selectShowNotifBanner,
  formatDurationUntil,
} from "./selectors";
```

Update `web/src/store/uiSlice.ts` import to use `./selectors` instead of `./index`:

```typescript
import { selectFlatPulls } from "./selectors";
```

- [ ] **Step 3: Verify the store compiles**

```bash
cd /Users/lex/src/cr-watch && yarn build:all
```

Fix any type errors. The most likely issues:
- `SliceCreator` generic usage — ensure each slice creator return type matches its interface
- Cross-slice access (e.g. `get().selectPR` in pulls) — these work because `get()` returns `AppStore`

- [ ] **Step 4: Commit**

```bash
git add web/src/store/
git commit -m "feat: complete all store slices with selectors and subscriptions"
```

---

### Task 9: Rewrite App.tsx as thin shell

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Rewrite App.tsx**

Replace the entire contents of `web/src/App.tsx` with a thin component that reads from the store and renders the layout. The component has a single `useEffect` for initialization and `popstate`, and everything else comes from selectors.

The new App.tsx should:

1. Import `useAppStore` and selectors
2. Call `initialize()` in a mount effect
3. Call `initMediaQuery()`, `initKeyboardListener()`, `startCountdownTimer()`, `startReminderInterval()`, `checkPermissionPeriodically()` in a mount effect (only when `appGate === "ready"`), collecting teardown functions
4. Register `popstate` listener that calls `handlePopState()`
5. Read all UI state from selectors
6. Render the same layout but using store values and store actions instead of local state/props

Key changes:
- Remove all `useState`, `useRef`, `useCallback`, `useMemo` hooks
- Remove `useNotifications` call
- Remove all `sessionStorage`/`loadCache`/`saveCache` calls
- Remove `fetchPulls`, `reloadComments`, `applyPollStatus`, etc. — all handled by store
- Components receive no props — they read from the store themselves
- Keep the JSX structure and Tailwind classes identical

```typescript
import { useEffect } from "react";
import { useAppStore, selectFilteredAuthored, selectFilteredReviewRequested, selectMutedReviewPulls, selectTimerText, selectShowNotifBanner, formatDurationUntil } from "./store";
import RepoFilter from "./components/RepoSelector";
import PRList from "./components/PRList";
import PRDetail from "./components/PRDetail";
import FileList from "./components/FileList";
import DiffView from "./components/DiffView";
import CommentThreads from "./components/CommentThreads";
import PROverview from "./components/PROverview";
import FixJobsBanner from "./components/FixJobsBanner";
import ChecksPanel from "./components/ChecksPanel";
import SettingsView from "./components/SettingsView";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal";
import { cn } from "./lib/utils";
import { X, Menu, RefreshCw, Pause, Bell, ArrowRight, Minus, Settings, PanelLeftClose, PanelLeftOpen, HelpCircle } from "lucide-react";
import { CollapsibleSection } from "./components/ui/collapsible-section";
import { IconButton } from "./components/ui/icon-button";

function MutedReviewSection() {
  const pulls = useAppStore(selectMutedReviewPulls);
  if (pulls.length === 0) return null;
  return (
    <CollapsibleSection
      title={<>Muted ({pulls.length})</>}
      className="px-4 py-1.5 text-gray-600 border-y border-gray-800 bg-gray-900/20"
      chevronClassName="text-gray-700"
    >
      <div className="opacity-60">
        <PRList />
      </div>
    </CollapsibleSection>
  );
}

export default function App() {
  const appGate = useAppStore((s) => s.appGate);
  const error = useAppStore((s) => s.error);
  const initialize = useAppStore((s) => s.initialize);

  // Initialize on mount
  useEffect(() => { void initialize(); }, [initialize]);

  // Wire up SSE, timers, keyboard, media query when ready
  useEffect(() => {
    if (appGate !== "ready") return;
    const s = useAppStore.getState();
    const teardowns = [
      s.connectSSE(),
      s.startCountdownTimer(),
      s.startReminderInterval(),
      s.checkPermissionPeriodically(),
      s.initMediaQuery(),
      s.initKeyboardListener(),
      s.startRateLimitPoller(),
    ];
    void s.fetchInitialStatus();
    void s.initializeBaseline();

    return () => teardowns.forEach((fn) => fn());
  }, [appGate]);

  // Popstate for browser back/forward
  useEffect(() => {
    const handler = () => useAppStore.getState().handlePopState();
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // Gate: loading
  if (appGate === "loading") {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Starting...
      </div>
    );
  }

  // Gate: setup
  if (appGate === "setup") {
    return <SettingsView mode="setup" />;
  }

  // Gate: error with no data
  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-red-400">
        Error: {error}
      </div>
    );
  }

  return <AppReady />;
}

/** Main app layout — only rendered when appGate === "ready". */
function AppReady() {
  const pullsLoading = useAppStore((s) => s.pullsLoading);
  const pullsRefreshing = useAppStore((s) => s.pullsRefreshing);
  const isWide = useAppStore((s) => s.isWide);
  const mobileDrawerOpen = useAppStore((s) => s.mobileDrawerOpen);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const showSettings = useAppStore((s) => s.showSettings);
  const selectedPR = useAppStore((s) => s.selectedPR);
  const detail = useAppStore((s) => s.detail);
  const prDetailLoading = useAppStore((s) => s.prDetailLoading);
  const activeTab = useAppStore((s) => s.activeTab);
  const comments = useAppStore((s) => s.comments);
  const files = useAppStore((s) => s.files);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const permission = useAppStore((s) => s.permission);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const githubUserUnavailable = useAppStore((s) => s.githubUserUnavailable);
  const pollMeta = useAppStore((s) => ({
    polling: s.polling,
    pollPaused: s.pollPaused,
    pollPausedReason: s.pollPausedReason,
    rateLimited: s.rateLimited,
    rateLimitResetAt: s.rateLimitResetAt,
    rateLimitRemaining: s.rateLimitRemaining,
    rateLimitLimit: s.rateLimitLimit,
    lastPollError: s.lastPollError,
    claude: s.claude,
  }));
  const rateLimitNow = useAppStore((s) => s.rateLimitNow);

  const timerText = useAppStore(selectTimerText);
  const showNotifBanner = useAppStore(selectShowNotifBanner);
  const filteredPulls = useAppStore(selectFilteredAuthored);
  const filteredReviewPulls = useAppStore(selectFilteredReviewRequested);

  const fetchPulls = useAppStore((s) => s.fetchPulls);
  const requestPermission = useAppStore((s) => s.requestPermission);
  const dismissUpdate = useAppStore((s) => s.dismissUpdate);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const openSettings = useAppStore((s) => s.openSettings);
  const toggleShortcuts = useAppStore((s) => s.toggleShortcuts);
  const testNotification = useAppStore((s) => s.testNotification);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  if (pullsLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Loading pull requests...
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-200">
      {/* Notification banners — same JSX as before but using store values */}
      {showNotifBanner && (
        <div className="bg-blue-600/90 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-sm text-white">
            Enable notifications to get alerted when PRs need your attention.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void requestPermission()}
              className="text-sm px-3 py-1 bg-white/20 hover:bg-white/30 text-white rounded transition-colors"
            >
              Turn on notifications
            </button>
          </div>
        </div>
      )}
      {permission === "denied" && (
        <div className="bg-red-600/80 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-sm text-white">
            Notifications are blocked. Click the lock/shield icon in your address bar, find Notifications, and set it to Allow. Then refresh the page.
          </span>
        </div>
      )}
      {updateAvailable && (
        <div className="bg-yellow-600/80 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-sm text-white">
            A new version of Code Triage is available ({updateAvailable.behind} commit{updateAvailable.behind > 1 ? "s" : ""} behind, {updateAvailable.localSha} <ArrowRight size={12} className="inline" /> {updateAvailable.remoteSha}).
            Run <code className="bg-black/20 px-1 rounded">git pull && yarn build:all</code> to update.
          </span>
          <IconButton
            description="Dismiss update notification"
            icon={<X size={16} />}
            onClick={dismissUpdate}
            className="text-white/70 hover:text-white hover:bg-white/10 ml-4"
          />
        </div>
      )}
      {!isWide && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-800 bg-gray-950 px-2 py-1.5 md:hidden">
          <IconButton
            description="Open pull request list"
            icon={<Menu size={18} />}
            onClick={() => setMobileDrawerOpen(true)}
            className="text-gray-300"
          />
          <span className="min-w-0 flex-1 truncate text-center text-xs font-semibold text-white">Code Triage</span>
          <span className="shrink-0 font-mono text-[10px] text-gray-600" title="Time until next backend poll">
            {timerText}
          </span>
        </div>
      )}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {!isWide && mobileDrawerOpen && (
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => setMobileDrawerOpen(false)}
          />
        )}
        {/* Sidebar */}
        <div
          className={cn(
            "z-50 flex shrink-0 flex-col border-r border-gray-800 bg-gray-950 shadow-xl transition-[transform,width] duration-200 ease-out",
            "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:w-72 max-md:max-w-[85vw]",
            "md:relative md:z-auto md:shadow-none",
            !isWide && !mobileDrawerOpen ? "max-md:-translate-x-full" : "max-md:translate-x-0",
            isWide && (sidebarCollapsed ? "md:w-0 md:min-w-0 md:overflow-hidden md:border-0 md:p-0" : "md:w-72"),
          )}
        >
          <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <img src="/logo.png" alt="" className="w-6 h-6 shrink-0 rounded-md" />
              <h1 className="text-sm font-semibold text-white truncate">Code Triage</h1>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isWide && (
                <IconButton
                  description={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  icon={sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
                  onClick={toggleSidebar}
                  size="sm"
                />
              )}
              <span className="text-xs text-gray-600 font-mono max-md:hidden" title="Time until next backend poll">
                {timerText}
              </span>
              <IconButton
                description="Keyboard shortcuts"
                icon={<HelpCircle size={14} />}
                onClick={toggleShortcuts}
                size="sm"
              />
              <IconButton
                description="Settings"
                icon={<Settings size={14} />}
                onClick={() => void openSettings()}
                size="sm"
              />
              <IconButton
                description={`Test notification (permission: ${permission})`}
                icon={<Bell size={14} />}
                size="sm"
                onClick={testNotification}
              />
              <IconButton
                description="Refresh lists and reset adaptive poll schedule"
                icon={<RefreshCw size={14} className={pullsRefreshing ? "animate-spin" : ""} />}
                onClick={() => void fetchPulls(false, true)}
                disabled={pullsRefreshing}
                size="sm"
              />
            </div>
          </div>
          <div className="px-3 py-2 border-b border-gray-800 grid grid-cols-2 gap-x-4 text-[10px] text-gray-500">
            {/* GitHub column */}
            <div className="flex flex-col gap-1">
              <span className="text-gray-600 font-medium uppercase tracking-wide">GitHub</span>
              <div className="flex items-center gap-1.5">
                {pollMeta.polling && <span className="text-cyan-400/90">Polling...</span>}
                {pollMeta.pollPaused && (
                  <span className="text-orange-400/90 flex items-center gap-1" title={pollMeta.pollPausedReason ?? "Polling paused"}><Pause size={12} /> Paused</span>
                )}
                {!pollMeta.polling && !pollMeta.pollPaused && !pollMeta.rateLimited && !pollMeta.lastPollError && (
                  <span className="text-gray-600">Idle</span>
                )}
                {pollMeta.rateLimited && <span className="text-amber-400/90">Rate limited</span>}
                {pollMeta.lastPollError && (
                  <span className="text-red-400/90 truncate" title={pollMeta.lastPollError}>Error</span>
                )}
                {githubUserUnavailable && <span className="text-amber-400/90">User unavailable</span>}
              </div>
              {pollMeta.rateLimitRemaining != null && pollMeta.rateLimitLimit != null && pollMeta.rateLimitLimit > 0 && (() => {
                const used = pollMeta.rateLimitLimit - pollMeta.rateLimitRemaining;
                const pct = used / pollMeta.rateLimitLimit;
                return (
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <span>{pollMeta.rateLimitRemaining}/{pollMeta.rateLimitLimit}</span>
                      {pollMeta.rateLimitResetAt && pct >= 0.5 && (
                        <span className="text-gray-600/60">·</span>
                      )}
                      {pollMeta.rateLimitResetAt && pct >= 0.5 && (
                        <span>resets {formatDurationUntil(pollMeta.rateLimitResetAt, rateLimitNow)}</span>
                      )}
                    </div>
                    <span className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <span
                        className={cn("h-full block rounded-full transition-all", pct >= 0.8 ? "bg-red-500" : pct >= 0.6 ? "bg-orange-500" : "bg-green-500")}
                        style={{ width: `${Math.round(pct * 100)}%` }}
                      />
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* Claude/AI column */}
            <div className="flex flex-col gap-1">
              <span className="text-gray-600 font-medium uppercase tracking-wide">Claude</span>
              {pollMeta.claude ? (
                <>
                  <div className="flex items-center gap-1.5">
                    {pollMeta.claude.activeEvals > 0 ? (
                      <span className="text-cyan-400/90">{pollMeta.claude.activeEvals}/{pollMeta.claude.evalConcurrencyCap} evals running</span>
                    ) : pollMeta.claude.activeFixJobs > 0 ? (
                      <span className="text-orange-400/90">{pollMeta.claude.activeFixJobs} fix{pollMeta.claude.activeFixJobs > 1 ? "es" : ""} running</span>
                    ) : (
                      <span className="text-gray-600">Idle</span>
                    )}
                  </div>
                  <span className="text-gray-700">
                    {pollMeta.claude.totalEvalsThisSession} evals · {pollMeta.claude.totalFixesThisSession} fixes this session
                  </span>
                </>
              ) : (
                <span className="text-gray-700"><Minus size={12} /></span>
              )}
            </div>
          </div>
          <RepoFilter />
          <div className="overflow-y-auto flex-1">
            <div className="px-4 py-1.5 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-800">
              My Pull Requests
            </div>
            <PRList pulls={filteredPulls} />
            {filteredReviewPulls.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-xs text-gray-500 uppercase tracking-wide border-y border-gray-800 bg-gray-900/30">
                  Needs My Review ({filteredReviewPulls.length})
                </div>
                <PRList pulls={filteredReviewPulls} />
              </>
            )}
            <MutedReviewSection />
          </div>
        </div>

        {/* Main area */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {isWide && sidebarCollapsed && (
            <IconButton
              description="Expand sidebar"
              icon={<PanelLeftOpen size={14} />}
              className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-l-none rounded-r border border-l-0 border-gray-800 bg-gray-900/95 px-1 py-4 text-gray-400 hover:text-white"
              onClick={toggleSidebar}
            />
          )}
          {prDetailLoading ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              Loading...
            </div>
          ) : detail ? (
            <>
              <PRDetail />
              {/* Tab bar */}
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
                ]).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "px-5 py-2 text-sm transition-colors rounded-t focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950",
                      activeTab === tab.id
                        ? "text-white border-b-2 border-blue-500 -mb-px"
                        : "text-gray-500 hover:text-gray-300",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      {tab.id === "checks" && detail?.checksSummary && (
                        <span className={cn(
                          "inline-block w-2 h-2 rounded-full",
                          detail.checksSummary.failure > 0 ? "bg-red-400" :
                          detail.checksSummary.pending > 0 ? "bg-yellow-400" :
                          "bg-green-400",
                        )} />
                      )}
                      {tab.label}
                    </span>
                  </button>
                ))}
              </div>

              {/* Tab content */}
              {activeTab === "overview" && <PROverview />}
              {activeTab === "threads" && <CommentThreads />}
              {activeTab === "files" && (
                <>
                  <FileList />
                  <div className="flex-1 overflow-y-auto">
                    {selectedFile ? <DiffView /> : (
                      <div className="text-gray-500 text-center mt-12">Select a file to view its diff</div>
                    )}
                  </div>
                </>
              )}
              {activeTab === "checks" && <ChecksPanel />}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              Select a pull request
            </div>
          )}
        </div>
      </div>
      <FixJobsBanner />
      <KeyboardShortcutsModal />
      {showSettings && <SettingsView mode="settings" />}
    </div>
  );
}
```

Note: Components like `PRList` still accept a `pulls` prop here for the filtered lists because the sidebar renders different filtered sets. PRList is a display component that just needs a list — the store doesn't know which filtered view to show. The alternative is to have PRList accept a selector, but a simple `pulls` prop is cleaner for this case.

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/lex/src/cr-watch && yarn build:all
```

This will fail because components still expect old props. That's expected — we migrate components next.

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: rewrite App.tsx as thin shell using Zustand store"
```

---

### Task 10: Migrate PRList and RepoSelector

**Files:**
- Modify: `web/src/components/PRList.tsx`
- Modify: `web/src/components/RepoSelector.tsx`

- [ ] **Step 1: Update PRList**

PRList stays mostly the same — it still accepts a `pulls` prop because different callers pass different filtered lists. But `selectedPR` and `onSelectPR` come from the store now.

Update the props interface and component to read selection from store:

```typescript
// Remove from props: selectedPR, onSelectPR
// Keep: pulls, showRepo (optional, default true)

interface PRListProps {
  pulls: PullRequest[];
  showRepo?: boolean;
}
```

Inside the component, replace prop usage:
```typescript
const selectedPR = useAppStore((s) => s.selectedPR);
const selectPR = useAppStore((s) => s.selectPR);
const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);

function handleClick(number: number, repo: string) {
  void selectPR(number, repo);
  setMobileDrawerOpen(false);
}
```

- [ ] **Step 2: Update RepoSelector**

Remove props entirely — read from and write to store:

```typescript
import { useAppStore } from "../store";

export default function RepoFilter() {
  const filter = useAppStore((s) => s.repoFilter);
  const setRepoFilter = useAppStore((s) => s.setRepoFilter);

  return (
    <div className="px-3 py-2 border-b border-gray-800">
      <input ... value={filter} onChange={(e) => setRepoFilter(e.target.value)} ... />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/PRList.tsx web/src/components/RepoSelector.tsx
git commit -m "feat: migrate PRList and RepoSelector to use store"
```

---

### Task 11: Migrate PRDetail

**Files:**
- Modify: `web/src/components/PRDetail.tsx`

- [ ] **Step 1: Update PRDetail to use store**

Remove all props. Read from store:
- `pr` → `useAppStore((s) => s.detail)`
- `currentUser` → `useAppStore((s) => s.currentUser)`
- `submitting`, `reviewError` → from store (`reviewSubmitting`, `reviewError`)
- `showRequestChanges`, `requestBody` → from store (`showRequestChanges`, `reviewBody`)
- `muted` → `useAppStore((s) => s.isPRMuted(pr.repo, pr.number))`
- `mutePR`/`unmutePR` → from store
- `handleReview` → `useAppStore((s) => s.submitReview)`

The component becomes:
```typescript
export default function PRDetail() {
  const pr = useAppStore((s) => s.detail);
  const currentUser = useAppStore((s) => s.currentUser);
  const submitting = useAppStore((s) => s.reviewSubmitting);
  const reviewError = useAppStore((s) => s.reviewError);
  const showRequestChanges = useAppStore((s) => s.showRequestChanges);
  const requestBody = useAppStore((s) => s.reviewBody);
  const submitReview = useAppStore((s) => s.submitReview);
  const setShowRequestChanges = useAppStore((s) => s.setShowRequestChanges);
  const setReviewBody = useAppStore((s) => s.setReviewBody);
  const mute = useAppStore((s) => s.mutePR);
  const unmute = useAppStore((s) => s.unmutePR);
  const isPRMuted = useAppStore((s) => s.isPRMuted);

  if (!pr) return null;

  const isOwnPR = currentUser != null && pr.author === currentUser;
  const muted = isPRMuted(pr.repo, pr.number);

  // ... rest of JSX stays the same, using store values/actions
}
```

Remove `useRef` for textarea focus — use a callback ref or keep a single ref for DOM focus (this is a DOM ref, not state, so a local `useRef` is acceptable for focus management only — but per the user's requirement of no local state, use a callback ref pattern).

- [ ] **Step 2: Commit**

```bash
git add web/src/components/PRDetail.tsx
git commit -m "feat: migrate PRDetail to use store"
```

---

### Task 12: Migrate CommentThreads

**Files:**
- Modify: `web/src/components/CommentThreads.tsx`

This is the largest migration. All props and local state move to the store.

- [ ] **Step 1: Update CommentThreads to use store**

Remove the entire props interface. The component reads everything from the store:

```typescript
export default function CommentThreads() {
  const comments = useAppStore((s) => s.comments);
  const selectedPR = useAppStore((s) => s.selectedPR);
  const detail = useAppStore((s) => s.detail);
  const jobs = useAppStore((s) => s.jobs);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const toggleShortcuts = useAppStore((s) => s.toggleShortcuts);
  const repos = useAppStore((s) => s.repos);
  const preferredEditor = useAppStore((s) => s.preferredEditor);
  const filterText = useAppStore((s) => s.threadFilterText);
  const filterAction = useAppStore((s) => s.threadFilterAction);
  const showSnoozed = useAppStore((s) => s.threadShowSnoozed);
  const focusedIdx = useAppStore((s) => s.threadFocusedIdx);
  const selected = useAppStore((s) => s.threadSelected);
  const batching = useAppStore((s) => s.threadBatching);
  // ... etc for all thread state and actions
```

Each `ThreadItem` subcomponent similarly reads its per-thread state from the store using the root comment ID as key:

```typescript
function ThreadItem({ rootId }: { rootId: number }) {
  const expanded = useAppStore((s) => s.expandedThreads.has(rootId));
  const acting = useAppStore((s) => s.actingThreads.has(rootId));
  const fixing = useAppStore((s) => s.fixingThreads.has(rootId));
  const fixError = useAppStore((s) => s.fixErrors[rootId] ?? null);
  const fixModalOpen = useAppStore((s) => s.fixModalOpenThreads.has(rootId));
  const fixInstructions = useAppStore((s) => s.threadFixInstructions[rootId] ?? "");
  const reEvaluating = useAppStore((s) => s.reEvaluatingThreads.has(rootId));
  const toggleExpanded = useAppStore((s) => s.toggleThreadExpanded);
  const replyToComment = useAppStore((s) => s.replyToComment);
  // ... etc
}
```

The `FixConversation` subcomponent reads from the `fixJobs` slice:

```typescript
function FixConversation({ commentId }: { commentId: number }) {
  const replyText = useAppStore((s) => s.replyText[commentId] ?? "");
  const acting = useAppStore((s) => s.acting[commentId] ?? false);
  const setReplyText = useAppStore((s) => s.setReplyText);
  const sendReply = useAppStore((s) => s.sendReply);
  // ...
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/CommentThreads.tsx
git commit -m "feat: migrate CommentThreads to use store"
```

---

### Task 13: Migrate FixJobsBanner

**Files:**
- Modify: `web/src/components/FixJobsBanner.tsx`

- [ ] **Step 1: Update FixJobsBanner to use store**

Remove props. Read from `fixJobs` slice:

```typescript
export default function FixJobsBanner() {
  const fixJobs = useAppStore((s) => s.jobs);
  const selectedJobId = useAppStore((s) => s.selectedJobId);
  const setSelectedJobId = useAppStore((s) => s.setSelectedJobId);
  // ...
}
```

`JobModal` reads per-job state from store:

```typescript
function JobModal({ commentId }: { commentId: number }) {
  const job = useAppStore((s) => s.jobs.find((j) => j.commentId === commentId));
  const acting = useAppStore((s) => s.acting[commentId] ?? false);
  const replyText = useAppStore((s) => s.replyText[commentId] ?? "");
  const noChangesReply = useAppStore((s) => s.noChangesReply[commentId] ?? "");
  const setReplyText = useAppStore((s) => s.setReplyText);
  const setNoChangesReply = useAppStore((s) => s.setNoChangesReply);
  const apply = useAppStore((s) => s.apply);
  const discard = useAppStore((s) => s.discard);
  const sendReply = useAppStore((s) => s.sendReply);
  const sendReplyAndResolve = useAppStore((s) => s.sendReplyAndResolve);
  const retryFix = useAppStore((s) => s.retryFix);
  const close = useAppStore((s) => s.setSelectedJobId);
  // ...
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/FixJobsBanner.tsx
git commit -m "feat: migrate FixJobsBanner to use store"
```

---

### Task 14: Migrate DiffView

**Files:**
- Modify: `web/src/components/DiffView.tsx`

- [ ] **Step 1: Update DiffView to use store**

Remove props. Read file data and diff state from store:

```typescript
export default function DiffView() {
  const selectedFile = useAppStore((s) => s.selectedFile);
  const files = useAppStore((s) => s.files);
  const comments = useAppStore((s) => s.comments.filter((c) => c.path === s.selectedFile));
  const selectedPR = useAppStore((s) => s.selectedPR);
  const detail = useAppStore((s) => s.detail);
  const commentingLine = useAppStore((s) => s.commentingLine);
  const commentBody = useAppStore((s) => s.commentBody);
  const commentSubmitting = useAppStore((s) => s.commentSubmitting);
  const setCommentingLine = useAppStore((s) => s.setCommentingLine);
  const setCommentBody = useAppStore((s) => s.setCommentBody);
  const submitInlineComment = useAppStore((s) => s.submitInlineComment);

  const file = files.find((f) => f.filename === selectedFile);
  if (!file || !selectedPR || !detail) return null;

  // ... rest of render with store values
}
```

The `InlineCommentBox` subcomponent reads/writes from store:

```typescript
function InlineCommentBox() {
  const body = useAppStore((s) => s.commentBody);
  const submitting = useAppStore((s) => s.commentSubmitting);
  const setBody = useAppStore((s) => s.setCommentBody);
  const detail = useAppStore((s) => s.detail);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const submit = useAppStore((s) => s.submitInlineComment);

  // Cmd+Enter handler calls submit(detail.headSha, selectedFile)
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/DiffView.tsx
git commit -m "feat: migrate DiffView to use store"
```

---

### Task 15: Migrate ChecksPanel

**Files:**
- Modify: `web/src/components/ChecksPanel.tsx`

- [ ] **Step 1: Update ChecksPanel to use store**

Remove props. Read from store:

```typescript
export default function ChecksPanel() {
  const selectedPR = useAppStore((s) => s.selectedPR);
  const detail = useAppStore((s) => s.detail);
  const suites = useAppStore((s) => s.checkSuites);
  const error = useAppStore((s) => s.checksError);
  const fetchChecks = useAppStore((s) => s.fetchChecks);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const selectFile = useAppStore((s) => s.selectFile);

  // Fetch checks on mount / when headSha changes
  useEffect(() => {
    void fetchChecks(detail?.headSha);
  }, [fetchChecks, detail?.headSha]);

  // onSelectFile becomes: setActiveTab("files"); selectFile(f);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/ChecksPanel.tsx
git commit -m "feat: migrate ChecksPanel to use store"
```

---

### Task 16: Migrate SettingsView

**Files:**
- Modify: `web/src/components/SettingsView.tsx`

- [ ] **Step 1: Update SettingsView to use store**

The component keeps a `mode` prop ("setup" vs "settings") but all form state comes from the store:

```typescript
interface SettingsViewProps {
  mode: "setup" | "settings";
}

export default function SettingsView({ mode }: SettingsViewProps) {
  const form = useAppStore((s) => s.settingsForm);
  const saving = useAppStore((s) => s.settingsSaving);
  const error = useAppStore((s) => s.settingsError);
  const restartHint = useAppStore((s) => s.settingsRestartHint);
  const listenPort = useAppStore((s) => s.settingsConfig?.listenPort ?? 3100);
  const updateField = useAppStore((s) => s.updateSettingsField);
  const submit = useAppStore((s) => s.submitSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);

  if (!form) return null;

  // For setup mode, initialize form from setupConfig on first render
  // This is handled by the store — app.initialize() sets setupConfig,
  // and the setup gate in App.tsx renders SettingsView which reads from store

  // ... rest of form JSX, replacing local state with store calls
}
```

Remove the `payloadToForm` function from the component — it lives in `uiSlice.ts` now.

For setup mode: when `appGate === "setup"`, App.tsx renders `<SettingsView mode="setup" />`. The store needs to initialize the settings form from `setupConfig`. Add to `appSlice.initialize()`: after setting `appGate` to "setup", also set `settingsForm` via the `payloadToForm` logic, and `settingsConfig` from the config response.

- [ ] **Step 2: Commit**

```bash
git add web/src/components/SettingsView.tsx
git commit -m "feat: migrate SettingsView to use store"
```

---

### Task 17: Migrate remaining components

**Files:**
- Modify: `web/src/components/PROverview.tsx`
- Modify: `web/src/components/FileList.tsx`
- Modify: `web/src/components/KeyboardShortcutsModal.tsx`
- Modify: `web/src/components/Comment.tsx`

- [ ] **Step 1: Update PROverview**

Remove `pr` prop, read from store:

```typescript
export default function PROverview() {
  const pr = useAppStore((s) => s.detail);
  if (!pr) return null;
  // ... same JSX
}
```

- [ ] **Step 2: Update FileList**

Remove props, read from store:

```typescript
export default function FileList() {
  const files = useAppStore((s) => s.files);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const selectFile = useAppStore((s) => s.selectFile);
  const comments = useAppStore((s) => s.comments);
  // ... same JSX, onClick calls selectFile(filename)
}
```

- [ ] **Step 3: Update KeyboardShortcutsModal**

Remove props, read from store:

```typescript
export default function KeyboardShortcutsModal() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const toggleShortcuts = useAppStore((s) => s.toggleShortcuts);
  // Dialog onOpenChange calls toggleShortcuts or set shortcutsOpen to false
}
```

- [ ] **Step 4: Comment component stays unchanged**

`Comment.tsx` is a pure presentational component that receives a `ReviewComment` prop. It doesn't use any app state — it just renders markdown. Keep it as-is since it's used within thread rendering where the comment object is already available.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/PROverview.tsx web/src/components/FileList.tsx web/src/components/KeyboardShortcutsModal.tsx
git commit -m "feat: migrate PROverview, FileList, KeyboardShortcutsModal to store"
```

---

### Task 18: Delete old code and clean up

**Files:**
- Delete: `web/src/useNotifications.ts`
- Delete: `web/src/useMediaQuery.ts`
- Modify: `web/src/App.tsx` — remove any remaining old imports

- [ ] **Step 1: Delete useNotifications.ts**

```bash
rm web/src/useNotifications.ts
```

All notification logic is now in `notificationsSlice.ts`.

- [ ] **Step 2: Delete useMediaQuery.ts**

```bash
rm web/src/useMediaQuery.ts
```

Media query logic is now in `uiSlice.initMediaQuery()`.

- [ ] **Step 3: Remove stale imports**

Search all files for imports of deleted modules and remove them:

```bash
grep -r "useNotifications\|useMediaQuery\|sessionStorage\|localStorage\|CACHE_KEY" web/src/ --include="*.ts" --include="*.tsx"
```

Fix any remaining references.

- [ ] **Step 4: Commit**

```bash
git add -A web/src/
git commit -m "chore: delete useNotifications.ts, useMediaQuery.ts, remove stale imports"
```

---

### Task 19: Build and verify

**Files:** None (verification only)

- [ ] **Step 1: Build**

```bash
cd /Users/lex/src/cr-watch && yarn build:all
```

Fix any type errors. Common issues:
- Missing imports of `useAppStore` in migrated components
- Selector return types not matching expected usage
- `Set` serialization issues (Zustand handles this fine, but `subscribeWithSelector` equality checks need `shallow` for object selectors)

- [ ] **Step 2: Run tests**

```bash
yarn test
```

Backend tests should still pass — we only changed frontend code.

- [ ] **Step 3: Smoke test**

```bash
yarn start
```

Open the web UI and verify:
1. PR list loads in sidebar
2. Selecting a PR loads detail, files, comments
3. Tab switching works (Overview, Review, Files, Checks)
4. Keyboard navigation (`[`/`]` for PR nav, `?` for shortcuts)
5. Thread actions work (reply, resolve, dismiss, fix with Claude)
6. Fix job banner appears for running/completed jobs
7. Settings modal opens and saves
8. Sidebar collapse/expand works
9. Mobile drawer works (resize browser narrow)
10. Poll countdown timer ticks
11. SSE events update the UI (trigger from CLI)
12. Notifications fire for new review requests (if enabled)
13. Mute/unmute PR works
14. Repo filter works

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A web/src/
git commit -m "fix: resolve build and runtime issues from store migration"
```
