import { useEffect, useState } from "react";
import { api } from "./api";
import type { PullRequest, PullRequestDetail, PullFile, ReviewComment } from "./types";
import PRList from "./components/PRList";
import PRDetail from "./components/PRDetail";

export default function App() {
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [selectedPR, setSelectedPR] = useState<number | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<number, number>>({});
  const [prDetail, setPrDetail] = useState<PullRequestDetail | null>(null);
  const [prFiles, setPrFiles] = useState<PullFile[]>([]);
  const [prComments, setPrComments] = useState<ReviewComment[]>([]);
  const [loadingPR, setLoadingPR] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const pullData = await api.getPulls();
        setPulls(pullData);

        // Fetch comment counts for each PR
        const counts: Record<number, number> = {};
        for (const pr of pullData) {
          try {
            const comments = await api.getPullComments(pr.number);
            counts[pr.number] = comments.length;
          } catch {
            counts[pr.number] = 0;
          }
        }
        setCommentCounts(counts);

        if (pullData.length > 0) {
          setSelectedPR(pullData[0].number);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useEffect(() => {
    if (!selectedPR) return;
    let cancelled = false;

    async function loadPR() {
      setLoadingPR(true);
      try {
        const [detail, files, comments] = await Promise.all([
          api.getPull(selectedPR!),
          api.getPullFiles(selectedPR!),
          api.getPullComments(selectedPR!),
        ]);
        if (cancelled) return;
        setPrDetail(detail);
        setPrFiles(files);
        setPrComments(comments);
      } catch (err) {
        console.error("Failed to load PR:", err);
      } finally {
        if (!cancelled) setLoadingPR(false);
      }
    }
    loadPR();
    return () => { cancelled = true; };
  }, [selectedPR]);

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
        <div className="overflow-y-auto flex-1">
          <PRList
            pulls={pulls}
            selectedPR={selectedPR}
            onSelectPR={setSelectedPR}
            commentCounts={commentCounts}
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
            <div className="flex-1 overflow-y-auto p-6 text-gray-500">
              {prFiles.length} file(s), {prComments.length} comment(s)
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
