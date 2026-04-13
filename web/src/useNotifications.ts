import { useEffect, useRef } from "react";
import { api } from "./api";
import type { PullRequest, ReviewComment } from "./types";

const POLL_INTERVAL = 60_000; // 1 minute

function requestPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
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
) {
  const prevState = useRef<NotificationState | null>(null);

  // Request permission on mount
  useEffect(() => {
    requestPermission();
  }, []);

  // Poll for changes
  useEffect(() => {
    // Initialize previous state on first render (don't notify for existing items)
    if (!prevState.current) {
      prevState.current = {
        reviewPRKeys: new Set(reviewPulls.map(prKey)),
        pendingCommentKeys: new Set(),
      };
      // Build initial pending comment keys
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
        prevState.current!.pendingCommentKeys = keys;
      })();
      return;
    }

    // Check for new review PRs
    const currentReviewKeys = new Set(reviewPulls.map(prKey));
    for (const pr of reviewPulls) {
      const key = prKey(pr);
      if (!prevState.current.reviewPRKeys.has(key)) {
        const repoShort = pr.repo.split("/")[1] ?? pr.repo;
        notify(
          `Review requested: ${repoShort}#${pr.number}`,
          pr.title,
          () => onSelectPR(pr.number, pr.repo),
        );
      }
    }
    prevState.current.reviewPRKeys = currentReviewKeys;
  }, [reviewPulls]);

  // Poll for new pending comments on user's PRs
  useEffect(() => {
    if (pulls.length === 0) return;

    const interval = setInterval(async () => {
      if (!prevState.current) return;

      const newKeys = new Set<string>();
      for (const pr of pulls) {
        try {
          const comments = await api.getPullComments(pr.number, pr.repo);
          for (const c of comments) {
            if (c.crStatus === "pending" && c.evaluation) {
              const key = commentKey(c, pr.repo, pr.number);
              newKeys.add(key);

              if (!prevState.current.pendingCommentKeys.has(key)) {
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
    }, POLL_INTERVAL);

    return () => clearInterval(interval);
  }, [pulls]);
}
