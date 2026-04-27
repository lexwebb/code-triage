import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useAppStore } from "../store";
import { CollapsibleSection } from "./ui/collapsible-section";
import { Checkbox } from "./ui/checkbox";
import { buildThreads, isSnoozed, type Thread } from "./thread-utils";
import { ThreadFilters } from "./thread-filters";
import { ThreadItem, type ThreadKeyActions } from "./thread-item";

type BotReviewState = "idle" | "re_reviewing" | "manual_restart_required";
type BotReviewStatus = { botLabel: string; state: Exclude<BotReviewState, "idle"> };

function normalizeBotKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/\[bot\]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export default function CommentThreads() {
  const comments = useAppStore((s) => s.comments);
  const jobs = useAppStore((s) => s.jobs);
  const detail = useAppStore((s) => s.detail);
  const checkSuites = useAppStore((s) => s.checkSuites);
  const fetchChecks = useAppStore((s) => s.fetchChecks);
  const shortcutsOpen = useAppStore((s) => s.shortcutsOpen);
  const filterText = useAppStore((s) => s.threadFilterText);
  const filterAction = useAppStore((s) => s.threadFilterAction);
  const showSnoozed = useAppStore((s) => s.threadShowSnoozed);
  const focusedIdx = useAppStore((s) => s.threadFocusedIdx);
  const selected = useAppStore((s) => s.threadSelected);
  const batching = useAppStore((s) => s.threadBatching);
  const setFocusedIdx = useAppStore((s) => s.setThreadFocusedIdx);
  const toggleThreadSelected = useAppStore((s) => s.toggleThreadSelected);
  const selectAllThreads = useAppStore((s) => s.selectAllThreads);
  const clearThreadSelected = useAppStore((s) => s.clearThreadSelected);
  const batchAction = useAppStore((s) => s.batchAction);

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

  useEffect(() => { threadsRef.current = threads; });
  useLayoutEffect(() => { focusedIdxRef.current = focusedIdx; });

  function registerRowEl(id: number, el: HTMLDivElement | null) {
    if (el) {
      rowElsRef.current.set(id, el);
    } else {
      rowElsRef.current.delete(id);
    }
  }

  useEffect(() => {
    const cur = focusedIdxRef.current;
    if (cur === null) return;
    if (threads.length === 0) { setFocusedIdx(null); return; }
    const clamped = Math.min(cur, threads.length - 1);
    if (clamped !== cur) setFocusedIdx(clamped);
  }, [threads.length, setFocusedIdx]);

  useEffect(() => {
    const list = threadsRef.current;
    if (focusedIdx === null || focusedIdx < 0 || focusedIdx >= list.length) return;
    const id = list[focusedIdx]!.root.id;
    rowElsRef.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusedIdx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shortcutsOpen) return;
      const tgt = e.target;
      if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement) {
        return;
      }
      if (tgt instanceof HTMLElement && tgt.isContentEditable) return;

      const list = threadsRef.current;

      if (e.key === "j" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const i = focusedIdxRef.current;
        if (list.length === 0) { setFocusedIdx(null); return; }
        if (i === null) { setFocusedIdx(0); return; }
        setFocusedIdx(Math.min(list.length - 1, i + 1));
        return;
      }
      if (e.key === "k" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const i = focusedIdxRef.current;
        if (list.length === 0) { setFocusedIdx(null); return; }
        if (i === null) { setFocusedIdx(0); return; }
        setFocusedIdx(Math.max(0, i - 1));
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
  }, [shortcutsOpen, setFocusedIdx]);

  const queue = useAppStore((s) => s.queue);
  const botCheckStateByKey = useMemo<Map<string, BotReviewState>>(() => {
    const byKey = new Map<string, BotReviewState>();
    const suites = checkSuites ?? [];
    if (suites.length === 0) return byKey;

    const botKeys = new Set<string>();
    for (const thread of threads) {
      for (const c of [thread.root, ...thread.replies]) {
        if (c.isBot || c.author.includes("[bot]")) {
          const key = normalizeBotKey(c.author);
          if (key) botKeys.add(key);
        }
      }
    }
    if (botKeys.size === 0) return byKey;

    for (const key of botKeys) {
      const matchesBot = (text: string): boolean => {
        const normalized = normalizeBotKey(text);
        if (!normalized) return false;
        return normalized.includes(key) || key.includes(normalized);
      };

      const matchingSuites = suites.filter((suite) => matchesBot(suite.name));
      const matchingRuns = suites.flatMap((suite) =>
        suite.runs.filter((run) => matchesBot(run.name) || matchesBot(run.htmlUrl) || matchesBot(suite.name)),
      );

      if (matchingSuites.length === 0 && matchingRuns.length === 0) {
        byKey.set(key, "idle");
        continue;
      }
      if (matchingRuns.some((run) => run.conclusion === "action_required")) {
        byKey.set(key, "manual_restart_required");
        continue;
      }
      if (matchingRuns.some((run) => run.status === "queued" || run.status === "in_progress" || run.conclusion === null)) {
        byKey.set(key, "re_reviewing");
        continue;
      }
      if (matchingSuites.some((suite) => suite.conclusion === null)) {
        byKey.set(key, "re_reviewing");
        continue;
      }
      byKey.set(key, "idle");
    }
    return byKey;
  }, [checkSuites, threads]);

  const threadBotReviewStateById = useMemo(() => {
    const byId = new Map<number, BotReviewStatus>();
    for (const thread of threads) {
      const botsInThread = [thread.root, ...thread.replies].filter(
        (c) => c.isBot || c.author.includes("[bot]"),
      );
      for (const bot of botsInThread) {
        const key = normalizeBotKey(bot.author);
        const state = key ? (botCheckStateByKey.get(key) ?? "idle") : "idle";
        if (state !== "idle") {
          byId.set(thread.root.id, { botLabel: bot.author, state });
          break;
        }
      }
    }
    return byId;
  }, [botCheckStateByKey, threads]);

  useEffect(() => {
    void fetchChecks(detail?.headSha);
  }, [detail?.headSha, fetchChecks]);

  if (threads.length === 0) return null;

  const openCount = threads.filter((t) => !t.isResolved).length;
  const resolvedCount = threads.filter((t) => t.isResolved).length;
  const hasActiveFix = jobs.some((j) => j.status === "running" || j.status === "completed");

  const actionableThreads = threads.filter((t) => {
    if (t.isResolved) return false;
    if (t.root.crStatus === "replied" || t.root.crStatus === "dismissed") return false;
    // When a bot is still processing/requires restart, don't count those threads as user-actionable.
    if (threadBotReviewStateById.has(t.root.id)) return false;
    return true;
  });
  const allSelected = actionableThreads.length > 0 && actionableThreads.every((t) => selected.has(t.root.id));

  function toggleSelectAll() {
    if (allSelected) {
      clearThreadSelected();
    } else {
      selectAllThreads(actionableThreads.map((t) => t.root.id));
    }
  }

  function handleBatchAction(action: "reply" | "resolve" | "dismiss") {
    void batchAction(action);
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
          <ThreadFilters
            actionableCount={actionableThreads.length}
            allSelected={allSelected}
            selectedCount={selected.size}
            batching={batching}
            onToggleSelectAll={toggleSelectAll}
            onBatchAction={handleBatchAction}
          />
          <div className="px-6 pb-3 space-y-3 pt-3">
            {threads.map((thread, idx) => {
              const isActionable = actionableThreads.some((t) => t.root.id === thread.root.id);
              const qIdx = queue.findIndex((q) => q.commentId === thread.root.id);
              const fixQueueSlot = qIdx >= 0 ? { place: qIdx + 1, total: queue.length } : null;
              return (
                <div key={thread.root.id} className="flex items-start gap-2">
                  {isActionable && (
                    <Checkbox
                      checked={selected.has(thread.root.id)}
                      onCheckedChange={() => toggleThreadSelected(thread.root.id)}
                      className="mt-2 shrink-0"
                    />
                  )}
                  <div className={isActionable ? "flex-1 min-w-0" : "flex-1 min-w-0 pl-5"}>
                    <ThreadItem
                      rootId={thread.root.id}
                      thread={thread}
                      botReviewStatus={threadBotReviewStateById.get(thread.root.id)}
                      fixBlocked={hasActiveFix}
                      fixQueueSlot={fixQueueSlot}
                      isFocused={focusedIdx === idx}
                      registerRowEl={registerRowEl}
                      threadActionsRef={threadActionsRef}
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
