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
    const n = new Notification(title, { body, icon: "/favicon.ico" });
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
  pendingCommentKeys: Set<string>;
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
    pendingCommentKeys: new Set(),
    initialized: false,
    lastReviewReminder: Date.now(),
  });

  // Request permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Track review PRs — detect new ones
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
          () => onSelectPR(pr.number, pr.repo),
        );
      }
    }
    prevState.current.reviewPRKeys = currentKeys;
    if (hasNew) onDataChanged();
  }, [reviewPulls]);

  // Recurring review reminder every 30 minutes for unmuted review PRs
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
          () => onSelectPR(pr.number, pr.repo),
        );
      } else {
        notify(
          `${unmutedReviews.length} PRs waiting for your review`,
          unmutedReviews.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}: ${pr.title}`).join("\n"),
        );
      }
    }, 60_000); // check every minute, but only fire every 30 min

    return () => clearInterval(interval);
  }, [reviewPulls]);

  // Initialize pending comment baseline once pulls are loaded
  useEffect(() => {
    if (pulls.length === 0 || prevState.current.initialized) return;

    (async () => {
      const keys = new Set<string>();
      for (const pr of pulls) {
        try {
          const comments = await api.getPullComments(pr.number, pr.repo);
          for (const c of comments) {
            if (c.crStatus === "pending" && c.evaluation) {
              keys.add(commentKey(c, pr.repo, pr.number));
            }
          }
        } catch { /* ignore */ }
      }
      prevState.current.pendingCommentKeys = keys;
      prevState.current.initialized = true;
    })();
  }, [pulls]);

  // Poll for new pending comments
  useEffect(() => {
    if (pulls.length === 0) return;

    const interval = setInterval(async () => {
      if (!prevState.current.initialized) return;

      let hasNew = false;
      const newKeys = new Set<string>();

      for (const pr of pulls) {
        try {
          const comments = await api.getPullComments(pr.number, pr.repo);
          for (const c of comments) {
            if (c.crStatus === "pending" && c.evaluation) {
              const key = commentKey(c, pr.repo, pr.number);
              newKeys.add(key);

              if (!prevState.current.pendingCommentKeys.has(key)) {
                hasNew = true;
                const repoShort = pr.repo.split("/")[1] ?? pr.repo;
                const actionLabel = c.evaluation.action === "fix" ? "Needs fix" :
                  c.evaluation.action === "reply" ? "Needs reply" : "Can resolve";
                notify(
                  `${actionLabel}: ${repoShort}#${pr.number}`,
                  `${c.path}:${c.line} — ${c.evaluation.summary}`,
                  () => onSelectPR(pr.number, pr.repo),
                );
              }
            }
          }
        } catch { /* ignore */ }
      }

      prevState.current.pendingCommentKeys = newKeys;
      if (hasNew) onDataChanged();
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [pulls]);
}
