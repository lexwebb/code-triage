import { useCallback, useEffect, useRef, useState } from "react";
import type { PrCompanionChatMessage, PrCompanionBatchFix, PrCompanionQueueFix } from "../api";
import { trpcClient } from "../lib/trpc";
import { useAppStore } from "../store";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { buildPrCompanionBundle } from "../lib/pr-companion-bundle";
import type { ReviewComment } from "../types";
import { MessageSquare, PanelRightClose, PanelRightOpen, RotateCw, Trash2 } from "lucide-react";
import { Checkbox } from "./ui/checkbox";
import { CompanionChatMarkdown } from "./companion-chat-markdown";

const SUGGESTED_PROMPTS = [
  "Summarize all suggested fixes and whether any conflict with each other.",
  "What should I double-check before running fixes on this PR?",
  "Group these review threads by file and call out the riskiest changes first.",
  "When I agree, queue Fix-with-Claude for the fix threads we discussed, and fold our chat into userInstructions where helpful.",
  "When I agree, start one batch fix (single push) for the threads we listed — use the batch directive, not separate queue entries.",
];

async function runPrCompanionQueueFixes(items: PrCompanionQueueFix[], repo: string, prNumber: number): Promise<void> {
  for (const { commentId, userInstructions } of items) {
    const st = useAppStore.getState();
    const pr = st.selectedPR;
    const detail = st.detail;
    if (!pr || pr.repo !== repo || pr.number !== prNumber || !detail?.branch) continue;
    const c = st.comments.find((x) => x.id === commentId);
    if (!c || c.inReplyToId != null) continue;
    await st.startFix(
      commentId,
      { path: c.path, line: c.line, body: c.body, diffHunk: c.diffHunk ?? "" },
      userInstructions,
    );
  }
}

async function runPrCompanionBatchFix(batch: PrCompanionBatchFix, repo: string, prNumber: number): Promise<void> {
  const st = useAppStore.getState();
  const pr = st.selectedPR;
  const detail = st.detail;
  if (!pr || pr.repo !== repo || pr.number !== prNumber || !detail?.branch) return;
  const threads = batch.commentIds
    .map((id) => {
      const c = st.comments.find((x) => x.id === id);
      if (!c || c.inReplyToId != null) return null;
      return {
        commentId: id,
        path: c.path,
        line: c.line,
        body: c.body,
        diffHunk: c.diffHunk ?? "",
      };
    })
    .filter((t): t is NonNullable<typeof t> => t != null);
  if (threads.length < 2) return;
  await st.startBatchFix(threads, batch.userInstructions);
}

function formatSnapshotTime(ms: number | null): string {
  if (ms == null) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "—";
  }
}

export function PrCompanionPanel({
  repo,
  prNumber,
  comments,
}: {
  repo: string;
  prNumber: number;
  comments: ReviewComment[];
}) {
  const [open, setOpen] = useState(false);
  const [includeAllEvaluated, setIncludeAllEvaluated] = useState(false);
  const [messages, setMessages] = useState<PrCompanionChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingSession, setLoadingSession] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bundleUpdatedAtMs, setBundleUpdatedAtMs] = useState<number | null>(null);
  const [bundleThreadCount, setBundleThreadCount] = useState(0);
  const [refreshNext, setRefreshNext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const bundle = buildPrCompanionBundle(comments, { includeAllEvaluated });
  const fixThreadCount = buildPrCompanionBundle(comments, { includeAllEvaluated: false }).length;

  useEffect(() => {
    let cancel = false;
    setLoadingSession(true);
    void trpcClient
      .companionSession
      .query({ repo, prNumber })
      .then((s) => {
        if (cancel) return;
        setMessages(s.messages);
        setBundleUpdatedAtMs(s.bundleUpdatedAtMs);
        setBundleThreadCount(s.bundleThreadCount);
      })
      .catch(() => {
        if (!cancel) {
          setMessages([]);
        }
      })
      .finally(() => {
        if (!cancel) setLoadingSession(false);
      });
    return () => {
      cancel = true;
    };
  }, [repo, prNumber]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setError(null);
    const userMsg: PrCompanionChatMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    setInput("");
    try {
      const out = await trpcClient.companionMessage.mutate({
        repo,
        prNumber,
        userMessage: text,
        threadBundle: bundle,
        refreshContext: refreshNext || undefined,
      });
      setRefreshNext(false);
      setMessages(out.messages);
      setBundleUpdatedAtMs(out.bundleUpdatedAtMs);
      setBundleThreadCount(out.bundleThreadCount);
      const batch = out.batchFix;
      if (batch && batch.commentIds.length >= 2) {
        void runPrCompanionBatchFix(batch, repo, prNumber).catch((err) => {
          console.error("PR assistant batch fix:", err);
        });
      } else {
        const q = out.queueFixes;
        if (q && q.length > 0) {
          void runPrCompanionQueueFixes(q, repo, prNumber).catch((err) => {
            console.error("PR assistant queue fixes:", err);
          });
        }
      }
    } catch (e) {
      setError((e as Error).message);
      setInput(text);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "user" && last.content === text) return prev.slice(0, -1);
        return prev;
      });
    } finally {
      setLoading(false);
    }
  }, [repo, prNumber, input, loading, bundle, refreshNext]);

  async function handleReset() {
    setError(null);
    try {
      await trpcClient.companionReset.mutate({ repo, prNumber });
      setMessages([]);
      setBundleUpdatedAtMs(null);
      setBundleThreadCount(0);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const toggle = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className={cn(
        "flex items-center justify-center gap-1.5 shrink-0 border-gray-800 bg-gray-900/90 text-gray-400 hover:text-gray-200 hover:bg-gray-800/90 transition-colors",
        "px-2 py-2 md:py-3 md:px-1 md:[writing-mode:vertical-rl] md:rotate-180",
        "w-full md:w-9",
      )}
      title={open ? "Hide PR assistant" : "Open PR assistant"}
    >
      {open ? <PanelRightClose size={18} className="md:rotate-90 shrink-0" /> : <PanelRightOpen size={18} className="md:rotate-90 shrink-0" />}
      <span className="text-xs font-medium md:mt-1">PR assistant</span>
      {!open && fixThreadCount > 0 && (
        <span className="text-[10px] rounded-full bg-orange-500/25 text-orange-300 px-1.5 py-0.5 md:hidden">
          {fixThreadCount} fix{fixThreadCount === 1 ? "" : "es"}
        </span>
      )}
    </button>
  );

  if (!open) {
    return (
      <div className="flex flex-col md:h-full md:border-l border-gray-800 shrink-0">
        <div className="md:hidden border-t border-gray-800">{toggle}</div>
        <div className="hidden md:flex md:h-full">{toggle}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col border-gray-800 bg-gray-950 shrink-0 min-h-0",
        "w-full max-h-[42vh] border-t md:border-t-0 md:border-l md:max-h-none md:h-full md:w-96",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessageSquare size={16} className="text-indigo-400 shrink-0" />
          <span className="text-sm font-medium text-gray-200 truncate">PR assistant</span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="p-1.5 rounded text-gray-500 hover:text-gray-300 hover:bg-gray-800 shrink-0"
          title="Collapse PR assistant"
        >
          <PanelRightClose size={16} />
        </button>
      </div>

      <p className="px-3 py-1.5 text-[10px] text-gray-500 border-b border-gray-800/80 shrink-0 leading-relaxed">
        Optional: the assistant can <strong className="text-gray-400">queue Fix-with-Claude</strong> (with extra <code className="text-gray-600">userInstructions</code>) when you ask it to — same flow as thread buttons. Per-thread fix chat stays in each thread.
      </p>

      <div className="px-3 py-2 flex flex-wrap items-center gap-2 border-b border-gray-800/80 shrink-0 text-[10px] text-gray-500">
        <span>
          Context: <strong className="text-gray-400">{bundleThreadCount}</strong> thread{bundleThreadCount === 1 ? "" : "s"} · bundle{" "}
          <strong className="text-gray-400">{formatSnapshotTime(bundleUpdatedAtMs)}</strong>
        </span>
        <button
          type="button"
          onClick={() => setRefreshNext(true)}
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-700 hover:bg-gray-800 text-gray-400",
            refreshNext && "border-indigo-500/50 text-indigo-300",
          )}
          title="Mark the next send as an explicit context refresh"
        >
          <RotateCw size={12} />
          Refresh next send
        </button>
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-gray-400">
          <Checkbox checked={includeAllEvaluated} onCheckedChange={(v) => setIncludeAllEvaluated(v === true)} />
          All evaluated
        </label>
        <button
          type="button"
          onClick={() => void handleReset()}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-700 hover:bg-gray-800 text-gray-500 ml-auto"
          title="Clear this PR’s assistant history"
        >
          <Trash2 size={12} />
          Clear chat
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
        {loadingSession && <p className="text-xs text-gray-500">Loading session…</p>}
        {!loadingSession && messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              Ask about <strong className="text-gray-400">{bundle.length}</strong> thread{bundle.length === 1 ? "" : "s"} in the current
              bundle ({includeAllEvaluated ? "all evaluated" : "fix suggestions only"}).
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setInput(p)}
                  className="text-left text-[11px] px-2 py-1.5 rounded border border-gray-800 bg-gray-900/50 text-gray-400 hover:border-gray-600 hover:text-gray-300"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "rounded-lg px-2.5 py-2 break-words min-w-0",
              m.role === "user" ? "bg-indigo-950/40 text-indigo-100 ml-4 border border-indigo-500/20" : "bg-gray-900/80 text-gray-300 mr-4 border border-gray-800",
            )}
          >
            <span className="text-[9px] uppercase tracking-wide text-gray-500 block mb-1">{m.role === "user" ? "You" : "Assistant"}</span>
            <CompanionChatMarkdown
              content={m.content}
              className={m.role === "user" ? "[&_a]:text-indigo-200 [&_blockquote]:border-indigo-400/40" : ""}
            />
          </div>
        ))}
        {loading && <p className="text-xs text-gray-500 italic">Thinking…</p>}
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-red-400 border-t border-red-500/20 bg-red-500/5 shrink-0">{error}</div>
      )}

      <div className="p-2 border-t border-gray-800 shrink-0 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Message… (empty thread list still ok — assistant has less context)"
          disabled={loading}
          rows={3}
          className="flex-1 text-xs bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500/60 resize-none min-h-[4.5rem]"
        />
        <Button variant="blue" size="sm" className="self-end shrink-0" disabled={loading || !input.trim()} onClick={() => void send()}>
          Send
        </Button>
      </div>

    </div>
  );
}
