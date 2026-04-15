import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import type { CheckRun, CheckAnnotation } from "../types";
import { CollapsibleSection } from "./ui/collapsible-section";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Minus,
  CircleDot,
  Timer,
  AlertTriangle,
  ExternalLink,
  Loader2,
  FileCode,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Skeleton } from "./ui/skeleton";

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function RunStatusIcon({ run }: { run: CheckRun }) {
  if (run.status === "in_progress") {
    return <Loader2 size={16} className="text-yellow-400 animate-spin" />;
  }
  if (run.status === "queued") {
    return <CircleDot size={16} className="text-yellow-400" />;
  }
  switch (run.conclusion) {
    case "success":
      return <CheckCircle2 size={16} className="text-green-400" />;
    case "failure":
      return <XCircle size={16} className="text-red-400" />;
    case "cancelled":
      return <XCircle size={16} className="text-gray-500" />;
    case "timed_out":
      return <Timer size={16} className="text-red-400" />;
    case "action_required":
      return <AlertTriangle size={16} className="text-orange-400" />;
    case "skipped":
    case "neutral":
      return <Minus size={16} className="text-gray-500" />;
    default:
      return <Clock size={16} className="text-gray-500" />;
  }
}

function SuiteStatusIcon({ conclusion }: { conclusion: string | null }) {
  if (conclusion === "success") return <CheckCircle2 size={14} className="text-green-400" />;
  if (conclusion === "failure") return <XCircle size={14} className="text-red-400" />;
  return <Loader2 size={14} className="text-yellow-400 animate-spin" />;
}

function AnnotationLevelBadge({ level }: { level: CheckAnnotation["level"] }) {
  const styles = {
    failure: "bg-red-900/50 text-red-300",
    warning: "bg-yellow-900/50 text-yellow-300",
    notice: "bg-blue-900/50 text-blue-300",
  };
  return (
    <span className={cn("text-xs px-1.5 py-0.5 rounded", styles[level])}>
      {level}
    </span>
  );
}

function AnnotationsList({
  annotations,
  onSelectFile,
}: {
  annotations: CheckAnnotation[];
  onSelectFile?: (file: string) => void;
}) {
  return (
    <div className="ml-8 mb-2 space-y-1">
      {annotations.map((a, i) => (
        <div key={i} className="text-xs bg-gray-900/60 border border-gray-800 rounded px-3 py-2">
          <div className="flex items-center gap-2 mb-1">
            <AnnotationLevelBadge level={a.level} />
            {a.title && <span className="text-gray-300 font-medium">{a.title}</span>}
          </div>
          <button
            type="button"
            className="flex items-center gap-1 text-blue-400 hover:text-blue-300 mb-1"
            onClick={() => onSelectFile?.(a.path)}
          >
            <FileCode size={12} />
            {a.path}:{a.startLine}{a.endLine !== a.startLine ? `-${a.endLine}` : ""}
          </button>
          <pre className="text-gray-400 whitespace-pre-wrap break-words">{a.message}</pre>
        </div>
      ))}
    </div>
  );
}

function CheckRunRow({
  run,
  onSelectFile,
}: {
  run: CheckRun;
  onSelectFile?: (file: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasAnnotations = run.annotations.length > 0;

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-1.5 hover:bg-gray-800/30">
        <RunStatusIcon run={run} />
        <button
          type="button"
          className={cn("flex-1 text-left text-sm text-gray-200", hasAnnotations ? "cursor-pointer hover:text-white" : "")}
          onClick={() => hasAnnotations && setExpanded(!expanded)}
          disabled={!hasAnnotations}
        >
          <span className="flex items-center gap-1.5">
            {run.name}
            {hasAnnotations && (
              expanded
                ? <ChevronDown size={12} className="text-gray-500" />
                : <ChevronRight size={12} className="text-gray-500" />
            )}
          </span>
        </button>
        {run.durationMs != null && (
          <span className="text-xs text-gray-500">{formatDuration(run.durationMs)}</span>
        )}
        <a
          href={run.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-600 hover:text-gray-400"
          title="View on GitHub"
        >
          <ExternalLink size={14} />
        </a>
      </div>
      {expanded && hasAnnotations && (
        <AnnotationsList annotations={run.annotations} onSelectFile={onSelectFile} />
      )}
    </div>
  );
}

export default function ChecksPanel() {
  const detail = useAppStore((s) => s.detail);
  const suites = useAppStore((s) => s.checkSuites);
  const error = useAppStore((s) => s.checksError);
  const fetchChecks = useAppStore((s) => s.fetchChecks);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const selectFile = useAppStore((s) => s.selectFile);

  useEffect(() => {
    fetchChecks(detail?.headSha);
  }, [detail?.headSha, fetchChecks]);

  const onSelectFile = (f: string) => {
    setActiveTab("files");
    selectFile(f);
  };

  if (error) {
    return <div className="text-red-400 text-sm p-4">{error}</div>;
  }

  if (suites === null) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (suites.length === 0) {
    return <div className="text-gray-500 text-center mt-12">No CI checks found for this commit</div>;
  }

  return (
    <div className="overflow-y-auto flex-1">
      {suites.map((suite) => (
        <CollapsibleSection
          key={suite.id}
          defaultOpen={suite.conclusion === "failure" || suite.conclusion === null}
          title={
            <span className="flex items-center gap-2">
              <SuiteStatusIcon conclusion={suite.conclusion} />
              {suite.name}
              <span className="text-gray-600">({suite.runs.length})</span>
            </span>
          }
          className="px-4 py-2 text-sm text-gray-300 border-b border-gray-800"
        >
          <div className="divide-y divide-gray-800/50">
            {suite.runs.map((run) => (
              <CheckRunRow key={run.id} run={run} onSelectFile={onSelectFile} />
            ))}
          </div>
        </CollapsibleSection>
      ))}
    </div>
  );
}
