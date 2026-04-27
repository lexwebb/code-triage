import { useEffect } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

function statusDot(status: "success" | "failure" | "pending"): string {
  if (status === "failure") return "bg-red-400";
  if (status === "success") return "bg-green-400";
  return "bg-yellow-400";
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return min > 0 ? `${min}m ${rem}s` : `${rem}s`;
}

export default function CiPanel() {
  const detail = useAppStore((s) => s.detail);
  const data = useAppStore((s) => s.ciData);
  const error = useAppStore((s) => s.ciError);
  const fetchCi = useAppStore((s) => s.fetchCi);
  const openCiLog = useAppStore((s) => s.openCiLog);
  const loadMore = useAppStore((s) => s.loadMoreCiLog);
  const closeLog = useAppStore((s) => s.closeCiLog);
  const logRun = useAppStore((s) => s.ciLogRun);
  const logOpen = useAppStore((s) => s.ciLogOpen);
  const logText = useAppStore((s) => s.ciLogText);
  const logLoading = useAppStore((s) => s.ciLogLoading);
  const logError = useAppStore((s) => s.ciLogError);
  const logNextCursor = useAppStore((s) => s.ciLogNextCursor);

  useEffect(() => {
    void fetchCi(detail?.headSha);
  }, [detail?.headSha, fetchCi]);

  if (error) return <div className="text-red-400 text-sm p-4">{error}</div>;
  if (data === null) {
    return <div className="p-4 text-sm text-gray-500">Loading CI data...</div>;
  }

  return (
    <div className="overflow-y-auto flex-1">
      <div className="p-4 border-b border-gray-800 text-sm text-gray-300">
        <span className={cn("inline-block w-2 h-2 rounded-full mr-2", statusDot(data.overallStatus))} />
        Overall status: {data.overallStatus}
      </div>
      {data.providers.map((provider) => (
        <div key={provider.provider} className="border-b border-gray-800">
          <div className="px-4 py-2 text-xs uppercase tracking-wide text-gray-500 flex items-center gap-2">
            <span className={cn("inline-block w-2 h-2 rounded-full", statusDot(provider.status))} />
            {provider.provider === "github-actions" ? "GitHub Actions" : "CircleCI"}
          </div>
          {provider.runs.length === 0 ? (
            <div className="px-4 pb-3 text-sm text-gray-600">No runs for this PR commit.</div>
          ) : (
            provider.runs.map((run) => (
              <div key={`${run.provider}-${run.id}`}>
                <div className="px-4 py-2 text-sm flex items-center gap-3 hover:bg-gray-900/40">
                  <span className={cn("inline-block w-2 h-2 rounded-full", statusDot(run.status))} />
                  <div className="flex-1 min-w-0">
                    <div className="text-gray-200 truncate">{run.name}</div>
                    <div className="text-xs text-gray-500">{formatDuration(run.durationMs)}</div>
                  </div>
                  {run.logsAvailable && (
                    <Button
                      size="xs"
                      variant="gray"
                      onClick={() => {
                        if (logOpen && logRun?.id === run.id && logRun.provider === run.provider) {
                          closeLog();
                          return;
                        }
                        void openCiLog(run);
                      }}
                    >
                      {logOpen && logRun?.id === run.id && logRun.provider === run.provider ? "Hide logs" : "Logs"}
                    </Button>
                  )}
                  {run.htmlUrl && (
                    <a
                      href={run.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-500 hover:text-gray-300"
                      title="Open in provider"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
                {logOpen && logRun?.id === run.id && logRun.provider === run.provider && (
                  <div className="mx-4 mb-3 rounded border border-gray-800 bg-gray-950">
                    <div className="p-3 max-h-[360px] overflow-auto">
                      {logLoading && logText.length === 0 ? (
                        <div className="text-gray-500 text-sm flex items-center gap-2"><Loader2 className="animate-spin" size={14} />Loading logs...</div>
                      ) : logError ? (
                        <div className="text-red-400 text-sm">{logError}</div>
                      ) : (
                        <pre className="text-xs text-gray-200 whitespace-pre-wrap wrap-break-word">{logText || "No log output."}</pre>
                      )}
                    </div>
                    <div className="px-3 py-2 border-t border-gray-800 flex items-center justify-between">
                      <Button size="xs" variant="gray" onClick={() => closeLog()}>Close</Button>
                      <Button
                        size="xs"
                        variant="gray"
                        onClick={() => void loadMore()}
                        disabled={!logNextCursor || logLoading}
                      >
                        {logLoading && logText.length > 0 ? "Loading..." : "Load more"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
