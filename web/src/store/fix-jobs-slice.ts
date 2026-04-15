import { toast } from "sonner";
import { api } from "../api";
import type { FixJobStatus } from "../api";
import { celebrateFixApplied } from "../lib/fix-apply-celebration";
import type { SliceCreator, FixJobsSlice } from "./types";

const FIX_APPLY_EXTENDED_MS = 1200;

export const createFixJobsSlice: SliceCreator<FixJobsSlice> = (set, get) => ({
  jobs: [],
  queue: [],
  replyText: {},
  noChangesReply: {},
  acting: {},
  fixApplyPhase: {},
  selectedJobId: null,

  setQueue: (items) => set({ queue: items }),

  cancelQueued: async (commentId) => {
    try {
      await api.cancelQueuedFix(commentId);
      set((s) => ({ queue: s.queue.filter((q) => q.commentId !== commentId) }));
    } catch (err) {
      console.error("Cancel queued fix failed:", err);
    }
  },

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

  mergeFixJob: (patch) => {
    set((s) => {
      const idx = s.jobs.findIndex((j) => j.commentId === patch.commentId);
      const prev = idx >= 0 ? s.jobs[idx]! : undefined;
      const base: FixJobStatus = prev ?? {
        commentId: patch.commentId,
        repo: patch.repo ?? "",
        prNumber: patch.prNumber ?? 0,
        path: patch.path ?? "",
        startedAt: patch.startedAt ?? Date.now(),
        status: patch.status ?? "running",
      };
      const merged: FixJobStatus = { ...base, ...patch, commentId: patch.commentId };
      const nextJobs =
        idx >= 0 ? s.jobs.map((j, i) => (i === idx ? merged : j)) : [...s.jobs, merged];

      const newReplies = { ...s.noChangesReply };
      if (merged.status === "no_changes" && merged.suggestedReply && !(merged.commentId in newReplies)) {
        newReplies[merged.commentId] = merged.suggestedReply;
      }
      return { jobs: nextJobs, noChangesReply: newReplies };
    });
  },

  setReplyText: (commentId, text) =>
    set((s) => ({ replyText: { ...s.replyText, [commentId]: text } })),

  setNoChangesReply: (commentId, text) =>
    set((s) => ({ noChangesReply: { ...s.noChangesReply, [commentId]: text } })),

  setSelectedJobId: (id) => set({ selectedJobId: id }),

  apply: async (repo, commentId, prNumber, branch) => {
    set((s) => ({
      acting: { ...s.acting, [commentId]: true },
      fixApplyPhase: { ...s.fixApplyPhase, [commentId]: "in_progress" },
    }));
    const phaseTimer = window.setTimeout(() => {
      set((s) => {
        if (!s.acting[commentId]) return s;
        return { fixApplyPhase: { ...s.fixApplyPhase, [commentId]: "extended" } };
      });
    }, FIX_APPLY_EXTENDED_MS);
    try {
      const result = await api.fixApply(repo, commentId, prNumber, branch);
      if (result.recoveredWorktree) {
        toast.success("Fix applied and pushed. Missing worktree was restored from your saved diff.");
      } else {
        toast.success("Fix applied and pushed!");
      }
      celebrateFixApplied();
      set({ selectedJobId: null });
      await get().reloadComments();
    } catch (err) {
      console.error("Apply failed:", err);
    } finally {
      window.clearTimeout(phaseTimer);
      set((s) => {
        const { [commentId]: _phase, ...restPhase } = s.fixApplyPhase;
        return {
          acting: { ...s.acting, [commentId]: false },
          fixApplyPhase: restPhase,
        };
      });
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
