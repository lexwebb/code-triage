import { api } from "../api";
import type { SliceCreator, FixJobsSlice } from "./types";

export const createFixJobsSlice: SliceCreator<FixJobsSlice> = (set, get) => ({
  jobs: [],
  replyText: {},
  noChangesReply: {},
  acting: {},
  selectedJobId: null,

  setJobs: (jobs) => {
    // Initialize noChangesReply for new no_changes jobs
    const newReplies = { ...get().noChangesReply };
    for (const job of jobs) {
      if (job.status === "no_changes" && job.suggestedReply && !(job.commentId in newReplies)) {
        newReplies[job.commentId] = job.suggestedReply;
      }
    }
    set({ jobs, noChangesReply: newReplies });
  },

  setReplyText: (commentId, text) =>
    set((s) => ({ replyText: { ...s.replyText, [commentId]: text } })),

  setNoChangesReply: (commentId, text) =>
    set((s) => ({ noChangesReply: { ...s.noChangesReply, [commentId]: text } })),

  setSelectedJobId: (id) => set({ selectedJobId: id }),

  apply: async (repo, commentId, prNumber, branch) => {
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixApply(repo, commentId, prNumber, branch);
      set({ selectedJobId: null });
      await get().reloadComments();
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },

  discard: async (branch, commentId) => {
    if (commentId != null) {
      set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    }
    try {
      await api.fixDiscard(branch, commentId);
      set({ selectedJobId: null });
      await get().reloadComments();
    } catch (err) {
      console.error("Discard failed:", err);
    } finally {
      if (commentId != null) {
        set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
      }
    }
  },

  sendReply: async (repo, commentId, message) => {
    if (!message.trim()) return;
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixReply(repo, commentId, message.trim());
      set((s) => ({ replyText: { ...s.replyText, [commentId]: "" } }));
    } catch (err) {
      console.error("Reply failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },

  sendReplyAndResolve: async (repo, commentId, prNumber, replyBody) => {
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixReplyAndResolve(repo, commentId, prNumber, replyBody);
      set({ selectedJobId: null });
      await get().reloadComments();
    } catch (err) {
      console.error("Reply & resolve failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },

  retryFix: async (repo, commentId, prNumber, branch, originalComment) => {
    set((s) => ({ acting: { ...s.acting, [commentId]: true } }));
    try {
      await api.fixWithClaude(repo, commentId, prNumber, branch, originalComment);
    } catch (err) {
      console.error("Retry failed:", err);
    } finally {
      set((s) => ({ acting: { ...s.acting, [commentId]: false } }));
    }
  },
});
