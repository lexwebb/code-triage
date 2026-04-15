import { getRawSqlite } from "../db/client.js";

export interface TeamOverviewSnapshot {
  generatedAt: string;
  summaryCounts: {
    stuck: number;
    awaitingReview: number;
    recentlyMerged: number;
    unlinkedPrs: number;
    unlinkedTickets: number;
  };
  stuck: Array<{ entityKind: "pr" | "ticket"; entityIdentifier: string; title: string }>;
  awaitingReview: Array<{ repo: string; number: number; title: string; waitHours: number }>;
  recentlyMerged: Array<{ repo: string; number: number; title: string; mergedAt: string }>;
  unlinkedPrs: Array<{ repo: string; number: number; title: string }>;
  unlinkedTickets: Array<{ identifier: string; title: string }>;
}

export function readTeamOverviewCache():
  | { snapshot: TeamOverviewSnapshot; updatedAtMs: number; refreshError: string | null }
  | null {
  const db = getRawSqlite();
  const row = db.prepare(
    "SELECT payload_json, updated_at_ms, refresh_error FROM team_overview_cache WHERE id = 1",
  ).get() as { payload_json: string; updated_at_ms: number; refresh_error: string | null } | undefined;
  if (!row) return null;
  return {
    snapshot: JSON.parse(row.payload_json) as TeamOverviewSnapshot,
    updatedAtMs: row.updated_at_ms,
    refreshError: row.refresh_error,
  };
}

export function writeTeamOverviewCache(snapshot: TeamOverviewSnapshot, errorMessage: string | null): void {
  const db = getRawSqlite();
  const now = Date.now();
  db.prepare(
    `INSERT INTO team_overview_cache (id, payload_json, updated_at_ms, refresh_error)
     VALUES (1, @payload_json, @updated_at_ms, @refresh_error)
     ON CONFLICT(id) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at_ms = excluded.updated_at_ms,
       refresh_error = excluded.refresh_error`,
  ).run({
    payload_json: JSON.stringify(snapshot),
    updated_at_ms: now,
    refresh_error: errorMessage,
  });
}

export async function rebuildTeamOverviewSnapshot(): Promise<{ snapshot: TeamOverviewSnapshot; error: string | null }> {
  const snapshot: TeamOverviewSnapshot = {
    generatedAt: new Date().toISOString(),
    summaryCounts: { stuck: 0, awaitingReview: 0, recentlyMerged: 0, unlinkedPrs: 0, unlinkedTickets: 0 },
    stuck: [],
    awaitingReview: [],
    recentlyMerged: [],
    unlinkedPrs: [],
    unlinkedTickets: [],
  };
  return { snapshot, error: null };
}
