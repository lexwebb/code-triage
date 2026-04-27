import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import PRDetail from "./pr-detail";
import FileList from "./file-list";
import DiffView from "./diff-view";
import CommentThreads from "./comment-threads";
import { PrCompanionPanel } from "./pr-companion-panel";
import PROverview from "./pr-overview";
import ChecksPanel from "./checks-panel";
import CiPanel from "./ci-panel";
import { cn } from "../lib/utils";
import { useAppStore } from "../store";
import { Skeleton } from "./ui/skeleton";
import { LoadingBoundary, usePrDetailLoading } from "./loading-boundary";

interface Props {
  owner?: string;
  repo?: string;
  number?: number;
  tab?: "overview" | "threads" | "files" | "checks" | "ci";
  file?: string;
}

function PrReviewDetailSkeleton() {
  return (
    <div className="flex-1 space-y-3 p-4">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function CodeReviewDetail({ owner, repo, number, tab, file }: Props) {
  const navigate = useNavigate();

  const detail = useAppStore((s) => s.detail);
  const files = useAppStore((s) => s.files);
  const comments = useAppStore((s) => s.comments);
  const prDetailLoading = usePrDetailLoading();
  const prToTickets = useAppStore((s) => s.prToTickets);
  const navigateToLinkedTicket = useAppStore((s) => s.navigateToLinkedTicket);

  // Determine the active tab — fall back to "threads" if none provided
  const activeTab = tab ?? "threads";

  // Sync PR selection from route params
  useEffect(() => {
    if (owner && repo && number) {
      const fullRepo = `${owner}/${repo}`;
      void useAppStore.getState().selectPR(number, fullRepo);
    } else {
      // No PR in URL — if store has a selectedPR, navigate to it so URL reflects state
      const current = useAppStore.getState().selectedPR;
      if (current) {
        const [o, r] = current.repo.split("/");
        void navigate({
          to: "/reviews/$owner/$repo/pull/$number",
          params: { owner: o!, repo: r!, number: String(current.number) },
          search: { tab: "threads", file: undefined },
          replace: true,
        });
      }
    }
  }, [owner, repo, number, navigate]);

  // Sync repo filter from route params
  useEffect(() => {
    if (!number) {
      useAppStore.getState().setRepoFilter(owner && repo ? `${owner}/${repo}` : "");
    }
  }, [owner, repo, number]);

  // Sync selectedFile from file prop
  useEffect(() => {
    useAppStore.getState().selectFile(file ?? null);
  }, [file]);

  function setTab(newTab: "overview" | "threads" | "files" | "checks" | "ci") {
    if (owner && repo && number) {
      void navigate({
        to: "/reviews/$owner/$repo/pull/$number",
        params: { owner, repo, number: String(number) },
        search: (prev) => ({ tab: newTab, file: prev.file }),
      });
    }
  }

  function selectFile(path: string) {
    if (owner && repo && number) {
      void navigate({
        to: "/reviews/$owner/$repo/pull/$number",
        params: { owner, repo, number: String(number) },
        search: (prev) => ({ ...prev, tab: "files" as const, file: path }),
      });
    }
  }

  if (!detail) {
    return (
      <LoadingBoundary
        when={prDetailLoading}
        fallback={<PrReviewDetailSkeleton />}
      >
        <div className="flex-1 flex items-center justify-center text-gray-500">
          Select a pull request
        </div>
      </LoadingBoundary>
    );
  }

  return (
    <LoadingBoundary
      when={prDetailLoading}
      fallback={<PrReviewDetailSkeleton />}
    >
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
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
          { id: "ci" as const, label: "CI" },
        ]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "px-5 py-2 text-sm transition-colors rounded-t focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950",
              activeTab === t.id
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
      {activeTab === "threads" && (
        <div className="flex flex-1 flex-col md:flex-row min-h-0 overflow-hidden">
          <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
            <CommentThreads />
          </div>
          <PrCompanionPanel repo={detail.repo} prNumber={detail.number} comments={comments} />
        </div>
      )}
      {activeTab === "files" && (
        <>
          <FileList onSelectFile={selectFile} />
          <div className="flex-1 overflow-y-auto">
            {file ? <DiffView /> : (
              <div className="text-gray-500 text-center mt-12">Select a file to view its diff</div>
            )}
          </div>
        </>
      )}
      {activeTab === "checks" && <ChecksPanel />}
      {activeTab === "ci" && <CiPanel />}
    </div>
    </LoadingBoundary>
  );
}
