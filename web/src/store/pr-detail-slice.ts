import type { QueuedFixItem } from "../api";
import { getQueryClient } from "../lib/query-client";
import { invalidatePullBundleQueries, qk } from "../lib/query-keys";
import { trpcClient } from "../lib/trpc";
import type { SliceCreator, PrDetailSlice } from "./types";

function isAuthoredPR(
  authored: Array<{ number: number; repo: string }>,
  pr: { number: number; repo: string },
): boolean {
  return authored.some((candidate) => candidate.number === pr.number && candidate.repo === pr.repo);
}

export const createPrDetailSlice: SliceCreator<PrDetailSlice> = (set, get) => ({
  selectedPR: null,
  detail: null,
  files: [],
  comments: [],
  selectedFile: null,
  activeTab: "threads",
  prDetailLoading: false,

  // Review form
  reviewBody: "",
  showRequestChanges: false,
  reviewSubmitting: false,
  reviewError: null,

  // Thread UI
  threadFilterText: "",
  threadFilterAction: "all",
  threadShowSnoozed: false,
  threadFocusedIdx: null,
  threadSelected: new Set(),
  threadBatching: false,
  expandedThreads: new Set(),
  actingThreads: new Set(),
  showSuggestionThreads: new Set(),
  triageBusyThreads: new Set(),
  noteDrafts: {},
  priorityDrafts: {},
  fixingThreads: new Set(),
  fixErrors: {},
  fixModalOpenThreads: new Set(),
  threadFixInstructions: {},
  reEvaluatingThreads: new Set(),
  runningAllEvals: false,

  // Diff view
  commentingLine: null,
  commentBody: "",
  commentSubmitting: false,
  diffViewType: "unified",

  // Checks
  checkSuites: null,
  checksError: null,
  checksKey: "",

  selectPR: async (number, repo) => {
    set({
      selectedPR: { number, repo },
      selectedFile: null,
      detail: null,
      files: [],
      comments: [],
      prDetailLoading: true,
      // Reset thread UI state
      threadFilterText: "",
      threadFilterAction: "all",
      threadShowSnoozed: false,
      threadFocusedIdx: null,
      threadSelected: new Set(),
      threadBatching: false,
      expandedThreads: new Set(),
      actingThreads: new Set(),
      showSuggestionThreads: new Set(),
      triageBusyThreads: new Set(),
      noteDrafts: {},
      priorityDrafts: {},
      fixingThreads: new Set(),
      fixErrors: {},
      fixModalOpenThreads: new Set(),
      threadFixInstructions: {},
      reEvaluatingThreads: new Set(),
      // Reset review form
      reviewBody: "",
      showRequestChanges: false,
      reviewSubmitting: false,
      reviewError: null,
      // Reset diff
      commentingLine: null,
      commentBody: "",
      commentSubmitting: false,
      diffViewType: "unified",
      // Reset checks
      checkSuites: null,
      checksError: null,
      checksKey: "",
    });

    try {
      const qc = getQueryClient();
      const autoEvaluate = isAuthoredPR(get().authored, { number, repo });
      const [detail, files, comments] = await Promise.all([
        qc.fetchQuery({
          queryKey: qk.pull.detail(repo, number),
          queryFn: () => trpcClient.pullDetail.query({ number, repo }),
        }),
        qc.fetchQuery({
          queryKey: qk.pull.files(repo, number),
          queryFn: () => trpcClient.pullFiles.query({ number, repo }),
        }),
        qc.fetchQuery({
          queryKey: qk.pull.comments(repo, number, autoEvaluate),
          queryFn: () => trpcClient.pullComments.query({ number, repo, autoEvaluate }),
        }),
      ]);
      // Bail if user navigated away
      const current = get().selectedPR;
      if (!current || current.number !== number || current.repo !== repo) return;

      const selectedFile =
        files.find((f) => comments.some((c) => c.path === f.filename))?.filename ??
        files[0]?.filename ??
        null;

      set({ detail, files, comments, selectedFile, prDetailLoading: false });
    } catch (err) {
      console.error("Failed to load PR:", err);
      set({ prDetailLoading: false });
    }
  },

  selectFile: (filename) => {
    set({ selectedFile: filename });
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  reloadComments: async () => {
    const pr = get().selectedPR;
    if (!pr) return;
    try {
      const autoEvaluate = isAuthoredPR(get().authored, pr);
      const qc = getQueryClient();
      await qc.invalidateQueries({ queryKey: qk.pull.comments(pr.repo, pr.number, autoEvaluate) });
      const comments = await qc.fetchQuery({
        queryKey: qk.pull.comments(pr.repo, pr.number, autoEvaluate),
        queryFn: () => trpcClient.pullComments.query({ number: pr.number, repo: pr.repo, autoEvaluate }),
        staleTime: 0,
      });
      set({ comments });
    } catch (err) {
      console.error("Failed to reload comments:", err);
    }
  },

  refreshIfMatch: async (repo, prNumber) => {
    const current = get().selectedPR;
    if (!current || current.repo !== repo || current.number !== prNumber) return;
    try {
      const qc = getQueryClient();
      const autoEvaluate = isAuthoredPR(get().authored, { number: prNumber, repo });
      const [detail, comments] = await Promise.all([
        qc.fetchQuery({
          queryKey: qk.pull.detail(repo, prNumber),
          queryFn: () => trpcClient.pullDetail.query({ number: prNumber, repo }),
        }),
        qc.fetchQuery({
          queryKey: qk.pull.comments(repo, prNumber, autoEvaluate),
          queryFn: () => trpcClient.pullComments.query({ number: prNumber, repo, autoEvaluate }),
          staleTime: 0,
        }),
      ]);
      set({ detail, comments });
    } catch {
      /* background refresh — ignore */
    }
  },

  submitReview: async (event, body) => {
    const pr = get().selectedPR;
    const detail = get().detail;
    if (!pr || !detail) return;
    set({ reviewSubmitting: true, reviewError: null });
    try {
      await trpcClient.actionReview.mutate({ repo: pr.repo, prNumber: pr.number, event, body });
      set({ showRequestChanges: false, reviewBody: "" });
      // Refresh detail to update reviewer states
      try {
        const qc = getQueryClient();
        const updated = await qc.fetchQuery({
          queryKey: qk.pull.detail(pr.repo, pr.number),
          queryFn: () => trpcClient.pullDetail.query({ number: pr.number, repo: pr.repo }),
          staleTime: 0,
        });
        set({ detail: updated });
      } catch { /* ignore */ }
    } catch (err) {
      set({ reviewError: (err as Error).message });
    } finally {
      set({ reviewSubmitting: false });
    }
  },

  setReviewBody: (text) => set({ reviewBody: text }),
  setShowRequestChanges: (show) => set({ showRequestChanges: show }),

  // Thread UI actions
  setThreadFilterText: (text) => set({ threadFilterText: text }),
  setThreadFilterAction: (action) => set({ threadFilterAction: action }),
  setThreadShowSnoozed: (show) => set({ threadShowSnoozed: show }),
  setThreadFocusedIdx: (idx) => set({ threadFocusedIdx: idx }),

  toggleThreadSelected: (id) =>
    set((s) => {
      const next = new Set(s.threadSelected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { threadSelected: next };
    }),

  selectAllThreads: (ids) => set({ threadSelected: new Set(ids) }),
  clearThreadSelected: () => set({ threadSelected: new Set() }),

  toggleThreadExpanded: (id) =>
    set((s) => {
      const next = new Set(s.expandedThreads);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedThreads: next };
    }),

  setShowSuggestion: (id, show) =>
    set((s) => {
      const next = new Set(s.showSuggestionThreads);
      if (show) next.add(id);
      else next.delete(id);
      return { showSuggestionThreads: next };
    }),

  setNoteDraft: (id, text) =>
    set((s) => ({ noteDrafts: { ...s.noteDrafts, [id]: text } })),

  setPriorityDraft: (id, text) =>
    set((s) => ({ priorityDrafts: { ...s.priorityDrafts, [id]: text } })),

  setFixModalOpen: (id, open) =>
    set((s) => {
      const next = new Set(s.fixModalOpenThreads);
      if (open) next.add(id);
      else next.delete(id);
      return { fixModalOpenThreads: next };
    }),

  setThreadFixInstructions: (id, text) =>
    set((s) => ({ threadFixInstructions: { ...s.threadFixInstructions, [id]: text } })),

  // Thread API actions
  replyToComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ actingThreads: new Set(s.actingThreads).add(commentId) }));
    try {
      await trpcClient.actionReply.mutate({ repo: pr.repo, commentId, prNumber: pr.number });
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.actingThreads);
        next.delete(commentId);
        return { actingThreads: next };
      });
    }
  },

  resolveComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ actingThreads: new Set(s.actingThreads).add(commentId) }));
    try {
      await trpcClient.actionResolve.mutate({ repo: pr.repo, commentId, prNumber: pr.number });
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.actingThreads);
        next.delete(commentId);
        return { actingThreads: next };
      });
    }
  },

  dismissComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ actingThreads: new Set(s.actingThreads).add(commentId) }));
    try {
      await trpcClient.actionDismiss.mutate({ repo: pr.repo, commentId, prNumber: pr.number });
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.actingThreads);
        next.delete(commentId);
        return { actingThreads: next };
      });
    }
  },

  reEvaluateComment: async (commentId) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ reEvaluatingThreads: new Set(s.reEvaluatingThreads).add(commentId) }));
    try {
      await trpcClient.actionReEvaluate.mutate({ repo: pr.repo, commentId, prNumber: pr.number });
      void invalidatePullBundleQueries(getQueryClient());
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.reEvaluatingThreads);
        next.delete(commentId);
        return { reEvaluatingThreads: next };
      });
    }
  },

  runEvalsForSelectedPR: async () => {
    const pr = get().selectedPR;
    if (!pr) return;
    set({ runningAllEvals: true });
    try {
      const qc = getQueryClient();
      const comments = await qc.fetchQuery({
        queryKey: qk.pull.comments(pr.repo, pr.number, true),
        queryFn: () => trpcClient.pullComments.query({ number: pr.number, repo: pr.repo, autoEvaluate: true }),
        staleTime: 0,
      });
      set({ comments });
      void invalidatePullBundleQueries(qc);
    } catch (err) {
      console.error("Failed to run evaluations:", err);
    } finally {
      set({ runningAllEvals: false });
    }
  },

  updateCommentTriage: async (commentId, patch) => {
    const pr = get().selectedPR;
    if (!pr) return;
    set((s) => ({ triageBusyThreads: new Set(s.triageBusyThreads).add(commentId) }));
    try {
      await trpcClient.actionCommentTriage.mutate({
        repo: pr.repo,
        commentId,
        prNumber: pr.number,
        ...(patch.snoozeUntil !== undefined ? { snoozeUntil: patch.snoozeUntil } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.triageNote !== undefined ? { triageNote: patch.triageNote } : {}),
      });
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.triageBusyThreads);
        next.delete(commentId);
        return { triageBusyThreads: next };
      });
    }
  },

  startBatchFix: async (threads, userInstructions) => {
    const pr = get().selectedPR;
    const detail = get().detail;
    if (!pr || !detail || threads.length < 2) return;
    const sorted = [...threads].sort((a, b) => a.commentId - b.commentId);
    const ids = sorted.map((t) => t.commentId);
    const primary = ids[0]!;
    const uniquePaths = [...new Set(sorted.map((t) => t.path))];
    const displayPath = `${sorted.length} threads (${uniquePaths.slice(0, 2).join(", ")}${uniquePaths.length > 2 ? ", …" : ""})`;

    set((s) => {
      const nextFixing = new Set(s.fixingThreads);
      for (const id of ids) nextFixing.add(id);
      const nextErrors = { ...s.fixErrors };
      for (const id of ids) nextErrors[id] = null;
      return { fixingThreads: nextFixing, fixErrors: nextErrors };
    });
    try {
      const result = await trpcClient.actionBatchFix.mutate({
        repo: pr.repo,
        prNumber: pr.number,
        branch: detail.branch,
        threads: sorted,
        ...(userInstructions ? { userInstructions } : {}),
      });
      if (result.success) {
        get().setJobs([
          ...get().jobs.filter(
            (j) => !ids.includes(j.commentId) && !(j.batchCommentIds?.some((c) => ids.includes(c))),
          ),
          {
            commentId: primary,
            batchCommentIds: ids,
            repo: pr.repo,
            prNumber: pr.number,
            path: displayPath,
            startedAt: Date.now(),
            status: "running",
            branch: result.branch,
          },
        ]);
        set((s) => {
          const next = new Set(s.fixModalOpenThreads);
          for (const id of ids) next.delete(id);
          return { fixModalOpenThreads: next };
        });
      }
    } catch (err) {
      const msg = (err as Error).message;
      set((s) => {
        const next = { ...s.fixErrors };
        for (const id of ids) next[id] = msg;
        return { fixErrors: next };
      });
    } finally {
      set((s) => {
        const next = new Set(s.fixingThreads);
        for (const id of ids) next.delete(id);
        return { fixingThreads: next };
      });
    }
  },

  startFix: async (commentId, comment, userInstructions) => {
    const pr = get().selectedPR;
    const detail = get().detail;
    if (!pr || !detail) return;
    set((s) => ({
      fixingThreads: new Set(s.fixingThreads).add(commentId),
      fixErrors: { ...s.fixErrors, [commentId]: null },
    }));
    try {
      const result = await trpcClient.actionFix.mutate({
        repo: pr.repo,
        commentId,
        prNumber: pr.number,
        branch: detail.branch,
        comment,
        ...(userInstructions ? { userInstructions } : {}),
      });
      if (result.success) {
        if (result.status === "queued") {
          const queueItem: QueuedFixItem = {
            commentId,
            repo: pr.repo,
            prNumber: pr.number,
            path: comment.path,
            branch: detail.branch,
            position: result.position ?? 0,
            queuedAt: new Date().toISOString(),
          };
          set((s) => ({ queue: [...s.queue, queueItem] }));
        } else {
          get().setJobs([
            ...get().jobs.filter((j) => j.commentId !== commentId),
            {
              commentId,
              repo: pr.repo,
              prNumber: pr.number,
              path: comment.path,
              startedAt: Date.now(),
              status: "running",
              branch: result.branch,
            },
          ]);
        }
        set((s) => {
          const next = new Set(s.fixModalOpenThreads);
          next.delete(commentId);
          return { fixModalOpenThreads: next };
        });
      }
    } catch (err) {
      set((s) => ({ fixErrors: { ...s.fixErrors, [commentId]: (err as Error).message } }));
    } finally {
      set((s) => {
        const next = new Set(s.fixingThreads);
        next.delete(commentId);
        return { fixingThreads: next };
      });
    }
  },

  batchAction: async (action) => {
    const pr = get().selectedPR;
    if (!pr) return;
    const selected = get().threadSelected;
    if (selected.size === 0) return;
    set({ threadBatching: true });
    try {
      const items = [...selected].map((commentId) => ({
        repo: pr.repo,
        commentId,
        prNumber: pr.number,
      }));
      await trpcClient.actionBatch.mutate({ action, items });
      set({ threadSelected: new Set() });
      await get().reloadComments();
    } finally {
      set({ threadBatching: false });
    }
  },

  // Diff actions
  setCommentingLine: (line) => set({ commentingLine: line, commentBody: "" }),
  setCommentBody: (body) => set({ commentBody: body }),

  submitInlineComment: async (commitId, filename) => {
    const pr = get().selectedPR;
    const line = get().commentingLine;
    const body = get().commentBody.trim();
    if (!pr || !line || !body) return;
    set({ commentSubmitting: true });
    try {
      await trpcClient.actionComment.mutate({
        repo: pr.repo,
        prNumber: pr.number,
        commitId,
        path: filename,
        line: line.line,
        side: line.side,
        body,
      });
      set({ commentingLine: null, commentBody: "" });
      await get().reloadComments();
    } finally {
      set({ commentSubmitting: false });
    }
  },

  setDiffViewType: (type) => set({ diffViewType: type }),

  // Checks actions
  fetchChecks: async (headSha) => {
    const pr = get().selectedPR;
    if (!pr) return;
    const key = `${pr.repo}:${pr.number}:${headSha ?? ""}`;
    if (key === get().checksKey && get().checkSuites !== null) return;
    set({ checksKey: key, checkSuites: null, checksError: null });
    try {
      const sha = headSha ?? "";
      const qc = getQueryClient();
      const suites = await qc.fetchQuery({
        queryKey: qk.pull.checks(pr.repo, pr.number, sha),
        queryFn: () => trpcClient.pullChecks.query({ number: pr.number, repo: pr.repo, ...(headSha ? { sha: headSha } : {}) }),
      });
      // Bail if PR changed while loading
      if (get().checksKey !== key) return;
      set({ checkSuites: suites });
    } catch (err) {
      if (get().checksKey !== key) return;
      set({ checksError: (err as Error).message });
    }
  },
});
