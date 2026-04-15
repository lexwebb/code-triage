import { api } from "../api";
import type { QueuedFixItem } from "../api";
import { getQueryClient } from "../lib/query-client";
import { invalidatePullBundleQueries, qk } from "../lib/query-keys";
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
          queryFn: () => api.getPull(number, repo),
        }),
        qc.fetchQuery({
          queryKey: qk.pull.files(repo, number),
          queryFn: () => api.getPullFiles(number, repo),
        }),
        qc.fetchQuery({
          queryKey: qk.pull.comments(repo, number, autoEvaluate),
          queryFn: () => api.getPullComments(number, repo, { autoEvaluate }),
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
        queryFn: () => api.getPullComments(pr.number, pr.repo, { autoEvaluate }),
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
          queryFn: () => api.getPull(prNumber, repo),
        }),
        qc.fetchQuery({
          queryKey: qk.pull.comments(repo, prNumber, autoEvaluate),
          queryFn: () => api.getPullComments(prNumber, repo, { autoEvaluate }),
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
      await api.submitReview(pr.repo, pr.number, event, body);
      set({ showRequestChanges: false, reviewBody: "" });
      // Refresh detail to update reviewer states
      try {
        const qc = getQueryClient();
        const updated = await qc.fetchQuery({
          queryKey: qk.pull.detail(pr.repo, pr.number),
          queryFn: () => api.getPull(pr.number, pr.repo),
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
      await api.replyToComment(pr.repo, commentId, pr.number);
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
      await api.resolveComment(pr.repo, commentId, pr.number);
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
      await api.dismissComment(pr.repo, commentId, pr.number);
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
      await api.reEvaluate(pr.repo, commentId, pr.number);
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
        queryFn: () => api.getPullComments(pr.number, pr.repo, { autoEvaluate: true }),
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
      await api.updateCommentTriage(pr.repo, commentId, pr.number, patch);
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.triageBusyThreads);
        next.delete(commentId);
        return { triageBusyThreads: next };
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
      const result = await api.fixWithClaude(
        pr.repo, commentId, pr.number, detail.branch, comment, userInstructions,
      );
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
      await api.batchAction(action, items);
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
      await api.createComment(pr.repo, pr.number, commitId, filename, line.line, line.side, body);
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
        queryFn: () => api.getChecks(pr.number, pr.repo, headSha),
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
