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
  QueuedFixItem,
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
  diffViewType: "unified" | "split";

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
  setDiffViewType: (type: "unified" | "split") => void;

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
  queue: QueuedFixItem[];
  replyText: Record<number, string>;
  noChangesReply: Record<number, string>;
  acting: Record<number, boolean>;
  selectedJobId: number | null;

  setJobs: (jobs: FixJobStatus[]) => void;
  setQueue: (items: QueuedFixItem[]) => void;
  cancelQueued: (commentId: number) => Promise<void>;
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
  pushSubscribed: boolean;

  subscribePush: () => Promise<void>;
  unsubscribePush: () => Promise<void>;
  mutePR: (repo: string, number: number) => void;
  unmutePR: (repo: string, number: number) => void;
  isPRMuted: (repo: string, number: number) => boolean;
  requestPermission: () => Promise<void>;
  loadMutedPRs: () => Promise<void>;
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
  linearApiKey: string;
  hasLinearApiKey: boolean;
  linearTeamKeys: string;
}

// ── Tickets Slice ──

export interface TicketsSlice {
  activeMode: "code-review" | "tickets";
  myTickets: import("../types").TicketIssue[];
  repoLinkedTickets: (import("../types").TicketIssue & { linkedPRs: Array<{ number: number; repo: string; title: string }> })[];
  selectedTicket: string | null;
  ticketDetail: import("../types").TicketIssueDetail | null;
  ticketsLoading: boolean;
  ticketDetailLoading: boolean;
  ticketsError: string | null;
  prToTickets: Record<string, string[]>;

  setActiveMode: (mode: "code-review" | "tickets") => void;
  fetchTickets: () => Promise<void>;
  selectTicket: (id: string) => Promise<void>;
  clearTicket: () => void;
  navigateToLinkedPR: (number: number, repo: string) => void;
  navigateToLinkedTicket: (identifier: string) => void;
}

// ── Combined Store ──

export type AppStore = AppSlice &
  PullsSlice &
  PrDetailSlice &
  PollStatusSlice &
  FixJobsSlice &
  NotificationsSlice &
  UiSlice &
  TicketsSlice;

export type SliceCreator<T> = StateCreator<AppStore, [["zustand/subscribeWithSelector", never]], [], T>;
