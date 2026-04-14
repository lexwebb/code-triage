import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import type { ReviewComment } from "../types";
import { api } from "../api";
import type { FixJobStatus } from "../api";
import Comment from "./Comment";
import { Check, ChevronRight, ChevronDown, HelpCircle } from "lucide-react";
import { IconButton } from "./ui/icon-button";
import { CollapsibleSection } from "./ui/collapsible-section";
import { Button } from "./ui/button";
import { StatusBadge } from "./ui/status-badge";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";

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
  /** Absolute local path to the repo root (for IDE links). */
  repoLocalPath?: string;
  /** User's preferred editor key (e.g. "vscode", "cursor"). */
  preferredEditor?: string;
}

const EDITOR_LABELS: Record<string, string> = {
  vscode: "VS Code",
  cursor: "Cursor",
  webstorm: "WebStorm",
  idea: "IDEA",
  zed: "Zed",
  sublime: "Sublime",
  windsurf: "Windsurf",
};

function buildEditorUri(editor: string, absPath: string, line: number): string {
  switch (editor) {
    case "cursor":
      return `cursor://file/${absPath}:${line}`;
    case "webstorm":
      return `jetbrains://webstorm/navigate/reference?path=${encodeURIComponent(absPath)}&line=${line}`;
    case "idea":
      return `jetbrains://idea/navigate/reference?path=${encodeURIComponent(absPath)}&line=${line}`;
    case "zed":
      return `zed://file/${absPath}:${line}`;
    case "sublime":
      return `subl://open?url=file://${encodeURIComponent(absPath)}&line=${line}`;
    case "windsurf":
      return `windsurf://file/${absPath}:${line}`;
    case "vscode":
    default:
      return `vscode://file/${absPath}:${line}`;
  }
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
  const colors: Record<string, "green" | "blue" | "orange" | "gray"> = {
    resolve: "green",
    reply: "blue",
    fix: "orange",
  };
  const labels: Record<string, string> = {
    resolve: "Can Resolve",
    reply: "Suggest Reply",
    fix: "Needs Fix",
  };
  return (
    <StatusBadge color={colors[action] ?? "gray"} className="font-sans">
      {labels[action] ?? action}
    </StatusBadge>
  );
}

function ThreadStatusBadge({ status }: { status: string }) {
  if (status === "evaluating") return <StatusBadge color="blue" className="animate-pulse">Evaluating...</StatusBadge>;
  if (status === "replied") return <StatusBadge color="green" icon={<Check size={12} />}>Replied</StatusBadge>;
  if (status === "dismissed") return <StatusBadge color="gray">Dismissed</StatusBadge>;
  if (status === "fixed") return <StatusBadge color="blue" icon={<Check size={12} />}>Fixed</StatusBadge>;
  return null;
}

function FixConversation({ job, repo, onJobAction }: {
  job: FixJobStatus;
  repo: string;
  onJobAction: () => void;
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      await api.fixReply(repo, job.commentId, reply.trim());
      setReply("");
      onJobAction();
    } catch (err) {
      console.error("Fix reply failed:", err);
    } finally {
      setSending(false);
    }
  }

  const conversation = job.conversation ?? [];
  const claudeTurns = conversation.filter((m) => m.role === "claude").length;
  const isRunning = job.status === "running";

  return (
    <div className="mx-1 mt-2 p-2 bg-indigo-950/20 rounded border border-indigo-500/30 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-indigo-400">Fix conversation</div>
      <div className="space-y-1.5 max-h-60 overflow-y-auto">
        {conversation.map((msg, i) => (
          <div key={i} className={`text-xs p-2 rounded whitespace-pre-wrap ${
            msg.role === "claude"
              ? "bg-gray-800/60 text-gray-300 mr-8"
              : "bg-indigo-900/30 text-indigo-200 ml-8"
          }`}>
            <span className="text-[10px] text-gray-500 block mb-0.5">
              {msg.role === "claude" ? "Claude" : "You"}
            </span>
            {msg.message}
          </div>
        ))}
        {isRunning && (
          <div className="text-xs text-gray-500 italic px-2">Claude is thinking...</div>
        )}
      </div>
      {job.status === "awaiting_response" && (
        <div className="flex gap-2 items-end">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void handleSend();
              }
            }}
            placeholder="Reply to Claude..."
            disabled={sending}
            rows={2}
            autoFocus
            className="flex-1 text-xs bg-gray-950 border border-gray-700 rounded px-2 py-1 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-y"
          />
          <div className="flex flex-col items-end gap-1">
            <Button variant="blue" size="xs" onClick={() => void handleSend()} disabled={sending || !reply.trim()}>
              {sending ? "Sending..." : "Send"}
            </Button>
            <span className="text-[10px] text-gray-600">Turn {claudeTurns}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ThreadItem({ thread, onSelectFile, repo, prNumber, branch, fixBlocked, fixJobs, onCommentAction, onFixStarted, isFocused, registerRowEl, threadActionsRef, repoLocalPath, preferredEditor }: {
  thread: Thread;
  onSelectFile: (f: string) => void;
  repo: string;
  prNumber: number;
  branch: string;
  fixBlocked: boolean;
  fixJobs?: FixJobStatus[];
  onCommentAction: () => void;
  onFixStarted: (job: FixJobStatus) => void;
  isFocused: boolean;
  registerRowEl: (id: number, el: HTMLDivElement | null) => void;
  threadActionsRef: MutableRefObject<Map<number, ThreadKeyActions>>;
  repoLocalPath?: string;
  preferredEditor?: string;
}) {
  const eval_ = thread.root.evaluation;
  const status = thread.root.crStatus;
  const isActedOn = status === "replied" || status === "dismissed" || status === "fixed";
  const isEvaluating = status === "evaluating";
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

  const fixJob = fixJobs?.find((j) => j.commentId === thread.root.id);
  const isAwaitingResponse = fixJob?.status === "awaiting_response";
  const isFixRunning = fixJob?.status === "running";

  // Fix with Claude state
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixModalOpen, setFixModalOpen] = useState(false);
  const [fixInstructions, setFixInstructions] = useState("");
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

  async function handleFixWithClaude(userInstructions?: string) {
    setFixModalOpen(false);
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
      }, userInstructions || undefined);
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
      fix: () => { setFixModalOpen(true); },
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
          {repoLocalPath && (
            <a
              href={buildEditorUri(preferredEditor ?? "vscode", `${repoLocalPath}/${thread.root.path}`, thread.root.line)}
              className="text-gray-500 hover:text-purple-400 font-sans text-[10px] shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 rounded px-0.5"
              title={`Open in ${EDITOR_LABELS[preferredEditor ?? "vscode"] ?? preferredEditor}`}
              onClick={(e) => e.stopPropagation()}
            >
              {EDITOR_LABELS[preferredEditor ?? "vscode"] ?? preferredEditor}
            </a>
          )}
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {isEvaluating && <ThreadStatusBadge status="evaluating" />}
          {!isEvaluating && isAwaitingResponse && <StatusBadge color="blue">Claude Asking</StatusBadge>}
          {!isEvaluating && isFixRunning && <StatusBadge color="yellow">Fix Running</StatusBadge>}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && isActedOn && <ThreadStatusBadge status={status!} />}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && !isActedOn && eval_ && <EvalBadge action={eval_.action} />}
          {!isEvaluating && !isActedOn && !eval_ && thread.root.evalFailed && (
            <StatusBadge color="gray" className="text-red-400">Eval failed</StatusBadge>
          )}
          {thread.isResolved && <span className="text-green-500/70 text-xs font-sans">Resolved</span>}
          <span className="text-gray-600 text-xs">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
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
                <span>{showSuggestion ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
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

          {/* Fix conversation */}
          {fixJob && (fixJob.status === "awaiting_response" || (fixJob.status === "running" && fixJob.conversation?.length)) && (
            <FixConversation job={fixJob} repo={repo} onJobAction={onCommentAction} />
          )}

          {/* Action buttons */}
          {!isActedOn && !thread.isResolved && !isEvaluating && (
            <div className="flex items-center gap-2 mx-1 mt-2 pt-2 border-t border-gray-800">
              {eval_?.action === "reply" && eval_.reply && (
                <Button variant="blue" size="xs" onClick={() => handleAction("reply")} disabled={acting || fixing}>
                  {acting ? "Sending..." : "Send Reply"}
                </Button>
              )}
              {!isAwaitingResponse && (
                <Button
                  variant="orange"
                  size="xs"
                  onClick={() => setFixModalOpen(true)}
                  disabled={acting || fixing || fixBlocked}
                  title={fixBlocked ? "A fix is already running on this PR" : undefined}
                >
                  {fixing ? "Starting fix..." : fixBlocked ? "Fix running..." : "Fix with Claude"}
                </Button>
              )}
              <Button variant="green" size="xs" onClick={() => handleAction("resolve")} disabled={acting || fixing}>
                Resolve
              </Button>
              <Button variant="gray" size="xs" onClick={() => handleAction("dismiss")} disabled={acting || fixing}>
                Dismiss
              </Button>
              <Button
                variant="gray"
                size="xs"
                onClick={handleReEvaluate}
                disabled={acting || fixing || reEvaluating}
                className="ml-auto text-gray-400"
                title="Re-run Claude evaluation on this comment"
              >
                {reEvaluating ? "Evaluating..." : "Re-evaluate"}
              </Button>
            </div>
          )}
        </div>
      )}
      {/* Fix with Claude modal */}
      <Dialog open={fixModalOpen} onOpenChange={(open) => { if (!open) { setFixModalOpen(false); setFixInstructions(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Fix with Claude</DialogTitle>
            <DialogDescription>
              Add optional instructions for how Claude should fix this comment.
            </DialogDescription>
          </DialogHeader>
          <div className="text-xs bg-gray-900 border border-gray-800 rounded p-3 max-h-32 overflow-y-auto text-gray-300 whitespace-pre-wrap">
            {thread.root.body}
          </div>
          <textarea
            className="w-full rounded border border-gray-700 bg-gray-900 text-sm text-gray-200 p-2 placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-orange-500 resize-y"
            rows={3}
            placeholder="e.g. Use a guard clause instead of nesting, keep the existing error message..."
            value={fixInstructions}
            onChange={(e) => setFixInstructions(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                void handleFixWithClaude(fixInstructions);
                setFixInstructions("");
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <button
              onClick={() => { setFixModalOpen(false); setFixInstructions(""); }}
              className="text-xs px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => { void handleFixWithClaude(fixInstructions); setFixInstructions(""); }}
              className="text-xs px-4 py-1.5 bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors"
            >
              Start Fix
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      </div>
    </div>
  );
}

export default function CommentThreads({ comments, onSelectFile, repo, prNumber, branch, fixJobs, onCommentAction, onFixStarted, globalModalOpen = false, onOpenShortcutsHelp, repoLocalPath, preferredEditor }: CommentThreadsProps) {
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
      <CollapsibleSection
        defaultOpen
        title={<>
          Review Threads ({isFiltered ? `${filteredCount} of ${totalCount}` : totalCount})
          {resolvedCount > 0 && !isFiltered && (
            <span className="normal-case ml-2 text-gray-600">
              {openCount} open, {resolvedCount} resolved
            </span>
          )}
        </>}
        className="px-6 py-2 text-gray-500 sticky top-0 bg-gray-950 z-10"
      >
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
              <Checkbox
                checked={showSnoozed}
                onCheckedChange={(v) => setShowSnoozed(v === true)}
              />
              Snoozed
            </label>
            <div className="flex items-center gap-1 shrink-0 text-xs text-gray-600">
              {onOpenShortcutsHelp && (
                <IconButton
                  description="All keyboard shortcuts"
                  icon={<HelpCircle size={14} />}
                  onClick={() => onOpenShortcutsHelp()}
                  size="sm"
                  className="text-blue-400/90 hover:text-blue-300"
                />
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
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleSelectAll}
                title="Select all"
              />
              {selected.size > 0 ? (
                <>
                  <span className="text-xs text-gray-400">{selected.size} selected</span>
                  <Button variant="gray" size="xs" onClick={() => handleBatchAction("dismiss")} disabled={batching}>
                    Dismiss all
                  </Button>
                  <Button variant="green" size="xs" onClick={() => handleBatchAction("resolve")} disabled={batching}>
                    Resolve all
                  </Button>
                  <Button variant="blue" size="xs" onClick={() => handleBatchAction("reply")} disabled={batching}>
                    Reply all
                  </Button>
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
                    <Checkbox
                      checked={selected.has(thread.root.id)}
                      onCheckedChange={() => toggleSelect(thread.root.id)}
                      className="mt-2 shrink-0"
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
                      fixJobs={fixJobs}
                      onCommentAction={onCommentAction}
                      onFixStarted={onFixStarted}
                      isFocused={focusedIdx === idx}
                      registerRowEl={registerRowEl}
                      threadActionsRef={threadActionsRef}
                      repoLocalPath={repoLocalPath}
                      preferredEditor={preferredEditor}
                    />
                  </div>
                </div>
              );
            })}
          </div>
      </CollapsibleSection>
    </div>
  );
}
