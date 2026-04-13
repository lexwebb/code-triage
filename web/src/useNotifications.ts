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
  initialized: boolean;
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
  });

  // Request permission on mount
  useEffect(() => {
    requestPermission();
  }, []);

  // Track review PRs — detect new ones
  useEffect(() => {
    const currentKeys = new Set(reviewPulls.map(prKey));

    if (!prevState.current.initialized) {
      prevState.current.reviewPRKeys = currentKeys;
      return;
    }

    let hasNew = false;
    for (const pr of reviewPulls) {
      const key = prKey(pr);
      if (!prevState.current.reviewPRKeys.has(key)) {
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
