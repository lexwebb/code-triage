import type { GitHubRateLimitSnapshot } from "./exec.js";

/** Matches `github-batching.ts` batch sizes for rough request estimates. */
const REPO_LIST_CHUNK = 8;
const GLOBAL_PR_CHUNK = 6;

/**
 * Conservative estimate of GitHub HTTP calls for one poll cycle (GET /user + GraphQL batches).
 * Assumes ~`assumedPrsPerRepo` in-scope PRs per repo for review-thread GraphQL (worst-case-ish).
 */
export function estimatePollRequestCount(nRepos: number, assumedPrsPerRepo = 3): number {
  if (nRepos <= 0) return 0;
  const user = 1;
  const openPullGql = Math.ceil(nRepos / REPO_LIST_CHUNK);
  const flatSlots = nRepos * assumedPrsPerRepo;
  const reviewGql = Math.ceil(flatSlots / GLOBAL_PR_CHUNK);
  return user + openPullGql + reviewGql;
}

/**
 * Stretch the poll interval so expected polling usage stays under `(1 - headroom)` of the
 * remaining GitHub quota for the current rate-limit window (from `X-RateLimit-*`).
 * Falls back to `baseIntervalMs` when limits are unknown or not limited.
 */
export function computeEffectivePollIntervalMs(
  baseIntervalMs: number,
  nRepos: number,
  rl: GitHubRateLimitSnapshot,
  now: number,
  headroom: number,
): { intervalMs: number; estimatedRequestsPerPoll: number; budgetReason: string | null } {
  const estimatedRequestsPerPoll = estimatePollRequestCount(nRepos);
  if (estimatedRequestsPerPoll <= 0 || baseIntervalMs <= 0) {
    return { intervalMs: baseIntervalMs, estimatedRequestsPerPoll, budgetReason: null };
  }
  if (rl.remaining == null || rl.limit == null || rl.remaining <= 0 || rl.limited) {
    return { intervalMs: baseIntervalMs, estimatedRequestsPerPoll, budgetReason: null };
  }

  const resetAt = rl.resetAt ?? now + 3600_000;
  const windowMs = Math.max(60_000, resetAt - now);
  const h = Math.min(0.95, Math.max(0, headroom));
  const budget = rl.remaining * (1 - h);
  const maxPollsInWindow = Math.max(1, Math.floor(budget / estimatedRequestsPerPoll));
  const intervalFromBudget = windowMs / maxPollsInWindow;
  const intervalMs = Math.max(baseIntervalMs, Math.ceil(intervalFromBudget));

  let budgetReason: string | null = null;
  if (intervalMs > baseIntervalMs + 500) {
    const perHour = Math.round((3600000 / intervalMs) * estimatedRequestsPerPoll);
    budgetReason = `~${estimatedRequestsPerPoll} req/poll (~${perHour}/h), ${rl.remaining}/${rl.limit} left in window, ${Math.round(h * 100)}% reserved for UI`;
  }
  return { intervalMs, estimatedRequestsPerPoll, budgetReason };
}
