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
import { useNotifications } from "./useNotifications";

interface SelectedPR {
  number: number;
  repo: string;
}

const REFRESH_INTERVAL = 5 * 60_000; // 5 minutes
const CACHE_KEY_PULLS = "cr-watch:pulls";
const CACHE_KEY_REVIEW = "cr-watch:reviewPulls";
const CACHE_KEY_TIME = "cr-watch:lastRefresh";

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
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const lastRefreshRef = useRef(Number(sessionStorage.getItem(CACHE_KEY_TIME) || "0"));

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
      lastRefreshRef.current = now;
      setCountdown(REFRESH_INTERVAL);

      // Auto-select first PR only if nothing selected
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

  // Load repos on mount
  useEffect(() => {
    api.getRepos().then(setRepos).catch(() => {});
  }, []);

  // Initial load: use cache if fresh enough, otherwise fetch
  useEffect(() => {
    const cached = loadCache<PullRequest[]>(CACHE_KEY_PULLS);
    const elapsed = Date.now() - lastRefreshRef.current;

    if (cached && cached.length > 0 && elapsed < REFRESH_INTERVAL) {
      // Cache is fresh — just set countdown for remaining time
      setLoading(false);
      setCountdown(REFRESH_INTERVAL - elapsed);

      // Still auto-select if needed
      if (cached.length > 0 && !selectedPR) {
        setSelectedPR({ number: cached[0].number, repo: cached[0].repo });
      }
    } else {
      fetchPulls(true);
    }
  }, []);

  // Auto-refresh timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((prev) => {
        const next = prev - 1000;
        if (next <= 0) {
          fetchPulls();
          return REFRESH_INTERVAL;
        }
        return next;
      });
    }, 1000);
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
    <div className="h-screen flex bg-gray-950 text-gray-200">
      {/* Sidebar */}
      <div className="w-72 border-r border-gray-800 flex flex-col shrink-0">
        <div className="px-4 py-2 border-b border-gray-800 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-white">cr-watch</h1>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-600 font-mono">{timerText}</span>
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
            <PRDetail pr={prDetail} />
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
  );
}
