import type { AppStore } from "./types";

export function selectFilteredAuthored(s: AppStore) {
  if (!s.repoFilter) return s.authored;
  const lower = s.repoFilter.toLowerCase();
  return s.authored.filter(
    (pr) => pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower),
  );
}

export function selectFilteredReviewRequested(s: AppStore) {
  const base = s.repoFilter
    ? s.reviewRequested.filter((pr) => {
        const lower = s.repoFilter.toLowerCase();
        return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
      })
    : s.reviewRequested;
  return base.filter((pr) => !s.mutedPRs.has(`${pr.repo}:${pr.number}`));
}

export function selectMutedReviewPulls(s: AppStore) {
  const base = s.repoFilter
    ? s.reviewRequested.filter((pr) => {
        const lower = s.repoFilter.toLowerCase();
        return pr.repo.toLowerCase().includes(lower) || pr.title.toLowerCase().includes(lower);
      })
    : s.reviewRequested;
  return base.filter((pr) => s.mutedPRs.has(`${pr.repo}:${pr.number}`));
}

export function selectFlatPulls(s: AppStore) {
  return [...selectFilteredAuthored(s), ...selectFilteredReviewRequested(s)];
}

export function selectTimerText(s: AppStore) {
  const minutes = Math.floor(s.countdown / 60000);
  const seconds = Math.floor((s.countdown % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function selectShowNotifBanner(s: AppStore) {
  return s.permission === "default" || (s.permission === "granted" && !s.pushSubscribed);
}

export function formatDurationUntil(targetMs: number, nowMs: number): string {
  const ms = Math.max(0, targetMs - nowMs);
  if (ms <= 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
