import { eq } from "drizzle-orm";
import * as schema from "./db/schema.js";
import { openStateDatabase } from "./db/client.js";

export interface RepoPollScheduleOptions {
  /** After this many days without activity, treat repo as “cold”. Set ≤0 to poll all repos every cycle. */
  staleAfterDays: number;
  /** Minimum spacing between polls for a cold repo (minutes). */
  coldIntervalMinutes: number;
  /** Extra spacing multiplier when repo has never had recorded activity (`last_activity_ms = 0`). */
  superColdMultiplier?: number;
}

/**
 * Repos with recent activity (new comments or in-scope PRs) are polled every main interval.
 * Repos with no activity for `staleAfterDays` are polled at most every `coldIntervalMinutes`.
 */
export function selectReposToPoll(repoPaths: string[], now: number, opts: RepoPollScheduleOptions): string[] {
  if (opts.staleAfterDays <= 0 || opts.coldIntervalMinutes <= 0) {
    return [...repoPaths];
  }
  if (repoPaths.length === 0) return [];

  const database = openStateDatabase();
  const staleMs = opts.staleAfterDays * 86_400_000;
  const coldMs = opts.coldIntervalMinutes * 60_000;
  const superCold = Math.max(1, Math.floor(opts.superColdMultiplier ?? 1));
  const out: string[] = [];

  for (const repo of repoPaths) {
    const row = database
      .select({
        lastActivityMs: schema.repoPoll.lastActivityMs,
        lastPollMs: schema.repoPoll.lastPollMs,
      })
      .from(schema.repoPoll)
      .where(eq(schema.repoPoll.repo, repo))
      .get();
    if (!row) {
      out.push(repo);
      continue;
    }
    const hot = now - row.lastActivityMs < staleMs;
    if (hot) {
      out.push(repo);
    } else {
      const spacingMs = row.lastActivityMs <= 0 ? coldMs * superCold : coldMs;
      if (now - row.lastPollMs >= spacingMs) {
        out.push(repo);
      }
    }
  }
  return out;
}

/**
 * `hadActivity` = new triage comments this poll (inline review comments worth Claude triage).
 * Open PRs alone do not count — otherwise any lingering PR keeps the repo “hot” forever.
 */
export function recordPollOutcomes(entries: Array<{ repo: string; hadActivity: boolean }>, now: number): void {
  if (entries.length === 0) return;
  const database = openStateDatabase();

  for (const { repo, hadActivity } of entries) {
    const prev = database
      .select({ lastActivityMs: schema.repoPoll.lastActivityMs })
      .from(schema.repoPoll)
      .where(eq(schema.repoPoll.repo, repo))
      .get();

    let lastActivityMs: number;
    if (hadActivity) {
      lastActivityMs = now;
    } else if (prev) {
      lastActivityMs = prev.lastActivityMs;
    } else {
      /* First row: no triage activity yet — not “hot” (avoids 7d false warmth from `lastActivityMs = now`). */
      lastActivityMs = 0;
    }

    database
      .insert(schema.repoPoll)
      .values({ repo, lastActivityMs, lastPollMs: now })
      .onConflictDoUpdate({
        target: schema.repoPoll.repo,
        set: { lastActivityMs, lastPollMs: now },
      })
      .run();
  }
}

/** Clears adaptive poll timing so the next CLI poll cycle recomputes hot/cold from scratch. */
export function clearRepoPollSchedule(): void {
  openStateDatabase().delete(schema.repoPoll).run();
}

/** Vitest / isolated runs. */
export function resetRepoPollTableForTests(): void {
  clearRepoPollSchedule();
}
