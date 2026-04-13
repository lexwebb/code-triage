import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { ReviewComment } from "../types";
import { api } from "../api";
import type { FixJobStatus } from "../api";
import Comment from "./Comment";

type ThreadKeyActions = {
  toggleExpand: () => void;
  reply: () => void;
  resolve: () => void;
  dismiss: () => void;
  fix: () => void;
  reEvaluate: () => void;
};

interface CommentThreadsProps {
  comments: ReviewComment[];
  onSelectFile: (filename: string) => void;
  repo: string;
  prNumber: number;
  branch: string;
  fixJobs: FixJobStatus[];
  onCommentAction: () => void;
  onFixStarted: (job: FixJobStatus) => void;
  /** When true, thread hotkeys are disabled (e.g. shortcuts modal open). */
  globalModalOpen?: boolean;
  onOpenShortcutsHelp?: () => void;
}

interface Thread {
  root: ReviewComment;
  replies: ReviewComment[];
  isResolved: boolean;
}

function buildThreads(comments: ReviewComment[]): Thread[] {
  const rootComments = comments.filter((c) => c.inReplyToId === null);
  const replyMap = new Map<number, ReviewComment[]>();

  for (const c of comments) {
    if (c.inReplyToId !== null) {
      const existing = replyMap.get(c.inReplyToId) ?? [];
      existing.push(c);
      replyMap.set(c.inReplyToId, existing);
    }
  }

  const threads: Thread[] = rootComments.map((root) => {
    const replies = (replyMap.get(root.id) ?? []).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const isResolved = root.isResolved || replies.some((r) => r.isResolved);
    return { root, replies, isResolved };
  });

  threads.sort((a, b) => {
    if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1;
    const pa = a.root.priority ?? 0;
    const pb = b.root.priority ?? 0;
    if (pb !== pa) return pb - pa;
    return new Date(a.root.createdAt).getTime() - new Date(b.root.createdAt).getTime();
  });

  return threads;
}

function isSnoozed(c: ReviewComment): boolean {
  if (!c.snoozeUntil) return false;
  const t = new Date(c.snoozeUntil).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function EvalBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    resolve: "bg-green-500/20 text-green-400",
    reply: "bg-blue-500/20 text-blue-400",
    fix: "bg-orange-500/20 text-orange-400",
  };
  const labels: Record<string, string> = {
    resolve: "Can Resolve",
    reply: "Suggest Reply",
    fix: "Needs Fix",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-sans ${styles[action] ?? "bg-gray-500/20 text-gray-400"}`}>
      {labels[action] ?? action}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "replied") return <span className="text-xs text-green-400">Replied ✓</span>;
  if (status === "dismissed") return <span className="text-xs text-gray-500">Dismissed</span>;
  if (status === "fixed") return <span className="text-xs text-blue-400">Fixed ✓</span>;
  return null;
}

function ThreadItem({ thread, onSelectFile, repo, prNumber, branch, fixBlocked, onCommentAction, onFixStarted, isFocused, registerRowEl, threadActionsRef }: {
  thread: Thread;
  onSelectFile: (f: string) => void;
  repo: string;
  prNumber: number;
  branch: string;
  fixBlocked: boolean;
  onCommentAction: () => void;
  onFixStarted: (job: FixJobStatus) => void;
  isFocused: boolean;
  registerRowEl: (id: number, el: HTMLDivElement | null) => void;
  threadActionsRef: MutableRefObject<Map<number, ThreadKeyActions>>;
}) {
  const eval_ = thread.root.evaluation;
  const status = thread.root.crStatus;
  const isActedOn = status === "replied" || status === "dismissed" || status === "fixed";
  const [expanded, setExpanded] = useState(!thread.isResolved && !isActedOn);
  const [acting, setActing] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [triageBusy, setTriageBusy] = useState(false);
  const [noteDraft, setNoteDraft] = useState(thread.root.triageNote ?? "");
  const [priorityDraft, setPriorityDraft] = useState(
    thread.root.priority != null ? String(thread.root.priority) : "",
  );

  useEffect(() => {
    setNoteDraft(thread.root.triageNote ?? "");
  }, [thread.root.triageNote, thread.root.id]);

  useEffect(() => {
    setPriorityDraft(thread.root.priority != null ? String(thread.root.priority) : "");
  }, [thread.root.priority, thread.root.id]);

  // Fix with Claude state
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [reEvaluating, setReEvaluating] = useState(false);

  async function handleReEvaluate() {
    setReEvaluating(true);
    try {
      await api.reEvaluate(repo, thread.root.id, prNumber);
      onCommentAction();
    } catch (err) {
      console.error("Re-evaluate failed:", err);
    } finally {
      setReEvaluating(false);
    }
  }

  async function handleAction(action: "reply" | "resolve" | "dismiss") {
    setActing(true);
    try {
      if (action === "reply") {
        await api.replyToComment(repo, thread.root.id, prNumber);
      } else if (action === "resolve") {
        await api.resolveComment(repo, thread.root.id, prNumber);
      } else {
        await api.dismissComment(repo, thread.root.id, prNumber);
      }
      onCommentAction();
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setActing(false);
    }
  }

  async function pushTriage(patch: { snoozeUntil?: string | null; priority?: number | null; triageNote?: string | null }) {
    setTriageBusy(true);
    try {
      await api.updateCommentTriage(repo, thread.root.id, prNumber, patch);
      onCommentAction();
    } catch (err) {
      console.error("Triage update failed:", err);
    } finally {
      setTriageBusy(false);
    }
  }

  function isoAfterMs(ms: number): string {
    return new Date(Date.now() + ms).toISOString();
  }

  function isoTomorrowMorning(): string {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  async function handleFixWithClaude() {
    setFixing(true);
    setFixError(null);

    // Optimistic update — immediately show as running
    onFixStarted({
      commentId: thread.root.id,
      repo,
      prNumber,
      path: thread.root.path,
      startedAt: Date.now(),
      status: "running",
      branch,
      originalComment: {
        path: thread.root.path,
        line: thread.root.line,
        body: thread.root.body,
        diffHunk: thread.root.diffHunk,
      },
    });

    try {
      const result = await api.fixWithClaude(repo, thread.root.id, prNumber, branch, {
        path: thread.root.path,
        line: thread.root.line,
        body: thread.root.body,
        diffHunk: thread.root.diffHunk,
      });
      if (!result.success) {
        setFixError(result.error ?? "Failed to start fix");
      }
    } catch (err) {
      setFixError((err as Error).message);
    } finally {
      setFixing(false);
    }
  }

  useLayoutEffect(() => {
    const id = thread.root.id;
    const actions = threadActionsRef.current;
    actions.set(id, {
      toggleExpand: () => setExpanded((x) => !x),
      reply: () => { void handleAction("reply"); },
      resolve: () => { void handleAction("resolve"); },
      dismiss: () => { void handleAction("dismiss"); },
      fix: () => { void handleFixWithClaude(); },
      reEvaluate: () => { void handleReEvaluate(); },
    });
    return () => {
      actions.delete(id);
    };
  });

  const snoozed = isSnoozed(thread.root);

  return (
    <div
      ref={(el) => registerRowEl(thread.root.id, el)}
      className={`rounded-lg ${isFocused ? "ring-2 ring-blue-500/70 ring-offset-2 ring-offset-gray-950" : ""}`}
    >
      <div className={`border rounded-lg overflow-hidden ${
        thread.isResolved || isActedOn ? "border-gray-800/50 opacity-70" : "border-gray-800"
      }`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 bg-gray-800/50 text-left text-xs font-mono flex items-center justify-between hover:bg-gray-800/80 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/80 focus-visible:ring-inset"
      >
        <span className="flex items-center gap-2 min-w-0 flex-wrap">
          <span
            onClick={(e) => { e.stopPropagation(); onSelectFile(thread.root.path); }}
            className="text-blue-400 hover:text-blue-300 shrink-0"
          >
            {thread.root.path}:{thread.root.line}
          </span>
          {thread.root.htmlUrl && (
            <a
              href={thread.root.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-500 hover:text-blue-400 font-sans text-[10px] shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-0.5"
              title="Open thread on GitHub"
              onClick={(e) => e.stopPropagation()}
            >
              GH
            </a>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {isActedOn && <StatusBadge status={status!} />}
          {!isActedOn && eval_ && <EvalBadge action={eval_.action} />}
          {thread.isResolved && <span className="text-green-500/70 text-xs font-sans">Resolved</span>}
          <span className="text-gray-600 text-xs">{expanded ? "▼" : "▶"}</span>
        </span>
      </button>
      {expanded && (
        <div className="p-2 space-y-0">
          <Comment comment={thread.root} compact />
          {thread.replies.map((reply) => (
            <Comment key={reply.id} comment={reply} compact />
          ))}

          <div className="mx-1 mt-2 p-2 bg-gray-900/35 rounded border border-gray-800/80 space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Local triage</div>
            {snoozed && (
              <div className="text-xs text-amber-400/90">
                Snoozed until {new Date(thread.root.snoozeUntil!).toLocaleString()}
              </div>
            )}
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={() => {
                const cur = thread.root.triageNote ?? "";
                if (noteDraft !== cur) {
                  void pushTriage({ triageNote: noteDraft });
                }
              }}
              placeholder="Private note (not sent to GitHub)…"
              disabled={triageBusy}
              rows={2}
              className="w-full text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-y min-h-[2.5rem]"
            />
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-gray-500 shrink-0">Priority</label>
              <input
                type="number"
                value={priorityDraft}
                onChange={(e) => setPriorityDraft(e.target.value)}
                onBlur={() => {
                  const raw = priorityDraft.trim();
                  if (raw === "") {
                    if (thread.root.priority != null) void pushTriage({ priority: null });
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n)) return;
                  const rounded = Math.round(n);
                  if (rounded !== thread.root.priority) void pushTriage({ priority: rounded });
                }}
                placeholder="0"
                disabled={triageBusy}
                className="w-14 text-xs bg-gray-950 border border-gray-700 rounded px-1 py-0.5 text-gray-300 focus:outline-none focus:border-gray-500"
              />
              <span className="text-xs text-gray-600">Snooze</span>
              <button
                type="button"
                disabled={triageBusy}
                onClick={() => void pushTriage({ snoozeUntil: isoAfterMs(3600000) })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded disabled:opacity-50"
              >
                1h
              </button>
              <button
                type="button"
                disabled={triageBusy}
                onClick={() => void pushTriage({ snoozeUntil: isoAfterMs(4 * 3600000) })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded disabled:opacity-50"
              >
                4h
              </button>
              <button
                type="button"
                disabled={triageBusy}
                onClick={() => void pushTriage({ snoozeUntil: isoTomorrowMorning() })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded disabled:opacity-50"
              >
                Tomorrow 9:00
              </button>
              <button
                type="button"
                disabled={triageBusy || !thread.root.snoozeUntil}
                onClick={() => void pushTriage({ snoozeUntil: null })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded disabled:opacity-40"
              >
                Clear snooze
              </button>
            </div>
          </div>

          {eval_ && !isActedOn && (
            <div className="mx-1 mt-2">
              <button
                onClick={() => setShowSuggestion(!showSuggestion)}
                className="text-xs text-gray-400 hover:text-gray-300 flex items-center gap-1"
              >
                <span>{showSuggestion ? "▼" : "▶"}</span>
                <span>
                  {eval_.action === "fix" ? "Suggested fix" : "Suggested response"}
                  {eval_.summary && <span className="text-gray-600 ml-1">— {eval_.summary}</span>}
                </span>
              </button>
              {showSuggestion && (
                <div className="mt-1 p-2 bg-gray-800/50 rounded text-xs text-gray-300 whitespace-pre-wrap border border-gray-700">
                  {eval_.action === "fix" ? (eval_.fixDescription || eval_.summary) : (eval_.reply || eval_.summary)}
                </div>
              )}
            </div>
          )}

          {/* Fix error */}
          {fixError && (
            <div className="mx-1 mt-2 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
              {fixError}
              <button onClick={() => setFixError(null)} className="ml-2 text-gray-500 hover:text-gray-300">dismiss</button>
            </div>
          )}

          {/* Action buttons */}
          {!isActedOn && !thread.isResolved && (
            <div className="flex items-center gap-2 mx-1 mt-2 pt-2 border-t border-gray-800">
              {eval_?.action === "reply" && eval_.reply && (
                <button
                  onClick={() => handleAction("reply")}
                  disabled={acting || fixing}
                  className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:text-gray-400 text-white rounded transition-colors"
                >
                  {acting ? "Sending..." : "Send Reply"}
                </button>
              )}
              <button
                onClick={handleFixWithClaude}
                disabled={acting || fixing || fixBlocked}
                className="text-xs px-3 py-1 bg-orange-600 hover:bg-orange-500 disabled:bg-orange-800 disabled:text-gray-400 text-white rounded transition-colors"
                title={fixBlocked ? "A fix is already running on this PR" : undefined}
              >
                {fixing ? "Starting fix..." : fixBlocked ? "Fix running..." : "Fix with Claude"}
              </button>
              <button
                onClick={() => handleAction("resolve")}
                disabled={acting || fixing}
                className="text-xs px-3 py-1 bg-green-600/80 hover:bg-green-500/80 disabled:bg-green-800/50 disabled:text-gray-400 text-white rounded transition-colors"
              >
                Resolve
              </button>
              <button
                onClick={() => handleAction("dismiss")}
                disabled={acting || fixing}
                className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-400 text-gray-300 rounded transition-colors"
              >
                Dismiss
              </button>
              <button
                onClick={handleReEvaluate}
                disabled={acting || fixing || reEvaluating}
                className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-400 text-gray-400 rounded transition-colors ml-auto"
                title="Re-run Claude evaluation on this comment"
              >
                {reEvaluating ? "Evaluating..." : "Re-evaluate"}
              </button>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

export default function CommentThreads({ comments, onSelectFile, repo, prNumber, branch, fixJobs, onCommentAction, onFixStarted, globalModalOpen = false, onOpenShortcutsHelp }: CommentThreadsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batching, setBatching] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [filterAction, setFilterAction] = useState<"all" | "fix" | "reply" | "resolve">("all");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);
  const threadActionsRef = useRef(new Map<number, ThreadKeyActions>());
  const rowElsRef = useRef(new Map<number, HTMLDivElement>());
  const threadsRef = useRef<Thread[]>([]);
  const focusedIdxRef = useRef<number | null>(null);

  const allThreads = buildThreads(comments);

  const threads = allThreads.filter((t) => {
    if (!showSnoozed && isSnoozed(t.root)) return false;
    if (filterText) {
      const q = filterText.toLowerCase();
      if (!t.root.path.toLowerCase().includes(q) && !t.root.body.toLowerCase().includes(q)) return false;
    }
    if (filterAction !== "all" && t.root.evaluation?.action !== filterAction) return false;
    return true;
  });

  threadsRef.current = threads;
  focusedIdxRef.current = focusedIdx;

  function registerRowEl(id: number, el: HTMLDivElement | null) {
    if (el) {
      rowElsRef.current.set(id, el);
    } else {
      rowElsRef.current.delete(id);
    }
  }

  useEffect(() => {
    setFocusedIdx((i) => {
      if (i === null) return null;
      if (threads.length === 0) return null;
      return Math.min(i, threads.length - 1);
    });
  }, [threads.length]);

  useEffect(() => {
    const list = threadsRef.current;
    if (focusedIdx === null || focusedIdx < 0 || focusedIdx >= list.length) return;
    const id = list[focusedIdx]!.root.id;
    rowElsRef.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIdx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (globalModalOpen) return;
      const tgt = e.target;
      if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement) {
        return;
      }
      if (tgt instanceof HTMLElement && tgt.isContentEditable) return;

      const list = threadsRef.current;

      if (e.key === "j" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setFocusedIdx((i) => {
          if (list.length === 0) return null;
          if (i === null) return 0;
          return Math.min(list.length - 1, i + 1);
        });
        return;
      }
      if (e.key === "k" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setFocusedIdx((i) => {
          if (list.length === 0) return null;
          if (i === null) return 0;
          return Math.max(0, i - 1);
        });
        return;
      }

      const idx = focusedIdxRef.current;
      if (idx === null || idx < 0 || idx >= list.length) return;
      const id = list[idx]!.root.id;
      const h = threadActionsRef.current.get(id);
      if (!h) return;

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        h.toggleExpand();
        return;
      }
      if (e.key === "r") {
        e.preventDefault();
        h.reply();
        return;
      }
      if (e.key === "x") {
        e.preventDefault();
        h.resolve();
        return;
      }
      if (e.key === "d") {
        e.preventDefault();
        h.dismiss();
        return;
      }
      if (e.key === "f") {
        e.preventDefault();
        h.fix();
        return;
      }
      if (e.key === "e") {
        e.preventDefault();
        h.reEvaluate();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [globalModalOpen]);

  if (threads.length === 0) return null;

  const openCount = threads.filter((t) => !t.isResolved).length;
  const resolvedCount = threads.filter((t) => t.isResolved).length;
  const hasRunningFix = fixJobs.some((j) => j.repo === repo && j.prNumber === prNumber && j.status === "running");

  const actionableThreads = threads.filter((t) => !t.isResolved && !(t.root.crStatus === "replied" || t.root.crStatus === "dismissed" || t.root.crStatus === "fixed"));
  const allSelected = actionableThreads.length > 0 && actionableThreads.every((t) => selected.has(t.root.id));

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(actionableThreads.map((t) => t.root.id)));
    }
  }

  async function handleBatchAction(action: "reply" | "resolve" | "dismiss") {
    const items = threads
      .filter((t) => selected.has(t.root.id))
      .map((t) => ({ repo, commentId: t.root.id, prNumber }));
    if (items.length === 0) return;
    setBatching(true);
    try {
      await api.batchAction(action, items);
      setSelected(new Set());
      onCommentAction();
    } catch (err) {
      console.error("Batch action failed:", err);
    } finally {
      setBatching(false);
    }
  }

  const filteredCount = threads.length;
  const totalCount = allThreads.length;
  const isFiltered = filterText !== "" || filterAction !== "all";

  return (
    <div className="border-b border-gray-800 flex-1 overflow-y-auto">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-6 py-2 flex items-center justify-between text-xs text-gray-500 uppercase tracking-wide hover:bg-gray-800/30 sticky top-0 bg-gray-950 z-10"
      >
        <span>
          Review Threads ({isFiltered ? `${filteredCount} of ${totalCount}` : totalCount})
          {resolvedCount > 0 && !isFiltered && (
            <span className="normal-case ml-2 text-gray-600">
              {openCount} open, {resolvedCount} resolved
            </span>
          )}
        </span>
        <span className="text-gray-600">{collapsed ? "▶" : "▼"}</span>
      </button>
      {!collapsed && (
        <>
          {/* Search/filter bar */}
          <div className="px-6 py-1.5 flex items-center gap-2 border-b border-gray-800/50 bg-gray-900/20">
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter by file or text..."
              className="flex-1 text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
            />
            {(["all", "fix", "reply", "resolve"] as const).map((a) => (
              <button
                key={a}
                onClick={() => setFilterAction(a)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  filterAction === a
                    ? a === "fix" ? "bg-orange-500/30 text-orange-300"
                      : a === "reply" ? "bg-blue-500/30 text-blue-300"
                      : a === "resolve" ? "bg-green-500/30 text-green-300"
                      : "bg-gray-600 text-gray-200"
                    : "bg-gray-800 text-gray-500 hover:text-gray-300"
                }`}
              >
                {a === "all" ? "All" : a.charAt(0).toUpperCase() + a.slice(1)}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0 ml-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showSnoozed}
                onChange={(e) => setShowSnoozed(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800 text-blue-500"
              />
              Snoozed
            </label>
            <div className="flex items-center gap-1 shrink-0 text-xs text-gray-600">
              {onOpenShortcutsHelp && (
                <button
                  type="button"
                  onClick={() => onOpenShortcutsHelp()}
                  className="rounded px-1.5 py-0.5 text-blue-400/90 hover:text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  title="All keyboard shortcuts"
                >
                  ?
                </button>
              )}
              <details className="text-xs">
                <summary className="cursor-pointer hover:text-gray-400 select-none">Keys</summary>
                <div className="mt-1 pl-2 text-[10px] text-gray-500 space-y-0.5 font-sans normal-case tracking-normal">
                  <div>j / k — focus thread</div>
                  <div>Enter / Space — expand or collapse</div>
                  <div>r reply · x resolve · d dismiss · f fix · e re-evaluate</div>
                </div>
              </details>
            </div>
          </div>
          {/* Bulk action toolbar */}
          {actionableThreads.length > 0 && (
            <div className="px-6 py-1.5 flex items-center gap-3 border-b border-gray-800/50 bg-gray-900/30">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="rounded border-gray-600 bg-gray-800 text-blue-500 cursor-pointer"
                title="Select all"
              />
              {selected.size > 0 ? (
                <>
                  <span className="text-xs text-gray-400">{selected.size} selected</span>
                  <button onClick={() => handleBatchAction("dismiss")} disabled={batching} className="text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded disabled:opacity-50">
                    Dismiss all
                  </button>
                  <button onClick={() => handleBatchAction("resolve")} disabled={batching} className="text-xs px-2 py-0.5 bg-green-700/60 hover:bg-green-600/60 text-green-300 rounded disabled:opacity-50">
                    Resolve all
                  </button>
                  <button onClick={() => handleBatchAction("reply")} disabled={batching} className="text-xs px-2 py-0.5 bg-blue-700/60 hover:bg-blue-600/60 text-blue-300 rounded disabled:opacity-50">
                    Reply all
                  </button>
                </>
              ) : (
                <span className="text-xs text-gray-600">Select threads for bulk actions</span>
              )}
            </div>
          )}
          <div className="px-6 pb-3 space-y-3 pt-3">
            {threads.map((thread, idx) => {
              const isActionable = actionableThreads.some((t) => t.root.id === thread.root.id);
              return (
                <div key={thread.root.id} className="flex items-start gap-2">
                  {isActionable && (
                    <input
                      type="checkbox"
                      checked={selected.has(thread.root.id)}
                      onChange={() => toggleSelect(thread.root.id)}
                      className="mt-2 rounded border-gray-600 bg-gray-800 text-blue-500 cursor-pointer shrink-0"
                    />
                  )}
                  <div className={isActionable ? "flex-1 min-w-0" : "flex-1 min-w-0 pl-5"}>
                    <ThreadItem
                      thread={thread}
                      onSelectFile={onSelectFile}
                      repo={repo}
                      prNumber={prNumber}
                      branch={branch}
                      fixBlocked={hasRunningFix}
                      onCommentAction={onCommentAction}
                      onFixStarted={onFixStarted}
                      isFocused={focusedIdx === idx}
                      registerRowEl={registerRowEl}
                      threadActionsRef={threadActionsRef}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
