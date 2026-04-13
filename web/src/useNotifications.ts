import { useEffect, useRef } from "react";
import { api } from "./api";
import type { PullRequest, ReviewComment } from "./types";

const POLL_INTERVAL = 60_000; // 1 minute
const REVIEW_REMINDER_INTERVAL = 30 * 60_000; // 30 minutes
const MUTED_KEY = "code-triage:muted-prs";

export async function requestNotificationPermission(): Promise<void> {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
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

interface NotificationState {
  reviewPRKeys: Set<string>;
  allCommentKeys: Set<string>;      // all comments (raw, before analysis)
  pendingCommentKeys: Set<string>;   // analyzed + pending action
  prChecksStatus: Map<string, string>; // PR key -> checksStatus
  prOpenComments: Map<string, number>; // PR key -> openComments count
  initialized: boolean;
  lastReviewReminder: number;
}

export function getMutedPRs(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

export function mutePR(repo: string, number: number): void {
  const muted = getMutedPRs();
  muted.add(`${repo}:${number}`);
  localStorage.setItem(MUTED_KEY, JSON.stringify([...muted]));
}

export function unmutePR(repo: string, number: number): void {
  const muted = getMutedPRs();
  muted.delete(`${repo}:${number}`);
  localStorage.setItem(MUTED_KEY, JSON.stringify([...muted]));
}

export function isPRMuted(repo: string, number: number): boolean {
  return getMutedPRs().has(`${repo}:${number}`);
}

function prKey(pr: PullRequest): string {
  return `${pr.repo}:${pr.number}`;
}

function commentKey(c: ReviewComment, repo: string, prNumber: number): string {
  return `${repo}:${prNumber}:${c.id}`;
}

export function useNotifications(
  pulls: PullRequest[],
  reviewPulls: PullRequest[],
  onSelectPR: (number: number, repo: string) => void,
  onDataChanged: () => void,
) {
  const prevState = useRef<NotificationState>({
    reviewPRKeys: new Set(),
    allCommentKeys: new Set(),
    pendingCommentKeys: new Set(),
    prChecksStatus: new Map(),
    prOpenComments: new Map(),
    initialized: false,
    // eslint-disable-next-line react-hooks/purity -- useRef initial value only runs at mount
    lastReviewReminder: Date.now(),
  });

  // Keep callback refs fresh so effects always call the latest version without re-subscribing
  const onSelectPRRef = useRef(onSelectPR);
  onSelectPRRef.current = onSelectPR;
  const onDataChangedRef = useRef(onDataChanged);
  onDataChangedRef.current = onDataChanged;

  // Request permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // ── Track review PRs — detect new ones ──
  useEffect(() => {
    const muted = getMutedPRs();
    const currentKeys = new Set(reviewPulls.map(prKey));

    if (!prevState.current.initialized) {
      prevState.current.reviewPRKeys = currentKeys;
      return;
    }

    let hasNew = false;
    for (const pr of reviewPulls) {
      const key = prKey(pr);
      if (!prevState.current.reviewPRKeys.has(key) && !muted.has(key)) {
        hasNew = true;
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `Review requested: ${repoShort}#${pr.number}`,
          pr.title,
          () => onSelectPRRef.current(pr.number, pr.repo),
        );
      }
    }
    prevState.current.reviewPRKeys = currentKeys;
    if (hasNew) onDataChangedRef.current();
  }, [reviewPulls]);

  // ── Track CI status changes on your PRs ──
  useEffect(() => {
    if (!prevState.current.initialized) {
      // Initialize baseline
      for (const pr of pulls) {
        prevState.current.prChecksStatus.set(prKey(pr), pr.checksStatus);
      }
      return;
    }

    const muted = getMutedPRs();
    for (const pr of pulls) {
      const key = prKey(pr);
      const prev = prevState.current.prChecksStatus.get(key);
      if (prev && prev !== pr.checksStatus && !muted.has(key)) {
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        if (pr.checksStatus === "success") {
          notify(
            `Checks passed: ${repoShort}#${pr.number}`,
            pr.title,
            () => onSelectPRRef.current(pr.number, pr.repo),
          );
        } else if (pr.checksStatus === "failure") {
          notify(
            `Checks failed: ${repoShort}#${pr.number}`,
            pr.title,
            () => onSelectPRRef.current(pr.number, pr.repo),
          );
        }
      }
      prevState.current.prChecksStatus.set(key, pr.checksStatus);
    }
  }, [pulls]);

  // ── Track new comments on your PRs (open comment count changes) ──
  useEffect(() => {
    if (!prevState.current.initialized) {
      for (const pr of pulls) {
        prevState.current.prOpenComments.set(prKey(pr), pr.openComments);
      }
      return;
    }

    const muted = getMutedPRs();
    for (const pr of pulls) {
      const key = prKey(pr);
      const prev = prevState.current.prOpenComments.get(key) ?? 0;
      if (pr.openComments > prev && !muted.has(key)) {
        const newCount = pr.openComments - prev;
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `${newCount} new comment${newCount > 1 ? "s" : ""}: ${repoShort}#${pr.number}`,
          pr.title,
          () => onSelectPRRef.current(pr.number, pr.repo),
        );
      }
      prevState.current.prOpenComments.set(key, pr.openComments);
    }
  }, [pulls]);

  // ── Recurring review reminder every 30 minutes ──
  useEffect(() => {
    if (reviewPulls.length === 0) return;

    const interval = setInterval(() => {
      const now = Date.now();
      if (now - prevState.current.lastReviewReminder < REVIEW_REMINDER_INTERVAL) return;
      prevState.current.lastReviewReminder = now;

      const muted = getMutedPRs();
      const unmutedReviews = reviewPulls.filter((pr) => !muted.has(prKey(pr)));
      if (unmutedReviews.length === 0) return;

      if (unmutedReviews.length === 1) {
        const pr = unmutedReviews[0];
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `Waiting for your review: ${repoShort}#${pr.number}`,
          pr.title,
          () => onSelectPRRef.current(pr.number, pr.repo),
        );
      } else {
        notify(
          `${unmutedReviews.length} PRs waiting for your review`,
          unmutedReviews.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}: ${pr.title}`).join("\n"),
        );
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [reviewPulls]);

  // ── Initialize baseline for comment tracking ──
  useEffect(() => {
    if (pulls.length === 0 || prevState.current.initialized) return;

    (async () => {
      const allKeys = new Set<string>();
      const pendingKeys = new Set<string>();
      for (const pr of pulls) {
        try {
          const comments = await api.getPullComments(pr.number, pr.repo);
          for (const c of comments) {
            allKeys.add(commentKey(c, pr.repo, pr.number));
            if (c.crStatus === "pending" && c.evaluation) {
              pendingKeys.add(commentKey(c, pr.repo, pr.number));
            }
          }
        } catch { /* ignore */ }
      }
      prevState.current.allCommentKeys = allKeys;
      prevState.current.pendingCommentKeys = pendingKeys;
      prevState.current.initialized = true;
    })();
  }, [pulls]);

  // ── Poll for new/analyzed comments ──
  useEffect(() => {
    if (pulls.length === 0) return;

    const interval = setInterval(async () => {
      if (!prevState.current.initialized) return;

      let hasNew = false;
      const newAllKeys = new Set<string>();
      const newPendingKeys = new Set<string>();
      const muted = getMutedPRs();

      // Collect analyzed comment notifications to batch (digest mode)
      const newlyAnalyzed: Array<{ pr: typeof pulls[0]; c: Awaited<ReturnType<typeof api.getPullComments>>[0] }> = [];

      for (const pr of pulls) {
        const prk = prKey(pr);
        try {
          const comments = await api.getPullComments(pr.number, pr.repo);
          for (const c of comments) {
            const key = commentKey(c, pr.repo, pr.number);
            newAllKeys.add(key);

            // New human comment — notify immediately (high signal, not bursty)
            if (!prevState.current.allCommentKeys.has(key) && !muted.has(prk)) {
              if (!c.author.includes("[bot]")) {
                hasNew = true;
                const repoShort = pr.repo.split("/")[1] ?? pr.repo;
                notify(
                  `New comment on ${repoShort}#${pr.number}`,
                  `${c.author} commented on ${c.path}:${c.line}`,
                  () => onSelectPRRef.current(pr.number, pr.repo),
                );
              }
            }

            // Analysis completed — collect for digest
            if (c.crStatus === "pending" && c.evaluation) {
              newPendingKeys.add(key);
              if (!prevState.current.pendingCommentKeys.has(key) && !muted.has(prk)) {
                hasNew = true;
                newlyAnalyzed.push({ pr, c });
              }
            }
          }
        } catch { /* ignore */ }
      }

      // Fire analysis notifications as digest
      if (newlyAnalyzed.length === 1) {
        const { pr, c } = newlyAnalyzed[0]!;
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        const actionLabel = c.evaluation!.action === "fix" ? "Needs fix"
          : c.evaluation!.action === "reply" ? "Needs reply" : "Can resolve";
        notify(
          `${actionLabel}: ${repoShort}#${pr.number}`,
          `${c.path}:${c.line} — ${c.evaluation!.summary}`,
          () => onSelectPRRef.current(pr.number, pr.repo),
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

      prevState.current.allCommentKeys = newAllKeys;
      prevState.current.pendingCommentKeys = newPendingKeys;
      if (hasNew) onDataChangedRef.current();
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [pulls]);
}
