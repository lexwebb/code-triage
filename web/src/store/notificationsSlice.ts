import { api } from "../api";
import type { PullRequest } from "../types";
import type { SliceCreator, NotificationsSlice } from "./types";

function prKey(pr: PullRequest): string {
  return `${pr.repo}:${pr.number}`;
}

function commentKey(id: number, repo: string, prNumber: number): string {
  return `${repo}:${prNumber}:${id}`;
}

function notify(title: string, body: string, onClick?: () => void) {
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(title, { body, icon: "/logo.png" });
    if (onClick) {
      n.onclick = () => {
        window.focus();
        onClick();
        n.close();
      };
    }
  }
}

export const createNotificationsSlice: SliceCreator<NotificationsSlice> = (set, get) => ({
  mutedPRs: new Set(),
  permission: "Notification" in window ? Notification.permission : "denied",
  initialized: false,
  commentBaselineReady: false,
  _previousReviewPRKeys: new Set(),
  _previousCommentKeys: new Set(),
  _previousPendingKeys: new Set(),
  _previousChecksStatus: new Map(),
  _previousOpenComments: new Map(),
  _lastReviewReminder: Date.now(),
  _reminderInterval: null,
  _permissionInterval: null,

  initializeBaseline: async () => {
    const { authored, reviewRequested } = get();
    if (authored.length === 0 || get().initialized) return;

    // Seed review PR keys
    set({ _previousReviewPRKeys: new Set(reviewRequested.map(prKey)) });

    // Seed checks status and open comment counts
    const checksMap = new Map<string, string>();
    const openCommentsMap = new Map<string, number>();
    for (const pr of authored) {
      checksMap.set(prKey(pr), pr.checksStatus);
      openCommentsMap.set(prKey(pr), pr.openComments);
    }
    set({ _previousChecksStatus: checksMap, _previousOpenComments: openCommentsMap });

    // Fetch all comments to build baseline
    const allKeys = new Set<string>();
    const pendingKeys = new Set<string>();
    for (const pr of authored) {
      try {
        const comments = await api.getPullComments(pr.number, pr.repo);
        for (const c of comments) {
          allKeys.add(commentKey(c.id, pr.repo, pr.number));
          if (c.crStatus === "pending" && c.evaluation) {
            pendingKeys.add(commentKey(c.id, pr.repo, pr.number));
          }
        }
      } catch { /* ignore */ }
    }

    set({
      _previousCommentKeys: allKeys,
      _previousPendingKeys: pendingKeys,
      initialized: true,
      commentBaselineReady: true,
    });
  },

  diffAndNotify: async () => {
    const state = get();
    if (!state.initialized || !state.commentBaselineReady) return;
    if (state.authored.length === 0) return;

    const muted = state.mutedPRs;

    // ── Review PRs: detect new ones ──
    const currentReviewKeys = new Set(state.reviewRequested.map(prKey));
    for (const pr of state.reviewRequested) {
      const key = prKey(pr);
      if (!state._previousReviewPRKeys.has(key) && !muted.has(key)) {
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `Review requested: ${repoShort}#${pr.number}`,
          pr.title,
          () => get().selectPR(pr.number, pr.repo),
        );
      }
    }
    set({ _previousReviewPRKeys: currentReviewKeys });

    // ── CI status changes ──
    const newChecks = new Map<string, string>();
    for (const pr of state.authored) {
      const key = prKey(pr);
      const prev = state._previousChecksStatus.get(key);
      if (prev && prev !== pr.checksStatus && !muted.has(key)) {
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        if (pr.checksStatus === "success") {
          notify(`Checks passed: ${repoShort}#${pr.number}`, pr.title,
            () => get().selectPR(pr.number, pr.repo));
        } else if (pr.checksStatus === "failure") {
          notify(`Checks failed: ${repoShort}#${pr.number}`, pr.title,
            () => get().selectPR(pr.number, pr.repo));
        }
      }
      newChecks.set(key, pr.checksStatus);
    }
    set({ _previousChecksStatus: newChecks });

    // ── Open comment count changes ──
    const newOpenComments = new Map<string, number>();
    for (const pr of state.authored) {
      const key = prKey(pr);
      const prev = state._previousOpenComments.get(key) ?? 0;
      if (pr.openComments > prev && !muted.has(key)) {
        const newCount = pr.openComments - prev;
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `${newCount} new comment${newCount > 1 ? "s" : ""}: ${repoShort}#${pr.number}`,
          pr.title,
          () => get().selectPR(pr.number, pr.repo),
        );
      }
      newOpenComments.set(key, pr.openComments);
    }
    set({ _previousOpenComments: newOpenComments });

    // ── Detailed comment diff (new comments, newly analyzed) ──
    const newAllKeys = new Set<string>();
    const newPendingKeys = new Set<string>();
    const newlyAnalyzed: Array<{ pr: PullRequest; c: Awaited<ReturnType<typeof api.getPullComments>>[0] }> = [];

    for (const pr of state.authored) {
      const pk = prKey(pr);
      try {
        const comments = await api.getPullComments(pr.number, pr.repo);
        for (const c of comments) {
          const key = commentKey(c.id, pr.repo, pr.number);
          newAllKeys.add(key);

          if (!state._previousCommentKeys.has(key) && !muted.has(pk)) {
            if (!c.author.includes("[bot]")) {
              const repoShort = pr.repo.split("/")[1] ?? pr.repo;
              notify(
                `New comment on ${repoShort}#${pr.number}`,
                `${c.author} commented on ${c.path}:${c.line}`,
                () => get().selectPR(pr.number, pr.repo),
              );
            }
          }

          if (c.crStatus === "pending" && c.evaluation) {
            newPendingKeys.add(key);
            if (!state._previousPendingKeys.has(key) && !muted.has(pk)) {
              newlyAnalyzed.push({ pr, c });
            }
          }
        }
      } catch { /* ignore */ }
    }

    // Grouped notifications for newly analyzed comments
    if (newlyAnalyzed.length === 1) {
      const { pr, c } = newlyAnalyzed[0]!;
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      const actionLabel = c.evaluation!.action === "fix" ? "Needs fix"
        : c.evaluation!.action === "reply" ? "Needs reply" : "Can resolve";
      notify(
        `${actionLabel}: ${repoShort}#${pr.number}`,
        `${c.path}:${c.line} — ${c.evaluation!.summary}`,
        () => get().selectPR(pr.number, pr.repo),
      );
    } else if (newlyAnalyzed.length > 1) {
      const fixes = newlyAnalyzed.filter((e) => e.c.evaluation?.action === "fix").length;
      const replies = newlyAnalyzed.filter((e) => e.c.evaluation?.action === "reply").length;
      const parts: string[] = [];
      if (fixes > 0) parts.push(`${fixes} fix${fixes > 1 ? "es" : ""}`);
      if (replies > 0) parts.push(`${replies} repl${replies > 1 ? "ies" : "y"}`);
      if (parts.length === 0) parts.push(`${newlyAnalyzed.length} comments`);
      notify(
        `${newlyAnalyzed.length} comments need action`,
        parts.join(", ") + " across your PRs",
      );
    }

    set({
      _previousCommentKeys: newAllKeys,
      _previousPendingKeys: newPendingKeys,
    });
  },

  mutePR: (repo, number) =>
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.add(`${repo}:${number}`);
      return { mutedPRs: next };
    }),

  unmutePR: (repo, number) =>
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.delete(`${repo}:${number}`);
      return { mutedPRs: next };
    }),

  isPRMuted: (repo, number) => get().mutedPRs.has(`${repo}:${number}`),

  requestPermission: async () => {
    if ("Notification" in window && Notification.permission === "default") {
      const result = await Notification.requestPermission();
      set({ permission: result });
    }
  },

  testNotification: () => {
    if ("Notification" in window) {
      if (Notification.permission === "granted") {
        new Notification("Code Triage — Test", { body: "Notifications are working!", icon: "/logo.png" });
      } else if (Notification.permission === "default") {
        Notification.requestPermission().then((p) => {
          set({ permission: p });
          if (p === "granted") {
            new Notification("Code Triage — Test", { body: "Notifications are working!", icon: "/logo.png" });
          }
        });
      } else {
        alert("Notifications are blocked. Please enable them in your browser settings.");
      }
    }
  },

  startReminderInterval: () => {
    const existing = get()._reminderInterval;
    if (existing) clearInterval(existing);

    const id = setInterval(() => {
      const s = get();
      if (s.reviewRequested.length === 0) return;
      const now = Date.now();
      if (now - s._lastReviewReminder < 30 * 60_000) return;
      set({ _lastReviewReminder: now });

      const unmuted = s.reviewRequested.filter((pr) => !s.mutedPRs.has(prKey(pr)));
      if (unmuted.length === 0) return;

      if (unmuted.length === 1) {
        const pr = unmuted[0];
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `Waiting for your review: ${repoShort}#${pr.number}`,
          pr.title,
          () => get().selectPR(pr.number, pr.repo),
        );
      } else {
        notify(
          `${unmuted.length} PRs waiting for your review`,
          unmuted.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}: ${pr.title}`).join("\n"),
        );
      }
    }, 60_000);

    set({ _reminderInterval: id });
    return () => {
      clearInterval(id);
      set({ _reminderInterval: null });
    };
  },

  checkPermissionPeriodically: () => {
    const existing = get()._permissionInterval;
    if (existing) clearInterval(existing);

    const id = setInterval(() => {
      if ("Notification" in window && Notification.permission !== get().permission) {
        set({ permission: Notification.permission });
      }
    }, 5000);

    set({ _permissionInterval: id });
    return () => {
      clearInterval(id);
      set({ _permissionInterval: null });
    };
  },
});
