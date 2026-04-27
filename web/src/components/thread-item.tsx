import React, { useEffect, useLayoutEffect } from "react";
import { useAppStore } from "../store";
import Comment from "./comment";
import { ChevronRight, ChevronDown, ListOrdered, Check } from "lucide-react";
import { Button } from "./ui/button";
import { StatusBadge } from "./ui/status-badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { cn } from "../lib/utils";
import { findJobForComment } from "../lib/fix-job-for-comment";
import { type Thread, isSnoozed, buildEditorUri, EDITOR_LABELS, EvalBadge, ThreadStatusBadge } from "./thread-utils";
import { FixJobInlineReview } from "./fix-job-inline-review";

export type ThreadKeyActions = {
  toggleExpand: () => void;
  reply: () => void;
  resolve: () => void;
  dismiss: () => void;
  fix: () => void;
  reEvaluate: () => void;
};

function FixConversation({ commentId, repo }: { commentId: number; repo: string }) {
  const jobs = useAppStore((s) => s.jobs);
  const job = findJobForComment(jobs, commentId);
  const canonicalId = job?.commentId ?? commentId;
  const replyText = useAppStore((s) => s.replyText[canonicalId] ?? "");
  const sending = useAppStore((s) => s.acting[canonicalId] ?? false);
  const setReplyText = useAppStore((s) => s.setReplyText);
  const sendReply = useAppStore((s) => s.sendReply);

  if (!job) return null;

  const conversation = job.conversation ?? [];
  const claudeTurns = conversation.filter((m) => m.role === "claude").length;
  const isRunning = job.status === "running";

  async function handleSend() {
    if (!replyText.trim() || sending) return;
    await sendReply(repo, canonicalId, replyText.trim());
  }

  return (
    <div className="mx-1 mt-2 p-2 bg-indigo-950/20 rounded border border-indigo-500/30 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-indigo-400">Fix conversation</div>
      <div className="space-y-1.5 max-h-60 overflow-y-auto">
        {conversation.map((msg, i) => (
          <div key={i} className={cn("text-xs p-2 rounded whitespace-pre-wrap", msg.role === "claude" ? "bg-gray-800/60 text-gray-300 mr-8" : "bg-indigo-900/30 text-indigo-200 ml-8")}>
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
            value={replyText}
            onChange={(e) => setReplyText(canonicalId, e.target.value)}
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
            <Button variant="blue" size="xs" onClick={() => void handleSend()} disabled={sending || !replyText.trim()}>
              {sending ? "Sending..." : "Send"}
            </Button>
            <span className="text-[10px] text-gray-600">Turn {claudeTurns}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ThreadItem({ rootId, thread, botReviewStatus, fixBlocked, fixQueueSlot, isFocused, registerRowEl, threadActionsRef }: {
  rootId: number;
  thread: Thread;
  botReviewStatus?: { botLabel: string; state: "re_reviewing" | "manual_restart_required" };
  fixBlocked: boolean;
  /** When this thread’s fix is waiting in the server queue (place/total among pending fixes). */
  fixQueueSlot: { place: number; total: number } | null;
  isFocused: boolean;
  registerRowEl: (id: number, el: HTMLDivElement | null) => void;
  threadActionsRef: React.RefObject<Map<number, ThreadKeyActions>>;
}) {
  const selectedPR = useAppStore((s) => s.selectedPR);
  const repos = useAppStore((s) => s.repos);
  const preferredEditor = useAppStore((s) => s.preferredEditor);
  const jobs = useAppStore((s) => s.jobs);
  const expanded = useAppStore((s) => s.expandedThreads.has(rootId));
  const acting = useAppStore((s) => s.actingThreads.has(rootId));
  const fixing = useAppStore((s) => s.fixingThreads.has(rootId));
  const isQueued = fixQueueSlot != null;
  const fixError = useAppStore((s) => s.fixErrors[rootId] ?? null);
  const fixModalOpen = useAppStore((s) => s.fixModalOpenThreads.has(rootId));
  const fixInstructions = useAppStore((s) => s.threadFixInstructions[rootId] ?? "");
  const reEvaluating = useAppStore((s) => s.reEvaluatingThreads.has(rootId));
  const showSuggestion = useAppStore((s) => s.showSuggestionThreads.has(rootId));
  const triageBusy = useAppStore((s) => s.triageBusyThreads.has(rootId));
  const noteDraft = useAppStore((s) => s.noteDrafts[rootId] ?? "");
  const priorityDraft = useAppStore((s) => s.priorityDrafts[rootId] ?? "");
  const toggleExpanded = useAppStore((s) => s.toggleThreadExpanded);
  const replyToComment = useAppStore((s) => s.replyToComment);
  const resolveComment = useAppStore((s) => s.resolveComment);
  const dismissComment = useAppStore((s) => s.dismissComment);
  const reEvaluateComment = useAppStore((s) => s.reEvaluateComment);
  const updateCommentTriage = useAppStore((s) => s.updateCommentTriage);
  const startFix = useAppStore((s) => s.startFix);
  const setFixModalOpen = useAppStore((s) => s.setFixModalOpen);
  const setFixInstructions = useAppStore((s) => s.setThreadFixInstructions);
  const setShowSuggestion = useAppStore((s) => s.setShowSuggestion);
  const setNoteDraft = useAppStore((s) => s.setNoteDraft);
  const setPriorityDraft = useAppStore((s) => s.setPriorityDraft);
  const selectFile = useAppStore((s) => s.selectFile);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const repo = selectedPR?.repo ?? "";
  const repoLocalPath = repos.find((r) => r.repo === selectedPR?.repo)?.localPath;

  const eval_ = thread.root.evaluation;
  const status = thread.root.crStatus;
  // "fixed" is local workflow progress; only treat as terminal once GitHub marks the thread resolved.
  const isLocallyFixedOpen = status === "fixed" && !thread.isResolved;
  const isActedOn = status === "replied" || status === "dismissed" || (status === "fixed" && thread.isResolved);
  const isEvaluating = status === "evaluating";
  const isBotReReviewing = botReviewStatus?.state === "re_reviewing";
  const botNeedsManualRestart = botReviewStatus?.state === "manual_restart_required";
  const botLabel = botReviewStatus?.botLabel ?? "Bot";

  const fixJobsForThread = jobs
    .filter((j) => j.commentId === thread.root.id || (j.batchCommentIds?.includes(thread.root.id) ?? false))
    .sort((a, b) => b.startedAt - a.startedAt);
  const fixJob = fixJobsForThread[0];
  const isAwaitingResponse = fixJob?.status === "awaiting_response";
  const isFixRunning = fixJob?.status === "running";
  const suppressEvalForFixOutcome =
    !!fixJob && (fixJob.status === "completed" || fixJob.status === "no_changes" || fixJob.status === "failed");

  // Sync triage note / priority drafts when thread data changes
  useEffect(() => {
    setNoteDraft(rootId, thread.root.triageNote ?? "");
  }, [thread.root.triageNote, rootId, setNoteDraft]);

  useEffect(() => {
    setPriorityDraft(rootId, thread.root.priority != null ? String(thread.root.priority) : "");
  }, [thread.root.priority, rootId, setPriorityDraft]);

  function handleAction(action: "reply" | "resolve" | "dismiss") {
    if (action === "reply") void replyToComment(rootId);
    else if (action === "resolve") void resolveComment(rootId);
    else void dismissComment(rootId);
  }

  function handleReEvaluate() {
    void reEvaluateComment(rootId);
  }

  function pushTriage(patch: { snoozeUntil?: string | null; priority?: number | null; triageNote?: string | null }) {
    void updateCommentTriage(rootId, patch);
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

  function handleFixWithClaude(userInstructions?: string) {
    setFixModalOpen(rootId, false);
    void startFix(rootId, {
      path: thread.root.path,
      line: thread.root.line,
      body: thread.root.body,
      diffHunk: thread.root.diffHunk,
    }, userInstructions || undefined);
  }

  useLayoutEffect(() => {
    const id = thread.root.id;
    const actions = threadActionsRef.current;
    actions.set(id, {
      toggleExpand: () => toggleExpanded(id),
      reply: () => handleAction("reply"),
      resolve: () => handleAction("resolve"),
      dismiss: () => handleAction("dismiss"),
      fix: () => setFixModalOpen(id, true),
      reEvaluate: () => handleReEvaluate(),
    });
    return () => {
      actions.delete(id);
    };
  });

  const snoozed = isSnoozed(thread.root);

  return (
    <div
      ref={(el) => registerRowEl(thread.root.id, el)}
      className={cn("rounded-lg", isFocused && "ring-2 ring-blue-500/70 ring-offset-2 ring-offset-gray-950")}
    >
      <div className={cn("border rounded-lg overflow-hidden", thread.isResolved || isActedOn ? "border-gray-800/50 opacity-70" : "border-gray-800")}>
      <button
        type="button"
        onClick={() => toggleExpanded(rootId)}
        className="w-full px-3 py-1.5 bg-gray-800/50 text-left text-xs font-mono flex items-center justify-between hover:bg-gray-800/80 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/80 focus-visible:ring-inset"
      >
        <span className="flex items-center gap-2 min-w-0 flex-wrap">
          <span
            onClick={(e) => { e.stopPropagation(); setActiveTab("files"); selectFile(thread.root.path); }}
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
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && fixJob?.status === "completed" && !isActedOn && (
            <StatusBadge color="green">Fix ready</StatusBadge>
          )}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && fixJob?.status === "no_changes" && !isActedOn && (
            <StatusBadge color="blue">No code change</StatusBadge>
          )}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && fixJob?.status === "failed" && !isActedOn && (
            <StatusBadge color="red">Fix failed</StatusBadge>
          )}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && fixQueueSlot && !fixJob && (
            <StatusBadge color="gray" icon={<ListOrdered size={12} className="shrink-0" aria-hidden />}>
              {fixQueueSlot.total > 1 ? `Queued ${fixQueueSlot.place}/${fixQueueSlot.total}` : "Queued"}
            </StatusBadge>
          )}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && !isActedOn && isBotReReviewing && (
            <StatusBadge color="blue">{botLabel} re-reviewing</StatusBadge>
          )}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && !isActedOn && botNeedsManualRestart && (
            <StatusBadge color="orange">{botLabel} waiting for restart</StatusBadge>
          )}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && isActedOn && <ThreadStatusBadge status={status!} />}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && isLocallyFixedOpen && (
            <StatusBadge color="blue" icon={<Check size={12} />}>Fixed (pending resolve)</StatusBadge>
          )}
          {!isEvaluating && !isAwaitingResponse && !isFixRunning && !isActedOn && !isLocallyFixedOpen && eval_ && !suppressEvalForFixOutcome && (
            <EvalBadge action={eval_.action} />
          )}
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
              onChange={(e) => setNoteDraft(rootId, e.target.value)}
              onBlur={() => {
                const cur = thread.root.triageNote ?? "";
                if (noteDraft !== cur) {
                  pushTriage({ triageNote: noteDraft });
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
                onChange={(e) => setPriorityDraft(rootId, e.target.value)}
                onBlur={() => {
                  const raw = priorityDraft.trim();
                  if (raw === "") {
                    if (thread.root.priority != null) pushTriage({ priority: null });
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n)) return;
                  const rounded = Math.round(n);
                  if (rounded !== thread.root.priority) pushTriage({ priority: rounded });
                }}
                placeholder="0"
                disabled={triageBusy}
                className="w-14 text-xs bg-gray-950 border border-gray-700 rounded px-1 py-0.5 text-gray-300 focus:outline-none focus:border-gray-500"
              />
              <span className="text-xs text-gray-600">Snooze</span>
              <button
                type="button"
                disabled={triageBusy}
                onClick={() => pushTriage({ snoozeUntil: isoAfterMs(3600000) })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded disabled:opacity-50"
              >
                1h
              </button>
              <button
                type="button"
                disabled={triageBusy}
                onClick={() => pushTriage({ snoozeUntil: isoAfterMs(4 * 3600000) })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded disabled:opacity-50"
              >
                4h
              </button>
              <button
                type="button"
                disabled={triageBusy}
                onClick={() => pushTriage({ snoozeUntil: isoTomorrowMorning() })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded disabled:opacity-50"
              >
                Tomorrow 9:00
              </button>
              <button
                type="button"
                disabled={triageBusy || !thread.root.snoozeUntil}
                onClick={() => pushTriage({ snoozeUntil: null })}
                className="text-xs px-2 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded disabled:opacity-40"
              >
                Clear snooze
              </button>
            </div>
          </div>

          {eval_ && !isActedOn && (
            <div className="mx-1 mt-2">
              <button
                onClick={() => setShowSuggestion(rootId, !showSuggestion)}
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
              <button onClick={() => useAppStore.setState((s) => ({ fixErrors: { ...s.fixErrors, [rootId]: null } }))} className="ml-2 text-gray-500 hover:text-gray-300">dismiss</button>
            </div>
          )}

          {/* Inline suggested-fix review (stack all matching jobs) */}
          {fixJobsForThread.length > 0 && (
            <div className="mx-1 mt-2">
              {fixJobsForThread.map((job) => (
                <FixJobInlineReview key={`${job.commentId}-${job.startedAt}-${job.status}`} job={job} ownerCommentId={thread.root.id} />
              ))}
            </div>
          )}

          {(isBotReReviewing || botNeedsManualRestart) && !isActedOn && (
            <div className="mx-1 mt-2 p-2 rounded border border-blue-500/30 bg-blue-500/5 text-xs text-blue-200">
              {isBotReReviewing
                ? `${botLabel} is currently re-reviewing this PR. This thread is temporarily excluded from your actionable queue until the bot responds.`
                : `${botLabel} is waiting for manual restart. Use the bot check/comment instructions to resume review; this thread is excluded from actionable items while waiting.`}
            </div>
          )}

          {/* Fix conversation */}
          {fixJob && (fixJob.status === "awaiting_response" || (fixJob.status === "running" && fixJob.conversation?.length)) && (
            <FixConversation commentId={rootId} repo={repo} />
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
                  onClick={() => setFixModalOpen(rootId, true)}
                  disabled={acting || fixing || isQueued || isBotReReviewing || botNeedsManualRestart}
                  title={isQueued ? "Already queued for fixing" : fixBlocked ? "Will be queued" : undefined}
                >
                  {fixing ? "Starting fix..." : isQueued ? "Queued" : fixBlocked ? "Queue Fix" : "Fix with Claude"}
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
      <Dialog open={fixModalOpen} onOpenChange={(open) => { if (!open) { setFixModalOpen(rootId, false); setFixInstructions(rootId, ""); } }}>
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
            onChange={(e) => setFixInstructions(rootId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                handleFixWithClaude(fixInstructions);
                setFixInstructions(rootId, "");
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <button
              onClick={() => { setFixModalOpen(rootId, false); setFixInstructions(rootId, ""); }}
              className="text-xs px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => { handleFixWithClaude(fixInstructions); setFixInstructions(rootId, ""); }}
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
