import { api } from "../api";
import type { PollStatus } from "../api";
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

  connectSSE: () => {
    get().disconnectSSE();
    const es = new EventSource("/api/events");

    es.addEventListener("poll-status", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { status?: PollStatus };
        if (data.status) get().applyPollStatus(data.status);
      } catch { /* ignore */ }
    });

    es.addEventListener("eval-complete", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { repo?: string; prNumber?: number };
        if (data.repo && data.prNumber) {
          void get().refreshIfMatch(data.repo, data.prNumber);
        }
      } catch { /* ignore */ }
    });

    es.onerror = () => { /* browser auto-reconnects */ };

    set({ _eventSource: es });
    return () => {
      es.close();
      set({ _eventSource: null });
    };
  },

  disconnectSSE: () => {
    const es = get()._eventSource;
    if (es) {
      es.close();
      set({ _eventSource: null });
    }
  },

  fetchInitialStatus: async () => {
    try {
      const status = await api.getPollStatus();
      get().applyPollStatus(status);
    } catch { /* ignore */ }
  },

  applyPollStatus: (status: PollStatus) => {
    const prevJobs = get().jobs;
    const prevJobMap = new Map(prevJobs.map((j) => [j.commentId, j.status]));

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

    // Fire browser notifications for fix job state transitions
    for (const job of status.fixJobs) {
      const prev = prevJobMap.get(job.commentId);
      if (prev !== "running") continue;
      const repoShort = job.repo.split("/")[1] ?? job.repo;
      if (job.status === "completed" && "Notification" in window && Notification.permission === "granted") {
        new Notification(`Fix ready: ${repoShort}#${job.prNumber}`, {
          body: `${job.path} — review and apply the changes`,
        });
      } else if (job.status === "no_changes" && "Notification" in window && Notification.permission === "granted") {
        new Notification(`No changes needed: ${repoShort}#${job.prNumber}`, {
          body: `${job.path} — review suggested reply`,
        });
      } else if (job.status === "failed" && "Notification" in window && Notification.permission === "granted") {
        new Notification(`Fix failed: ${repoShort}#${job.prNumber}`, {
          body: `${job.path} — ${job.error ?? "unknown error"}`,
        });
      }
    }

    // Test notification handling
    if (status.testNotification) {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("Code Triage — Test Notification", {
          body: "Notifications are working!",
          icon: "/logo.png",
        });
      }
      void api.getPollStatus().catch(() => {});
    }

    // Refresh pulls if backend has new data
    if (status.lastPoll > get()._lastPoll && get()._lastPoll > 0) {
      void get().fetchPulls();
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
        void api.getPollStatus().then((s) => get().applyPollStatus(s)).catch(() => {});
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
