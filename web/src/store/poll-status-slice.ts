import type { FixJobStatus, PollStatus, QueuedFixItem } from "../api";
import { getQueryClient } from "../lib/query-client";
import { invalidatePrPullQueries, invalidatePullBundleQueries, qk } from "../lib/query-keys";
import { trpcClient } from "../lib/trpc";
import type { SliceCreator, PollStatusSlice } from "./types";

export const createPollStatusSlice: SliceCreator<PollStatusSlice> = (set, get) => ({
  polling: false,
  intervalMs: 0,
  baseIntervalMs: null,
  estimatedGithubRequestsPerHour: null,
  estimatedPollRequests: null,
  pollBudgetNote: null,
  pollPaused: false,
  pollPausedReason: null,
  rateLimited: false,
  rateLimitResetAt: null,
  rateLimitRemaining: null,
  rateLimitLimit: null,
  rateLimitResource: null,
  lastPollError: null,
  claude: null,
  nextPollDeadline: 0,
  countdown: 0,
  rateLimitNow: Date.now(),
  _eventSource: null,
  _countdownInterval: null,
  _rateLimitPollInterval: null,
  _lastPoll: 0,
  _sseDispose: null,

  connectSSE: () => {
    get().disconnectSSE();
    let pendingEvalRefresh: ReturnType<typeof setTimeout> | null = null;
    const schedulePullsRefresh = () => {
      if (pendingEvalRefresh) return;
      pendingEvalRefresh = setTimeout(() => {
        pendingEvalRefresh = null;
        void invalidatePullBundleQueries(getQueryClient());
      }, 300);
    };

    const sub = trpcClient.events.subscribe({
      events: [
        "poll-status",
        "fix-queue",
        "fix-job",
        "eval-complete",
        "ticket-status",
        "attention",
        "team-overview",
        "poll",
      ],
    }, {
      onStarted: () => {
        void get().fetchInitialStatus();
      },
      onData: (message: { event: string; data: unknown; at: number }) => {
        if (message.event === "poll-status") {
          const data = message.data as { status?: PollStatus };
          if (data.status) get().applyPollStatus(data.status);
          return;
        }
        if (message.event === "fix-queue") {
          get().setQueue(message.data as QueuedFixItem[]);
          return;
        }
        if (message.event === "fix-job") {
          const raw = message.data as Partial<FixJobStatus> & { commentId?: unknown };
          if (typeof raw.commentId !== "number") return;
          const patch: Partial<FixJobStatus> & { commentId: number } = { ...raw, commentId: raw.commentId };
          get().mergeFixJob(patch);
          const st = patch.status;
          if (
            (st === "completed" || st === "failed" || st === "no_changes")
            && patch.repo
            && patch.prNumber != null
          ) {
            void invalidatePrPullQueries(getQueryClient(), patch.repo, patch.prNumber);
            void get().refreshIfMatch(patch.repo, patch.prNumber);
          }
          return;
        }
        if (message.event === "eval-complete") {
          const data = message.data as { repo?: string; prNumber?: number };
          schedulePullsRefresh();
          if (data.repo && data.prNumber) {
            void invalidatePrPullQueries(getQueryClient(), data.repo, data.prNumber);
            void get().refreshIfMatch(data.repo, data.prNumber);
          }
          return;
        }
        if (message.event === "ticket-status") {
          void get().fetchTickets();
          return;
        }
        if (message.event === "attention") {
          void getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
          return;
        }
        if (message.event === "team-overview") {
          void getQueryClient().invalidateQueries({ queryKey: qk.team.root });
          return;
        }
        if (message.event === "poll") {
          void getQueryClient().invalidateQueries({ queryKey: qk.attention.root });
          const data = message.data as { ok?: boolean };
          if (data.ok === false) return;
          void invalidatePullBundleQueries(getQueryClient());
        }
      },
      onError: () => {
        void get().fetchInitialStatus();
      },
    });
    const dispose = () => sub.unsubscribe();

    set({ _sseDispose: dispose });

    return () => {
      if (pendingEvalRefresh) {
        clearTimeout(pendingEvalRefresh);
        pendingEvalRefresh = null;
      }
      get().disconnectSSE();
    };
  },

  disconnectSSE: () => {
    const dispose = get()._sseDispose;
    if (dispose) {
      dispose();
      set({ _sseDispose: null });
    } else {
      const es = get()._eventSource;
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
      }
    }
    set({ _eventSource: null });
  },

  fetchInitialStatus: async () => {
    try {
      const status = await trpcClient.pollStatus.query();
      get().applyPollStatus(status);
    } catch { /* ignore */ }
    try {
      const queue = await trpcClient.fixQueue.query();
      get().setQueue(queue);
    } catch { /* ignore */ }
  },

  applyPollStatus: (status: PollStatus) => {
    set({
      nextPollDeadline: status.nextPoll,
      pullsRefreshing: status.polling,
      polling: status.polling,
      intervalMs: status.intervalMs,
      baseIntervalMs: status.baseIntervalMs ?? null,
      estimatedGithubRequestsPerHour: status.estimatedGithubRequestsPerHour ?? null,
      estimatedPollRequests: status.estimatedPollRequests ?? null,
      pollBudgetNote: status.pollBudgetNote ?? null,
      pollPaused: status.pollPaused ?? false,
      pollPausedReason: status.pollPausedReason ?? null,
      rateLimited: status.rateLimited ?? false,
      rateLimitResetAt: status.rateLimitResetAt ?? null,
      rateLimitRemaining: status.rateLimitRemaining ?? null,
      rateLimitLimit: status.rateLimitLimit ?? null,
      rateLimitResource: status.rateLimitResource ?? null,
      lastPollError: status.lastPollError ?? null,
      claude: status.claude ?? null,
    });

    get().setJobs(status.fixJobs);

    if (status.fixQueue) {
      get().setQueue(status.fixQueue);
    }

    // Refresh pulls when `lastPoll` advances (including 0 → first timestamp after connect).
    if (status.lastPoll > get()._lastPoll) {
      void invalidatePullBundleQueries(getQueryClient());
      void get().refreshIfMatch(
        get().selectedPR?.repo ?? "",
        get().selectedPR?.number ?? 0,
      );
    }
    if (status.lastPoll > 0) {
      set({ _lastPoll: status.lastPoll });
    }
  },

  startCountdownTimer: () => {
    get().stopCountdownTimer();
    const id = setInterval(() => {
      const { nextPollDeadline, rateLimited, rateLimitResetAt } = get();
      const now = Date.now();
      if (nextPollDeadline > 0) {
        set({ countdown: Math.max(0, nextPollDeadline - now) });
      }
      if (rateLimited && rateLimitResetAt != null) {
        set({ rateLimitNow: now });
      }
    }, 1000);
    set({ _countdownInterval: id });
    return () => {
      clearInterval(id);
      set({ _countdownInterval: null });
    };
  },

  stopCountdownTimer: () => {
    const id = get()._countdownInterval;
    if (id) {
      clearInterval(id);
      set({ _countdownInterval: null });
    }
  },

  startRateLimitPoller: () => {
    get().stopRateLimitPoller();
    const id = setInterval(() => {
      if (get().rateLimited) {
        void trpcClient.pollStatus.query().then((s: PollStatus) => get().applyPollStatus(s)).catch(() => {});
      }
    }, 20_000);
    set({ _rateLimitPollInterval: id });
    return () => {
      clearInterval(id);
      set({ _rateLimitPollInterval: null });
    };
  },

  stopRateLimitPoller: () => {
    const id = get()._rateLimitPollInterval;
    if (id) {
      clearInterval(id);
      set({ _rateLimitPollInterval: null });
    }
  },
});
