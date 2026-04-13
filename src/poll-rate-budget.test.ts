import { describe, expect, it } from "vitest";
import { computeEffectivePollIntervalMs, estimatePollRequestCount } from "./poll-rate-budget.js";
import type { GitHubRateLimitSnapshot } from "./exec.js";

describe("estimatePollRequestCount", () => {
  it("counts user + open-PR batches + review batches", () => {
    expect(estimatePollRequestCount(0)).toBe(0);
    // 1 user + ceil(8/8)=1 open + ceil(24/6)=4 review = 6
    expect(estimatePollRequestCount(8, 3)).toBe(1 + 1 + 4);
  });
});

describe("computeEffectivePollIntervalMs", () => {
  const base = 60_000;
  const now = 1_000_000_000_000;

  it("returns base when rate limit unknown", () => {
    const rl: GitHubRateLimitSnapshot = {
      limited: false,
      resetAt: null,
      remaining: null,
      limit: null,
      resource: null,
      updatedAt: 0,
    };
    const r = computeEffectivePollIntervalMs(base, 10, rl, now, 0.35);
    expect(r.intervalMs).toBe(base);
    expect(r.budgetReason).toBeNull();
  });

  it("stretches interval when quota tight for many repos", () => {
    const rl: GitHubRateLimitSnapshot = {
      limited: false,
      resetAt: now + 3600_000,
      remaining: 100,
      limit: 5000,
      resource: "core",
      updatedAt: now,
    };
    const cost = estimatePollRequestCount(40);
    const r = computeEffectivePollIntervalMs(base, 40, rl, now, 0.35);
    expect(r.estimatedRequestsPerPoll).toBe(cost);
    expect(r.intervalMs).toBeGreaterThan(base);
    expect(r.budgetReason).not.toBeNull();
  });
});
