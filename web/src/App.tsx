import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { api } from "./api";
import type { PullRequest, PullRequestDetail, PullFile, ReviewComment, RepoInfo } from "./types";
import { parseRoute, pushRoute, type RouteState } from "./router";
import RepoFilter from "./components/RepoSelector";
import PRList from "./components/PRList";
import PRDetail from "./components/PRDetail";
import FileList from "./components/FileList";
import DiffView from "./components/DiffView";
import CommentThreads from "./components/CommentThreads";
import { useNotifications, requestNotificationPermission } from "./useNotifications";

interface SelectedPR {
  number: number;
  repo: string;
}

const CACHE_KEY_PULLS = "code-triage:pulls";
const CACHE_KEY_REVIEW = "code-triage:reviewPulls";
const CACHE_KEY_TIME = "code-triage:lastFetch";
const BACKEND_POLL_INTERVAL = 5_000; // check backend poll status every 5s

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
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [notifPermission, setNotifPermission] = useState(() =>
    "Notification" in window ? Notification.permission : "denied"
  );
  const lastFetchRef = useRef(Number(sessionStorage.getItem(CACHE_KEY_TIME) || "0"));

  const showNotifBanner = notifPermission === "default";

  // Client-side filtered PR lists
  const filteredPulls = useMemo(() => {
    if (!repoFilter) return pulls;
    const lower = repoFilter.toLowerCase();
    return pulls.filter((pr) => pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower));
  }, [pulls, repoFilter]);

  const filteredReviewPulls = useMemo(() => {
    if (!repoFilter) return reviewPulls;
    const lower = repoFilter.toLowerCase();
    return reviewPulls.filter((pr) => pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower));
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

  // Load repos and user on mount
  useEffect(() => {
    api.getRepos().then(setRepos).catch(() => {});
    api.getUser().then((u) => setCurrentUser(u.login)).catch(() => {});
  }, []);

  // Initial load: use cache or fetch
  useEffect(() => {
    const cached = loadCache<PullRequest[]>(CACHE_KEY_PULLS);
    if (cached && cached.length > 0) {
      setLoading(false);
      if (!selectedPR) {
        setSelectedPR({ number: cached[0].number, repo: cached[0].repo });
      }
    } else {
      fetchPulls(true);
    }
  }, []);

  // Poll backend status — refresh frontend data when backend has polled since our last fetch
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await api.getPollStatus();
        // Update countdown from backend's next poll time
        const remaining = Math.max(0, status.nextPoll - Date.now());
        setCountdown(remaining);
        setRefreshing(status.polling);

        // If backend has polled since our last fetch, refresh data
        if (status.lastPoll > lastFetchRef.current) {
          await fetchPulls();
        }
      } catch { /* backend not reachable */ }
    }, BACKEND_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchPulls]);

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

  useNotifications(pulls, reviewPulls, handleSelectPR, reloadComments);

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
                } catch {}
              }} />
              <CommentThreads
                comments={prComments}
                onSelectFile={(f) => { setFilesExpanded(true); setSelectedFile(f); }}
                repo={selectedPR!.repo}
                prNumber={selectedPR!.number}
                branch={prDetail.branch}
                onCommentAction={reloadComments}
              />
              {/* Collapsible files section */}
              <div className="border-t border-gray-800 shrink-0">
                <button
                  onClick={() => setFilesExpanded(!filesExpanded)}
                  className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30"
                >
                  <span>Files Changed ({prFiles.length})</span>
                  <span className="text-gray-600">{filesExpanded ? "▼" : "▶"}</span>
                </button>
              </div>
              {filesExpanded && (
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
                          <DiffView patch={file.patch} filename={file.filename} comments={fileComments} />
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
    </div>
  );
}
