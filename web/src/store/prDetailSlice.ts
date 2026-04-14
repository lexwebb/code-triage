import { api } from "../api";
import type { QueuedFixItem } from "../api";
import { parseRoute, pushRoute } from "../router";
import type { SliceCreator, PrDetailSlice } from "./types";

export const createPrDetailSlice: SliceCreator<PrDetailSlice> = (set, get) => ({
  selectedPR: (() => {
    const initial = parseRoute();
    return initial.repo && initial.prNumber
      ? { repo: initial.repo, number: initial.prNumber }
      : null;
  })(),
  detail: null,
  files: [],
  comments: [],
  selectedFile: parseRoute().file,
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
    pushRoute({ repo, prNumber: number, file: null });

    try {
      const [detail, files, comments] = await Promise.all([
        api.getPull(number, repo),
        api.getPullFiles(number, repo),
        api.getPullComments(number, repo),
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
    const pr = get().selectedPR;
    pushRoute({ repo: pr?.repo ?? null, prNumber: pr?.number ?? null, file: filename });
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  reloadComments: async () => {
    const pr = get().selectedPR;
    if (!pr) return;
    try {
      const comments = await api.getPullComments(pr.number, pr.repo);
      set({ comments });
    } catch (err) {
      console.error("Failed to reload comments:", err);
    }
  },

  refreshIfMatch: async (repo, prNumber) => {
    const current = get().selectedPR;
    if (!current || current.repo !== repo || current.number !== prNumber) return;
    try {
      const [detail, comments] = await Promise.all([
        api.getPull(prNumber, repo),
        api.getPullComments(prNumber, repo),
      ]);
      set({ detail, comments });
    } catch {
      /* background refresh — ignore */
    }
  },

  handlePopState: () => {
    const route = parseRoute();
    if (route.repo && route.prNumber) {
      // Only re-fetch if PR actually changed
      const current = get().selectedPR;
      if (!current || current.number !== route.prNumber || current.repo !== route.repo) {
        void get().selectPR(route.prNumber, route.repo);
      }
    } else {
      set({
        selectedPR: null,
        detail: null,
        files: [],
        comments: [],
      });
    }
    set({ selectedFile: route.file });
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
        const updated = await api.getPull(pr.number, pr.repo);
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
      await get().reloadComments();
    } finally {
      set((s) => {
        const next = new Set(s.reEvaluatingThreads);
        next.delete(commentId);
        return { reEvaluatingThreads: next };
      });
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
      const suites = await api.getChecks(pr.number, pr.repo, headSha);
      // Bail if PR changed while loading
      if (get().checksKey !== key) return;
      set({ checkSuites: suites });
    } catch (err) {
      if (get().checksKey !== key) return;
      set({ checksError: (err as Error).message });
    }
  },
});
