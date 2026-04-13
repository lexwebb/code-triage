import { useEffect, useState } from "react";
import { api } from "./api";
import type { PullRequest, PullRequestDetail, PullFile, ReviewComment, RepoInfo } from "./types";
import RepoSelector from "./components/RepoSelector";
import PRList from "./components/PRList";
import PRDetail from "./components/PRDetail";
import FileList from "./components/FileList";
import DiffView from "./components/DiffView";
import CommentThreads from "./components/CommentThreads";

interface SelectedPR {
  number: number;
  repo: string;
}

export default function App() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [selectedPR, setSelectedPR] = useState<SelectedPR | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [prDetail, setPrDetail] = useState<PullRequestDetail | null>(null);
  const [prFiles, setPrFiles] = useState<PullFile[]>([]);
  const [prComments, setPrComments] = useState<ReviewComment[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loadingPR, setLoadingPR] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load repos on mount
  useEffect(() => {
    api.getRepos().then(setRepos).catch(() => {});
  }, []);

  // Load pulls when selectedRepo changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const pullData = await api.getPulls(selectedRepo ?? undefined);
        if (cancelled) return;
        setPulls(pullData);

        // Fetch comment counts
        const counts: Record<string, number> = {};
        for (const pr of pullData) {
          try {
            const comments = await api.getPullComments(pr.number, pr.repo);
            counts[`${pr.repo}:${pr.number}`] = comments.length;
          } catch {
            counts[`${pr.repo}:${pr.number}`] = 0;
          }
        }
        if (cancelled) return;
        setCommentCounts(counts);

        if (pullData.length > 0 && !selectedPR) {
          setSelectedPR({ number: pullData[0].number, repo: pullData[0].repo });
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [selectedRepo]);

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
        const fileWithComments = files.find((f) =>
          comments.some((c) => c.path === f.filename)
        );
        setSelectedFile(fileWithComments?.filename ?? files[0]?.filename ?? null);
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
    setSelectedPR({ number, repo });
  }

  function handleSelectRepo(repo: string | null) {
    setSelectedRepo(repo);
    setSelectedPR(null);
    setPrDetail(null);
    setPrFiles([]);
    setPrComments([]);
    setSelectedFile(null);
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

  return (
    <div className="h-screen flex bg-gray-950 text-gray-200">
      {/* Sidebar */}
      <div className="w-72 border-r border-gray-800 flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-gray-800">
          <h1 className="text-sm font-semibold text-white">cr-watch</h1>
        </div>
        <RepoSelector
          repos={repos}
          selectedRepo={selectedRepo}
          onSelectRepo={handleSelectRepo}
        />
        <div className="overflow-y-auto flex-1">
          <PRList
            pulls={pulls}
            selectedPR={selectedPR}
            onSelectPR={handleSelectPR}
            commentCounts={commentCounts}
            showRepo={!selectedRepo}
          />
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
              onSelectFile={setSelectedFile}
            />
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
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            Select a pull request
          </div>
        )}
      </div>
    </div>
  );
}
