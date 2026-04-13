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
import SettingsView from "./components/SettingsView";
import type { FixJobStatus, PollStatus } from "./api";

interface SelectedPR {
  number: number;
  repo: string;
}

function MutedReviewSection({ pulls, selectedPR, onSelectPR }: {
  pulls: PullRequest[];
  selectedPR: SelectedPR | null;
  onSelectPR: (number: number, repo: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-1.5 text-xs text-gray-600 uppercase tracking-wide border-y border-gray-800 bg-gray-900/20 flex items-center justify-between hover:bg-gray-800/30"
      >
        <span>Muted ({pulls.length})</span>
        <span className="text-gray-700">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="opacity-60">
          <PRList
            pulls={pulls}
            selectedPR={selectedPR}
            onSelectPR={onSelectPR}
            showRepo
          />
        </div>
      )}
    </>
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
  const [activeTab, setActiveTab] = useState<"overview" | "threads" | "files">("threads");
  const [fixJobs, setFixJobs] = useState<FixJobStatus[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [nextPollDeadline, setNextPollDeadline] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [pullFetchGeneration, setPullFetchGeneration] = useState(0);
  const [notifPermission, setNotifPermission] = useState(() =>
    "Notification" in window ? Notification.permission : "denied"
  );
  const [updateAvailable, setUpdateAvailable] = useState<{ behind: number; localSha: string; remoteSha: string } | null>(null);
  const lastFetchRef = useRef(Number(sessionStorage.getItem(CACHE_KEY_TIME) || "0"));

  const [appGate, setAppGate] = useState<"loading" | "setup" | "ready">("loading");
  const [setupConfig, setSetupConfig] = useState<ConfigGetResponse | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsModal, setSettingsModal] = useState<ConfigGetResponse | null>(null);

  // First-run: use web settings instead of CLI prompts when ~/.code-triage/config.json is missing
  useEffect(() => {
    api
      .getConfig()
      .then((r) => {
        setSetupConfig(r);
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

  // Fetch pulls from API and cache
  const fetchPulls = useCallback(async (isInitial = false) => {
    if (!isInitial) setRefreshing(true);
    try {
      const [pullData, reviewData] = await Promise.all([
        api.getPulls(),
        api.getReviewRequested(),
      ]);
      setPulls(pullData);
      setReviewPulls(reviewData);
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

  // Load repos and user when the main app is active
  useEffect(() => {
    if (appGate !== "ready") return;
    api.getRepos().then(setRepos).catch(() => {});
    api.getUser().then((u) => setCurrentUser(u.login)).catch(() => {});
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
            A new version of Code Triage is available ({updateAvailable.behind} commit{updateAvailable.behind > 1 ? "s" : ""} behind, {updateAvailable.localSha} → {updateAvailable.remoteSha}).
            Run <code className="bg-black/20 px-1 rounded">git pull && yarn build:all</code> to update.
          </span>
          <button
            onClick={() => setUpdateAvailable(null)}
            className="text-white/70 hover:text-white ml-4 text-lg"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-72 border-r border-gray-800 flex flex-col shrink-0">
          <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="Code Triage" className="w-6 h-6 rounded-md" />
              <h1 className="text-sm font-semibold text-white">Code Triage</h1>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600 font-mono" title="Time until next backend poll">
                {timerText}
              </span>
              <button
                type="button"
                onClick={() => void openSettingsModal()}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                title="Settings"
              >
                ⚙
              </button>
              <button
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
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                title={`Test notification (permission: ${notifPermission})`}
              >
                🔔
              </button>
              <button
                onClick={() => fetchPulls()}
                disabled={refreshing}
                className="text-xs text-gray-500 hover:text-gray-300 disabled:text-gray-700 transition-colors"
                title="Refresh now"
              >
                {refreshing ? "↻" : "⟳"}
              </button>
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
        <div className="flex-1 flex flex-col overflow-hidden">
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
                ]).map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-5 py-2 text-sm transition-colors ${
                      activeTab === tab.id
                        ? "text-white border-b-2 border-blue-500 -mb-px"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {tab.label}
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
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              Select a pull request
            </div>
          )}
        </div>
      </div>
      <FixJobsBanner fixJobs={fixJobs} onJobAction={() => { reloadComments(); }} />

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
                setShowSettings(false);
                setSettingsModal(null);
                await fetchPulls(false);
                try {
                  const repos = await api.getRepos();
                  setRepos(repos);
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
