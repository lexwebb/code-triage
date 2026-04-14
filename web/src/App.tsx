import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { api } from "./api";
import type { ConfigGetResponse } from "./api";
import type { PullRequest, PullRequestDetail, PullFile, ReviewComment, RepoInfo } from "./types";
import { parseRoute, pushRoute, type RouteState } from "./router";
import RepoFilter from "./components/RepoSelector";
import PRList from "./components/PRList";
import PRDetail from "./components/PRDetail";
import FileList from "./components/FileList";
import DiffView from "./components/DiffView";
import CommentThreads from "./components/CommentThreads";
import PROverview from "./components/PROverview";
import { useNotifications, requestNotificationPermission, isPRMuted } from "./useNotifications";
import FixJobsBanner from "./components/FixJobsBanner";
import ChecksPanel from "./components/ChecksPanel";
import SettingsView from "./components/SettingsView";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal";
import type { FixJobStatus, PollStatus } from "./api";
import { useMediaQuery } from "./useMediaQuery";
import { X, Menu, RefreshCw, Pause, Bell, ArrowRight, Minus, Settings, PanelLeftClose, PanelLeftOpen, HelpCircle } from "lucide-react";
import { CollapsibleSection } from "./components/ui/collapsible-section";
import { IconButton } from "./components/ui/icon-button";

/** Human-readable duration for rate-limit countdown (ticks down each second in the UI). */
function formatDurationUntil(targetMs: number, nowMs: number): string {
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

interface SelectedPR {
  number: number;
  repo: string;
}

function MutedReviewSection({ pulls, selectedPR, onSelectPR }: {
  pulls: PullRequest[];
  selectedPR: SelectedPR | null;
  onSelectPR: (number: number, repo: string) => void;
}) {
  return (
    <CollapsibleSection
      title={<>Muted ({pulls.length})</>}
      className="px-4 py-1.5 text-gray-600 border-y border-gray-800 bg-gray-900/20"
      chevronClassName="text-gray-700"
    >
      <div className="opacity-60">
        <PRList
          pulls={pulls}
          selectedPR={selectedPR}
          onSelectPR={onSelectPR}
          showRepo
        />
      </div>
    </CollapsibleSection>
  );
}

const CACHE_KEY_PULLS = "code-triage:pulls";
const CACHE_KEY_REVIEW = "code-triage:reviewPulls";
const CACHE_KEY_TIME = "code-triage:lastFetch";

function loadCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch { return null; }
}

function saveCache<T>(key: string, data: T): void {
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch { /* full */ }
}

export default function App() {
  const initial = parseRoute();

  const [_repos, setRepos] = useState<RepoInfo[]>([]);
  const [_preferredEditor, setPreferredEditor] = useState("vscode");
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [pulls, setPulls] = useState<PullRequest[]>(() => loadCache(CACHE_KEY_PULLS) ?? []);
  const [reviewPulls, setReviewPulls] = useState<PullRequest[]>(() => loadCache(CACHE_KEY_REVIEW) ?? []);
  const [selectedPR, setSelectedPR] = useState<SelectedPR | null>(
    initial.repo && initial.prNumber ? { repo: initial.repo, number: initial.prNumber } : null,
  );
  const [prDetail, setPrDetail] = useState<PullRequestDetail | null>(null);
  const [prFiles, setPrFiles] = useState<PullFile[]>([]);
  const [prComments, setPrComments] = useState<ReviewComment[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(initial.file);
  const [loadingPR, setLoadingPR] = useState(false);
  const [loading, setLoading] = useState(() => !loadCache(CACHE_KEY_PULLS));
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "threads" | "files" | "checks">("threads");
  const [fixJobs, setFixJobs] = useState<FixJobStatus[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [nextPollDeadline, setNextPollDeadline] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [pullFetchGeneration, setPullFetchGeneration] = useState(0);
  const [notifPermission, setNotifPermission] = useState(() =>
    "Notification" in window ? Notification.permission : "denied"
  );
  const [updateAvailable, setUpdateAvailable] = useState<{ behind: number; localSha: string; remoteSha: string } | null>(null);
  /** Sidebar empty because GitHub /user failed with no stale cache (e.g. core API throttled). */
  const [githubUserUnavailable, setGithubUserUnavailable] = useState(false);
  const lastFetchRef = useRef(Number(sessionStorage.getItem(CACHE_KEY_TIME) || "0"));
  /** Coalesces overlapping fetchPulls (e.g. duplicate poll-status SSE: lastPoll update + schedulePoll nextPoll). */
  const fetchPullsInFlightRef = useRef<Promise<void> | null>(null);

  const [appGate, setAppGate] = useState<"loading" | "setup" | "ready">("loading");
  const [setupConfig, setSetupConfig] = useState<ConfigGetResponse | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsModal, setSettingsModal] = useState<ConfigGetResponse | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pollMeta, setPollMeta] = useState({
    polling: false,
    intervalMs: 0,
    baseIntervalMs: null as number | null,
    estimatedGithubRequestsPerHour: null as number | null,
    estimatedPollRequests: null as number | null,
    pollBudgetNote: null as string | null,
    pollPaused: false,
    pollPausedReason: null as string | null,
    rateLimited: false,
    rateLimitResetAt: null as number | null,
    rateLimitRemaining: null as number | null,
    rateLimitLimit: null as number | null,
    rateLimitResource: null as string | null,
    lastPollError: null as string | null,
    claude: null as { activeEvals: number; activeFixJobs: number; evalConcurrencyCap: number; totalEvalsThisSession: number; totalFixesThisSession: number } | null,
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof sessionStorage !== "undefined" && sessionStorage.getItem("code-triage:sidebar-collapsed") === "1",
  );
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const isWide = useMediaQuery("(min-width: 768px)");
  /** Drives live countdown for GitHub rate-limit reset (updated every 1s while limited). */
  const [rateLimitNow, setRateLimitNow] = useState(() => Date.now());

  // First-run: use web settings instead of CLI prompts when ~/.code-triage/config.json is missing
  useEffect(() => {
    api
      .getConfig()
      .then((r) => {
        setSetupConfig(r);
        setPreferredEditor(r.config.preferredEditor ?? "vscode");
        setAppGate(r.needsSetup ? "setup" : "ready");
      })
      .catch((err) => {
        setError((err as Error).message);
        setAppGate("ready");
      });
  }, []);

  // Check for updates on mount
  useEffect(() => {
    api.getVersion().then((v) => {
      if (v.behind > 0) setUpdateAvailable(v);
    }).catch(() => {});
  }, []);

  // Re-check notification permission periodically (user may change it in browser settings)
  useEffect(() => {
    const interval = setInterval(() => {
      if ("Notification" in window && Notification.permission !== notifPermission) {
        setNotifPermission(Notification.permission);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [notifPermission]);

  const showNotifBanner = notifPermission === "default";

  // Client-side filtered PR lists
  const filteredPulls = useMemo(() => {
    if (!repoFilter) return pulls;
    const lower = repoFilter.toLowerCase();
    return pulls.filter((pr) => pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower));
  }, [pulls, repoFilter]);

  const filteredReviewPulls = useMemo(() => {
    const base = repoFilter
      ? reviewPulls.filter((pr) => {
          const lower = repoFilter.toLowerCase();
          return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
        })
      : reviewPulls;
    return base.filter((pr) => !isPRMuted(pr.repo, pr.number));
  }, [reviewPulls, repoFilter]);

  const mutedReviewPulls = useMemo(() => {
    const base = repoFilter
      ? reviewPulls.filter((pr) => {
          const lower = repoFilter.toLowerCase();
          return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
        })
      : reviewPulls;
    return base.filter((pr) => isPRMuted(pr.repo, pr.number));
  }, [reviewPulls, repoFilter]);

  const flatPulls = useMemo(
    () => [...filteredPulls, ...filteredReviewPulls],
    [filteredPulls, filteredReviewPulls],
  );
  const flatPullsRef = useRef(flatPulls);
  flatPullsRef.current = flatPulls;
  const selectedPRRef = useRef(selectedPR);
  selectedPRRef.current = selectedPR;

  useEffect(() => {
    sessionStorage.setItem("code-triage:sidebar-collapsed", sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (isWide) setMobileDrawerOpen(false);
  }, [isWide]);

  // Fetch pulls from API and cache. `resetRepoPollOnRefresh`: manual refresh clears adaptive `repo_poll` so the CLI recalculates hot/cold.
  const fetchPulls = useCallback(async (isInitial = false, resetRepoPollOnRefresh = false) => {
    if (fetchPullsInFlightRef.current) {
      return fetchPullsInFlightRef.current;
    }
    const run = (async () => {
      if (!isInitial) setRefreshing(true);
      try {
        if (resetRepoPollOnRefresh) {
          await api.clearRepoPollSchedule();
        }
        const { authored: pullData, reviewRequested: reviewData, githubUserUnavailable: userMissing } =
          await api.getPullsBundle();
        setPulls(pullData);
        setReviewPulls(reviewData);
        setGithubUserUnavailable(userMissing === true);
        saveCache(CACHE_KEY_PULLS, pullData);
        saveCache(CACHE_KEY_REVIEW, reviewData);
        const now = Date.now();
        sessionStorage.setItem(CACHE_KEY_TIME, String(now));
        lastFetchRef.current = now;
        setPullFetchGeneration((g) => g + 1);

        if (isInitial && pullData.length > 0 && !selectedPR) {
          setSelectedPR({ number: pullData[0].number, repo: pullData[0].repo });
        }
      } catch (err) {
        if (isInitial) setError((err as Error).message);
      } finally {
        if (isInitial) setLoading(false);
        setRefreshing(false);
      }
    })();
    fetchPullsInFlightRef.current = run;
    try {
      await run;
    } finally {
      fetchPullsInFlightRef.current = null;
    }
  }, [selectedPR]);

  // Sync URL when state changes
  useEffect(() => {
    const state: RouteState = {
      repo: selectedPR?.repo ?? null,
      prNumber: selectedPR?.number ?? null,
      file: selectedFile,
    };
    pushRoute(state);
  }, [selectedPR?.number, selectedPR?.repo, selectedFile]);

  // Handle browser back/forward
  useEffect(() => {
    function onPopState() {
      const route = parseRoute();
      if (route.repo && route.prNumber) {
        setSelectedPR({ repo: route.repo, number: route.prNumber });
      } else {
        setSelectedPR(null);
        setPrDetail(null);
        setPrFiles([]);
        setPrComments([]);
      }
      setSelectedFile(route.file);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShortcutsOpen(false);
        return;
      }
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;

      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if (shortcutsOpen) return;

      if ((e.key === "]" || e.key === "[") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const list = flatPullsRef.current;
        const cur = selectedPRRef.current;
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
          setSelectedFile(null);
          setSelectedPR({ number: next.number, repo: next.repo });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutsOpen]);

  // Load repos and user when the main app is active
  useEffect(() => {
    if (appGate !== "ready") return;
    api.getRepos().then(setRepos).catch(() => {});
    api.getUser().then((u) => setCurrentUser(u.login || null)).catch(() => {});
  }, [appGate]);

  // Initial load: use cache or fetch when the main app is active
  useEffect(() => {
    if (appGate !== "ready") return;
    const cached = loadCache<PullRequest[]>(CACHE_KEY_PULLS);
    if (cached && cached.length > 0) {
      setLoading(false);
      setPullFetchGeneration((g) => Math.max(g, 1));
      if (!selectedPR) {
        setSelectedPR({ number: cached[0].number, repo: cached[0].repo });
      }
    } else {
      fetchPulls(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appGate]);

  // Track previous fix job states for notifications
  const prevFixJobsRef = useRef<Map<number, string>>(new Map());

  const applyPollStatus = useCallback((status: PollStatus) => {
    setNextPollDeadline(status.nextPoll);
    setRefreshing(status.polling);
    setFixJobs(status.fixJobs);
    setPollMeta({
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

    for (const job of status.fixJobs) {
      const prev = prevFixJobsRef.current.get(job.commentId);
      if (prev === "running" && job.status === "completed") {
        const repoShort = job.repo.split("/")[1] ?? job.repo;
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(`Fix ready: ${repoShort}#${job.prNumber}`, {
            body: `${job.path} — review and apply the changes`,
          });
        }
      } else if (prev === "running" && job.status === "failed") {
        const repoShort = job.repo.split("/")[1] ?? job.repo;
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(`Fix failed: ${repoShort}#${job.prNumber}`, {
            body: `${job.path} — ${job.error ?? "unknown error"}`,
          });
        }
      }
    }
    prevFixJobsRef.current = new Map(status.fixJobs.map((j) => [j.commentId, j.status]));

    if (status.testNotification) {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Code Triage — Test Notification", {
          body: "Notifications are working!",
          icon: "/logo.png",
        });
      }
      void api.getPollStatus().catch(() => {});
    }

    if (status.lastPoll > lastFetchRef.current) {
      void fetchPulls();
    }
  }, [fetchPulls]);

  // One-shot snapshot before SSE connects (avoids empty timer flash)
  useEffect(() => {
    if (appGate !== "ready") return;
    api.getPollStatus().then(applyPollStatus).catch(() => {});
  }, [appGate, applyPollStatus]);

  // While rate-limited, poll-status can change as the reset window advances — refresh periodically.
  useEffect(() => {
    if (appGate !== "ready" || !pollMeta.rateLimited) return;
    const id = window.setInterval(() => {
      void api.getPollStatus().then(applyPollStatus).catch(() => {});
    }, 20_000);
    return () => window.clearInterval(id);
  }, [appGate, pollMeta.rateLimited, applyPollStatus]);

  // Tick every second so "time until reset" counts down in the sidebar.
  useEffect(() => {
    if (!pollMeta.rateLimited || pollMeta.rateLimitResetAt == null) return;
    const tick = () => setRateLimitNow(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [pollMeta.rateLimited, pollMeta.rateLimitResetAt]);

  // Local countdown between server poll-status pushes
  useEffect(() => {
    if (nextPollDeadline <= 0) return;
    const tick = () => {
      setCountdown(Math.max(0, nextPollDeadline - Date.now()));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [nextPollDeadline]);

  // Server-Sent Events — poll timer, fix jobs, and refresh pulls when backend lastPoll advances
  useEffect(() => {
    if (appGate !== "ready") return;
    const es = new EventSource("/api/events");
    es.addEventListener("poll-status", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { status?: PollStatus };
        if (data.status) applyPollStatus(data.status);
      } catch { /* ignore */ }
    });
    es.onerror = () => {
      /* browser auto-reconnects; keep quiet */
    };
    return () => es.close();
  }, [applyPollStatus, appGate]);

  // Load PR detail when selectedPR changes
  useEffect(() => {
    if (!selectedPR) return;
    let cancelled = false;

    async function loadPR() {
      setLoadingPR(true);
      try {
        const [detail, files, comments] = await Promise.all([
          api.getPull(selectedPR!.number, selectedPR!.repo),
          api.getPullFiles(selectedPR!.number, selectedPR!.repo),
          api.getPullComments(selectedPR!.number, selectedPR!.repo),
        ]);
        if (cancelled) return;
        setPrDetail(detail);
        setPrFiles(files);
        setPrComments(comments);
        if (!selectedFile) {
          const fileWithComments = files.find((f) =>
            comments.some((c) => c.path === f.filename)
          );
          setSelectedFile(fileWithComments?.filename ?? files[0]?.filename ?? null);
        }
      } catch (err) {
        console.error("Failed to load PR:", err);
      } finally {
        if (!cancelled) setLoadingPR(false);
      }
    }
    loadPR();
    return () => { cancelled = true; };
    // selectedFile intentionally excluded: only re-run when the PR changes, not on file tab switch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPR?.number, selectedPR?.repo]);

  function handleSelectPR(number: number, repo: string) {
    setSelectedFile(null);
    setSelectedPR({ number, repo });
    setMobileDrawerOpen(false);
  }

  async function reloadComments() {
    if (!selectedPR) return;
    try {
      const comments = await api.getPullComments(selectedPR.number, selectedPR.repo);
      setPrComments(comments);
    } catch (err) {
      console.error("Failed to reload comments:", err);
    }
  }

  useNotifications(pulls, reviewPulls, handleSelectPR, reloadComments, pullFetchGeneration);

  async function openSettingsModal(): Promise<void> {
    try {
      const r = await api.getConfig();
      setSettingsModal(r);
      setShowSettings(true);
    } catch {
      /* ignore */
    }
  }

  if (appGate === "loading") {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Starting…
      </div>
    );
  }

  if (appGate === "setup" && setupConfig) {
    return (
      <SettingsView
        mode="setup"
        initial={setupConfig.config}
        listenPort={setupConfig.listenPort}
        onSave={async (body) => {
          const result = await api.saveConfig(body);
          if (typeof body.preferredEditor === "string") setPreferredEditor(body.preferredEditor);
          setAppGate("ready");
          setLoading(true);
          setError(null);
          return result;
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Loading pull requests...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950 text-red-400">
        Error: {error}
      </div>
    );
  }

  const minutes = Math.floor(countdown / 60000);
  const seconds = Math.floor((countdown % 60000) / 1000);
  const timerText = `${minutes}:${seconds.toString().padStart(2, "0")}`;

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-200">
      {/* Notification permission banner */}
      {showNotifBanner && (
        <div className="bg-blue-600/90 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-sm text-white">
            Enable notifications to get alerted when PRs need your attention.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                await requestNotificationPermission();
                setNotifPermission(Notification.permission);
              }}
              className="text-sm px-3 py-1 bg-white/20 hover:bg-white/30 text-white rounded transition-colors"
            >
              Turn on notifications
            </button>
          </div>
        </div>
      )}
      {notifPermission === "denied" && (
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
            onClick={() => setUpdateAvailable(null)}
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
          className={`
            z-50 flex shrink-0 flex-col border-r border-gray-800 bg-gray-950 shadow-xl transition-[transform,width] duration-200 ease-out
            max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:w-72 max-md:max-w-[85vw]
            md:relative md:z-auto md:shadow-none
            ${!isWide && !mobileDrawerOpen ? "max-md:-translate-x-full" : "max-md:translate-x-0"}
            ${isWide ? (sidebarCollapsed ? "md:w-0 md:min-w-0 md:overflow-hidden md:border-0 md:p-0" : "md:w-72") : ""}
          `}
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
                  onClick={() => setSidebarCollapsed((c) => !c)}
                  size="sm"
                />
              )}
              <span className="text-xs text-gray-600 font-mono max-md:hidden" title="Time until next backend poll">
                {timerText}
              </span>
              <IconButton
                description="Keyboard shortcuts"
                icon={<HelpCircle size={14} />}
                onClick={() => setShortcutsOpen(true)}
                size="sm"
              />
              <IconButton
                description="Settings"
                icon={<Settings size={14} />}
                onClick={() => void openSettingsModal()}
                size="sm"
              />
              <IconButton
                description={`Test notification (permission: ${notifPermission})`}
                icon={<Bell size={14} />}
                size="sm"
                onClick={() => {
                  if ("Notification" in window) {
                    if (Notification.permission === "granted") {
                      new Notification("Code Triage — Test", { body: "Notifications are working!", icon: "/logo.png" });
                    } else if (Notification.permission === "default") {
                      Notification.requestPermission().then((p) => {
                        setNotifPermission(p);
                        if (p === "granted") {
                          new Notification("Code Triage — Test", { body: "Notifications are working!", icon: "/logo.png" });
                        }
                      });
                    } else {
                      alert("Notifications are blocked. Please enable them in your browser settings.");
                    }
                  }
                }}
              />
              <IconButton
                description="Refresh lists and reset adaptive poll schedule"
                icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />}
                onClick={() => void fetchPulls(false, true)}
                disabled={refreshing}
                size="sm"
              />
            </div>
          </div>
          <div className="px-3 py-2 border-b border-gray-800 grid grid-cols-2 gap-x-4 text-[10px] text-gray-500">
            {/* GitHub column */}
            <div className="flex flex-col gap-1">
              <span className="text-gray-600 font-medium uppercase tracking-wide">GitHub</span>
              <div className="flex items-center gap-1.5">
                {pollMeta.polling && <span className="text-cyan-400/90">Polling…</span>}
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
                        className={`h-full block rounded-full transition-all ${pct >= 0.8 ? "bg-red-500" : pct >= 0.6 ? "bg-orange-500" : "bg-green-500"}`}
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
          <RepoFilter
            filter={repoFilter}
            onFilterChange={setRepoFilter}
          />
          <div className="overflow-y-auto flex-1">
            <div className="px-4 py-1.5 text-xs text-gray-500 uppercase tracking-wide border-b border-gray-800">
              My Pull Requests
            </div>
            <PRList
              pulls={filteredPulls}
              selectedPR={selectedPR}
              onSelectPR={handleSelectPR}
              showRepo
            />
            {filteredReviewPulls.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-xs text-gray-500 uppercase tracking-wide border-y border-gray-800 bg-gray-900/30">
                  Needs My Review ({filteredReviewPulls.length})
                </div>
                <PRList
                  pulls={filteredReviewPulls}
                  selectedPR={selectedPR}
                  onSelectPR={handleSelectPR}
                  showRepo
                />
              </>
            )}
            {mutedReviewPulls.length > 0 && (
              <MutedReviewSection
                pulls={mutedReviewPulls}
                selectedPR={selectedPR}
                onSelectPR={handleSelectPR}
              />
            )}
          </div>
        </div>

        {/* Main area */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {isWide && sidebarCollapsed && (
            <IconButton
              description="Expand sidebar"
              icon={<PanelLeftOpen size={14} />}
              className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-l-none rounded-r border border-l-0 border-gray-800 bg-gray-900/95 px-1 py-4 text-gray-400 hover:text-white"
              onClick={() => setSidebarCollapsed(false)}
            />
          )}
          {loadingPR ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              Loading...
            </div>
          ) : prDetail ? (
            <>
              <PRDetail pr={prDetail} currentUser={currentUser} onReviewSubmitted={async () => {
                if (!selectedPR) return;
                try {
                  const detail = await api.getPull(selectedPR.number, selectedPR.repo);
                  setPrDetail(detail);
                } catch { /* ignore */ }
              }} />
              {/* Tab bar */}
              <div className="flex border-b border-gray-800 shrink-0">
                {([
                  { id: "overview" as const, label: "Overview" },
                  { id: "threads" as const, label: `Review (${prComments.filter((c) => c.inReplyToId === null).length})` },
                  { id: "files" as const, label: `Files (${prFiles.length})` },
                  { id: "checks" as const, label: prDetail.checksSummary
                    ? prDetail.checksSummary.failure > 0
                      ? `Checks (${prDetail.checksSummary.failure}/${prDetail.checksSummary.total})`
                      : `Checks (${prDetail.checksSummary.total})`
                    : "Checks" },
                ]).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-5 py-2 text-sm transition-colors rounded-t focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950 ${
                      activeTab === tab.id
                        ? "text-white border-b-2 border-blue-500 -mb-px"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      {tab.id === "checks" && prDetail?.checksSummary && (
                        <span className={`inline-block w-2 h-2 rounded-full ${
                          prDetail.checksSummary.failure > 0 ? "bg-red-400" :
                          prDetail.checksSummary.pending > 0 ? "bg-yellow-400" :
                          "bg-green-400"
                        }`} />
                      )}
                      {tab.label}
                    </span>
                  </button>
                ))}
              </div>

              {/* Tab content */}
              {activeTab === "overview" && (
                <PROverview pr={prDetail} />
              )}

              {activeTab === "threads" && (
                <CommentThreads
                  comments={prComments}
                  onSelectFile={(f) => { setActiveTab("files"); setSelectedFile(f); }}
                  repo={selectedPR!.repo}
                  prNumber={selectedPR!.number}
                  branch={prDetail.branch}
                  fixJobs={fixJobs}
                  onCommentAction={reloadComments}
                  onFixStarted={(job) => setFixJobs((prev) => [...prev.filter((j) => j.commentId !== job.commentId), job])}
                  globalModalOpen={shortcutsOpen}
                  onOpenShortcutsHelp={() => setShortcutsOpen(true)}
                />
              )}

              {activeTab === "files" && (
                <>
                  <FileList
                    files={prFiles}
                    selectedFile={selectedFile}
                    onSelectFile={setSelectedFile}
                    comments={prComments}
                  />
                  <div className="flex-1 overflow-y-auto">
                    {selectedFile ? (
                      (() => {
                        const file = prFiles.find((f) => f.filename === selectedFile);
                        const fileComments = prComments.filter((c) => c.path === selectedFile);
                        return file ? (
                          <DiffView
                            patch={file.patch}
                            filename={file.filename}
                            comments={fileComments}
                            repo={selectedPR!.repo}
                            prNumber={selectedPR!.number}
                            commitId={prDetail.headSha}
                            onCommentCreated={reloadComments}
                          />
                        ) : null;
                      })()
                    ) : (
                      <div className="text-gray-500 text-center mt-12">Select a file to view its diff</div>
                    )}
                  </div>
                </>
              )}

              {activeTab === "checks" && selectedPR && (
                <ChecksPanel
                  prNumber={selectedPR.number}
                  repo={selectedPR.repo}
                  headSha={prDetail.headSha}
                  onSelectFile={(f) => { setActiveTab("files"); setSelectedFile(f); }}
                />
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              Select a pull request
            </div>
          )}
        </div>
      </div>
      <FixJobsBanner fixJobs={fixJobs} onJobAction={() => { reloadComments(); }} />

      <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {showSettings && settingsModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
          <div className="my-8 w-full max-w-3xl rounded-lg border border-gray-800 bg-gray-950 shadow-xl max-h-[calc(100vh-4rem)] overflow-hidden flex flex-col">
            <SettingsView
              mode="settings"
              initial={settingsModal.config}
              listenPort={settingsModal.listenPort}
              onCancel={() => {
                setShowSettings(false);
                setSettingsModal(null);
              }}
              onSave={async (body) => {
                const result = await api.saveConfig(body);
                if (typeof body.preferredEditor === "string") setPreferredEditor(body.preferredEditor);
                setShowSettings(false);
                setSettingsModal(null);
                await fetchPulls(false);
                try {
                  const r = await api.getRepos();
                  setRepos(r);
                } catch {
                  /* ignore */
                }
                return result;
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
