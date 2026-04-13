import { getRawSqlite, openStateDatabase } from "./db/client.js";

export interface RepoPollScheduleOptions {
  /** After this many days without activity, treat repo as “cold”. Set ≤0 to poll all repos every cycle. */
  staleAfterDays: number;
  /** Minimum spacing between polls for a cold repo (minutes). */
  coldIntervalMinutes: number;
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

  openStateDatabase();
  const sqlite = getRawSqlite();
  const staleMs = opts.staleAfterDays * 86_400_000;
  const coldMs = opts.coldIntervalMinutes * 60_000;
  const stmt = sqlite.prepare("SELECT last_activity_ms, last_poll_ms FROM repo_poll WHERE repo = ?");
  const out: string[] = [];

  for (const repo of repoPaths) {
    const row = stmt.get(repo) as { last_activity_ms: number; last_poll_ms: number } | undefined;
    if (!row) {
      out.push(repo);
      continue;
    }
    const hot = now - row.last_activity_ms < staleMs;
    if (hot) {
      out.push(repo);
    } else if (now - row.last_poll_ms >= coldMs) {
      out.push(repo);
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
  openStateDatabase();
  const sqlite = getRawSqlite();
  const selectPrev = sqlite.prepare("SELECT last_activity_ms FROM repo_poll WHERE repo = ?");
  const upsert = sqlite.prepare(`
    INSERT INTO repo_poll (repo, last_activity_ms, last_poll_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      last_activity_ms = excluded.last_activity_ms,
      last_poll_ms = excluded.last_poll_ms
  `);

  for (const { repo, hadActivity } of entries) {
    const prev = selectPrev.get(repo) as { last_activity_ms: number } | undefined;
    let lastActivityMs: number;
    if (hadActivity) {
      lastActivityMs = now;
    } else if (prev) {
      lastActivityMs = prev.last_activity_ms;
    } else {
      /* First row: no triage activity yet — not “hot” (avoids 7d false warmth from `lastActivityMs = now`). */
      lastActivityMs = 0;
    }
    upsert.run(repo, lastActivityMs, now);
  }
}

/** Clears adaptive poll timing so the next CLI poll cycle recomputes hot/cold from scratch. */
export function clearRepoPollSchedule(): void {
  openStateDatabase();
  getRawSqlite().prepare("DELETE FROM repo_poll").run();
}

/** Vitest / isolated runs. */
export function resetRepoPollTableForTests(): void {
  clearRepoPollSchedule();
}
