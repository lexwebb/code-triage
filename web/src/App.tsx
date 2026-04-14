import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { updateFaviconBadge, updateTitleBadge } from "./lib/tab-badge";
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
import { IconRail } from "./components/IconRail";
import { TicketsSidebar } from "./components/TicketsSidebar";
import { TicketIssueDetail } from "./components/TicketIssueDetail";
import { cn } from "./lib/utils";
import { X, Menu, RefreshCw, Pause, Bell, ArrowRight, Minus, Settings, PanelLeftClose, PanelLeftOpen, HelpCircle } from "lucide-react";
import { CollapsibleSection } from "./components/ui/collapsible-section";
import { IconButton } from "./components/ui/icon-button";
import {
  useAppStore,
  selectFilteredAuthored,
  selectFilteredReviewRequested,
  selectMutedReviewPulls,
  selectTimerText,
  selectShowNotifBanner,
  formatDurationUntil,
} from "./store";

function MutedReviewSection() {
  const pulls = useAppStore(useShallow(selectMutedReviewPulls));
  if (pulls.length === 0) return null;
  return (
    <CollapsibleSection
      title={<>Muted ({pulls.length})</>}
      className="px-4 py-1.5 text-gray-600 border-y border-gray-800 bg-gray-900/20"
      chevronClassName="text-gray-700"
    >
      <div className="opacity-60">
        <PRList pulls={pulls} showRepo />
      </div>
    </CollapsibleSection>
  );
}

export default function App() {
  // ── Store selectors ──
  const appGate = useAppStore((s) => s.appGate);
  const error = useAppStore((s) => s.error);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const pullsLoading = useAppStore((s) => s.pullsLoading);
  const pullsRefreshing = useAppStore((s) => s.pullsRefreshing);
  const githubUserUnavailable = useAppStore((s) => s.githubUserUnavailable);
  const detail = useAppStore((s) => s.detail);
  const files = useAppStore((s) => s.files);
  const comments = useAppStore((s) => s.comments);
  const selectedFile = useAppStore((s) => s.selectedFile);
  const activeTab = useAppStore((s) => s.activeTab);
  const prDetailLoading = useAppStore((s) => s.prDetailLoading);
  const permission = useAppStore((s) => s.permission);
  const polling = useAppStore((s) => s.polling);
  const pollPaused = useAppStore((s) => s.pollPaused);
  const pollPausedReason = useAppStore((s) => s.pollPausedReason);
  const rateLimited = useAppStore((s) => s.rateLimited);
  const rateLimitResetAt = useAppStore((s) => s.rateLimitResetAt);
  const rateLimitRemaining = useAppStore((s) => s.rateLimitRemaining);
  const rateLimitLimit = useAppStore((s) => s.rateLimitLimit);
  const lastPollError = useAppStore((s) => s.lastPollError);
  const claude = useAppStore((s) => s.claude);
  const rateLimitNow = useAppStore((s) => s.rateLimitNow);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const mobileDrawerOpen = useAppStore((s) => s.mobileDrawerOpen);
  const isWide = useAppStore((s) => s.isWide);
  const showSettings = useAppStore((s) => s.showSettings);

  const activeMode = useAppStore((s) => s.activeMode);
  const prToTickets = useAppStore((s) => s.prToTickets);
  const navigateToLinkedTicket = useAppStore((s) => s.navigateToLinkedTicket);

  const filteredPulls = useAppStore(useShallow(selectFilteredAuthored));
  const filteredReviewPulls = useAppStore(useShallow(selectFilteredReviewRequested));
  const timerText = useAppStore(selectTimerText);
  const showNotifBanner = useAppStore(selectShowNotifBanner);

  // ── Store actions ──
  const initialize = useAppStore((s) => s.initialize);
  const dismissUpdate = useAppStore((s) => s.dismissUpdate);
  const fetchPulls = useAppStore((s) => s.fetchPulls);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const handlePopState = useAppStore((s) => s.handlePopState);
  const subscribePush = useAppStore((s) => s.subscribePush);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const openSettings = useAppStore((s) => s.openSettings);

  // ── Tab badge: favicon + title ──
  const jobs = useAppStore((s) => s.jobs);
  const authored = useAppStore((s) => s.authored);
  const reviewRequested = useAppStore((s) => s.reviewRequested);

  useEffect(() => {
    const actionableJobs = jobs.filter((j) =>
      j.status === "completed" || j.status === "awaiting_response" || j.status === "failed" || j.status === "no_changes",
    ).length;
    const pendingTriage = [...authored, ...reviewRequested].reduce(
      (sum, pr) => sum + (pr.pendingTriage ?? 0), 0,
    );
    const count = pendingTriage + actionableJobs;
    updateTitleBadge(count);
    void updateFaviconBadge(count);
  }, [jobs, authored, reviewRequested]);

  // ── Mount: initialize app ──
  useEffect(() => {
    void initialize();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── When ready: wire SSE, timers, keyboard, media, notifications ──
  useEffect(() => {
    if (appGate !== "ready") return;

    const s = useAppStore.getState();
    const teardowns = [
      s.connectSSE(),
      s.startCountdownTimer(),
      s.startRateLimitPoller(),
      s.initMediaQuery(),
      s.initKeyboardListener(),
      s.checkPermissionPeriodically(),
    ];

    void s.fetchInitialStatus();
    void s.loadMutedPRs();
    void s.subscribePush();

    return () => {
      for (const fn of teardowns) fn();
    };
  }, [appGate]);

  // ── Popstate handler ──
  useEffect(() => {
    const onPop = () => handlePopState();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [handlePopState]);

  // ── Gate: loading ──
  if (appGate === "loading") {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Starting…
      </div>
    );
  }

  // ── Gate: setup ──
  if (appGate === "setup") {
    return <SettingsView mode="setup" />;
  }

  // ── Gate: pulls loading ──
  if (pullsLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Loading pull requests...
      </div>
    );
  }

  // ── Gate: error ──
  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-red-400">
        Error: {error}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-200">
      {/* Notification permission banner */}
      {showNotifBanner && (
        <div className="bg-blue-600/90 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-sm text-white">
            Enable push notifications to get alerted when PRs need your attention.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void subscribePush()}
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
        {/* Icon rail — desktop only */}
        <div className="hidden md:flex">
          <IconRail />
        </div>
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
          {activeMode === "code-review" ? (
            <>
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
                    onClick={() => useAppStore.getState().toggleShortcuts()}
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
                    onClick={() => void fetch("/api/push/test", { method: "POST" })}
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
                    {polling && <span className="text-cyan-400/90">Polling…</span>}
                    {pollPaused && (
                      <span className="text-orange-400/90 flex items-center gap-1" title={pollPausedReason ?? "Polling paused"}><Pause size={12} /> Paused</span>
                    )}
                    {!polling && !pollPaused && !rateLimited && !lastPollError && (
                      <span className="text-gray-600">Idle</span>
                    )}
                    {rateLimited && <span className="text-amber-400/90">Rate limited</span>}
                    {lastPollError && (
                      <span className="text-red-400/90 truncate" title={lastPollError}>Error</span>
                    )}
                    {githubUserUnavailable && <span className="text-amber-400/90">User unavailable</span>}
                  </div>
                  {rateLimitRemaining != null && rateLimitLimit != null && rateLimitLimit > 0 && (() => {
                    const used = rateLimitLimit - rateLimitRemaining;
                    const pct = used / rateLimitLimit;
                    return (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 text-gray-600">
                          <span>{rateLimitRemaining}/{rateLimitLimit}</span>
                          {rateLimitResetAt && pct >= 0.5 && (
                            <span className="text-gray-600/60">·</span>
                          )}
                          {rateLimitResetAt && pct >= 0.5 && (
                            <span>resets {formatDurationUntil(rateLimitResetAt, rateLimitNow)}</span>
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
                  {claude ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        {claude.activeEvals > 0 ? (
                          <span className="text-cyan-400/90">{claude.activeEvals}/{claude.evalConcurrencyCap} evals running</span>
                        ) : claude.activeFixJobs > 0 ? (
                          <span className="text-orange-400/90">{claude.activeFixJobs} fix{claude.activeFixJobs > 1 ? "es" : ""} running</span>
                        ) : (
                          <span className="text-gray-600">Idle</span>
                        )}
                      </div>
                      <span className="text-gray-700">
                        {claude.totalEvalsThisSession} evals · {claude.totalFixesThisSession} fixes this session
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
                <PRList pulls={filteredPulls} showRepo />
                {filteredReviewPulls.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 text-xs text-gray-500 uppercase tracking-wide border-y border-gray-800 bg-gray-900/30">
                      Needs My Review ({filteredReviewPulls.length})
                    </div>
                    <PRList pulls={filteredReviewPulls} showRepo />
                  </>
                )}
                <MutedReviewSection />
              </div>
            </>
          ) : (
            <TicketsSidebar />
          )}
        </div>

        {/* Main area */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {activeMode === "code-review" ? (
            <>
              {isWide && sidebarCollapsed && (
                <IconButton
                  description="Expand sidebar"
                  icon={<PanelLeftOpen size={14} />}
                  className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-l-none rounded-r border border-l-0 border-gray-800 bg-gray-900/95 px-1 py-4 text-gray-400 hover:text-white"
                  onClick={() => useAppStore.getState().toggleSidebar()}
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
                  {activeTab === "overview" && (
                    <>
                      <PROverview />
                      {(() => {
                        const prKey = `${detail.repo}#${detail.number}`;
                        const linkedTicketIds = prToTickets[prKey];
                        if (!linkedTicketIds?.length) return null;
                        return (
                          <div className="flex flex-wrap gap-2 mt-3 px-6 pb-4">
                            {linkedTicketIds.map((id) => (
                              <button
                                key={id}
                                onClick={() => navigateToLinkedTicket(id)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-zinc-800 text-blue-400 hover:bg-zinc-700 transition-colors"
                              >
                                🎫 {id}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                    </>
                  )}
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
            </>
          ) : (
            <TicketIssueDetail />
          )}
        </div>
      </div>
      <FixJobsBanner />
      <KeyboardShortcutsModal />
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="my-8 w-full max-w-3xl rounded-lg border border-gray-800 bg-gray-950 shadow-xl max-h-[calc(100vh-4rem)] overflow-hidden flex flex-col">
            <SettingsView mode="settings" />
          </div>
        </div>
      )}
    </div>
  );
}
