import { getRawSqlite } from "../db/client.js";
import { loadConfig } from "../config.js";
import { getRepos, getTicketState } from "../server.js";
import { buildPullSidebarLists, fetchMergedAuthoredLinkablePRs } from "../api.js";
import { evaluateCoherence, type CoherenceAlert, type CoherenceInput, type CoherencePR } from "../coherence.js";
import type { TicketIssue } from "../tickets/types.js";

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

const STUCK_ALERT_TYPES = new Set([
  "stale-in-progress",
  "done-but-unmerged",
  "ci-failure",
  "approved-but-lingering",
  "ticket-inactive",
]);

function emptySnapshot(generatedAt: string): TeamOverviewSnapshot {
  return {
    generatedAt,
    summaryCounts: { stuck: 0, awaitingReview: 0, recentlyMerged: 0, unlinkedPrs: 0, unlinkedTickets: 0 },
    stuck: [],
    awaitingReview: [],
    recentlyMerged: [],
    unlinkedPrs: [],
    unlinkedTickets: [],
  };
}

function isDoneTicket(ticket: TicketIssue): boolean {
  if (ticket.isDone) return true;
  const type = ticket.state.type.toLowerCase();
  if (type === "completed" || type === "canceled") return true;
  const name = (ticket.state.name ?? "").toLowerCase();
  if (/\b(merged|done|complete|completed|closed|shipped|released|deployed)\b/.test(name)) return true;
  if (/\b(wont fix|won't fix|cancelled|canceled)\b/.test(name)) return true;
  return false;
}

function mapSidebarRowToCoherencePR(p: Record<string, unknown>): CoherencePR {
  return {
    number: p.number as number,
    repo: p.repo as string,
    title: p.title as string,
    branch: p.branch as string,
    updatedAt: p.updatedAt as string,
    checksStatus: p.checksStatus as string,
    hasHumanApproval: p.hasHumanApproval as boolean,
    merged: false,
    reviewers: [],
    pendingTriage: p.pendingTriage as number | undefined,
  };
}

/**
 * Pure snapshot assembly for tests and for {@link rebuildTeamOverviewSnapshot}.
 * Uses the same in-repo data as the CLI coherence pass (personal scope until Team Radar widens inputs).
 */
export function buildTeamOverviewSnapshotFromData(input: {
  generatedAt: string;
  now: number;
  alerts: CoherenceAlert[];
  authored: Array<Record<string, unknown>>;
  reviewRequested: Array<Record<string, unknown>>;
  myIssues: TicketIssue[];
  repoLinkedIssues: TicketIssue[];
  ticketToPRs: Record<string, Array<{ number: number; repo: string; title: string }>>;
  prToTickets: Record<string, string[]>;
  recentlyMerged: Array<{ repo: string; number: number; title: string; mergedAt: string }>;
}): TeamOverviewSnapshot {
  const stuck: TeamOverviewSnapshot["stuck"] = [];
  for (const a of input.alerts) {
    if (!STUCK_ALERT_TYPES.has(a.type)) continue;
    stuck.push({
      entityKind: a.entityKind,
      entityIdentifier: a.entityIdentifier,
      title: a.title,
    });
  }

  const awaitingReview: TeamOverviewSnapshot["awaitingReview"] = [];
  for (const row of input.reviewRequested) {
    const repo = row.repo as string;
    const number = row.number as number;
    const title = row.title as string;
    const updatedAt = row.updatedAt as string;
    const waitMs = input.now - new Date(updatedAt).getTime();
    const waitHours = Math.max(0, Math.floor(waitMs / (1000 * 60 * 60)));
    awaitingReview.push({ repo, number, title, waitHours });
  }
  awaitingReview.sort((a, b) => b.waitHours - a.waitHours);

  const unlinkedPrs: TeamOverviewSnapshot["unlinkedPrs"] = [];
  const seenPr = new Set<string>();
  for (const row of [...input.authored, ...input.reviewRequested]) {
    const repo = row.repo as string;
    const number = row.number as number;
    const key = `${repo}#${number}`;
    const tickets = input.prToTickets[key];
    if (tickets && tickets.length > 0) continue;
    if (seenPr.has(key)) continue;
    seenPr.add(key);
    unlinkedPrs.push({ repo, number, title: row.title as string });
  }

  const unlinkedTickets: TeamOverviewSnapshot["unlinkedTickets"] = [];
  const seenTicket = new Set<string>();
  for (const ticket of [...input.myIssues, ...input.repoLinkedIssues]) {
    const id = ticket.identifier;
    if (seenTicket.has(id)) continue;
    seenTicket.add(id);
    if (isDoneTicket(ticket)) continue;
    const linked = input.ticketToPRs[id] ?? [];
    const hasProviderPrs = (ticket.providerLinkedPulls?.length ?? 0) > 0;
    if (linked.length > 0 || hasProviderPrs) continue;
    unlinkedTickets.push({ identifier: id, title: ticket.title });
  }

  const recentlyMerged = [...input.recentlyMerged]
    .filter((r) => r.mergedAt)
    .sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime())
    .slice(0, 15);

  return {
    generatedAt: input.generatedAt,
    summaryCounts: {
      stuck: stuck.length,
      awaitingReview: awaitingReview.length,
      recentlyMerged: recentlyMerged.length,
      unlinkedPrs: unlinkedPrs.length,
      unlinkedTickets: unlinkedTickets.length,
    },
    stuck,
    awaitingReview,
    recentlyMerged,
    unlinkedPrs,
    unlinkedTickets,
  };
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
  const generatedAt = new Date().toISOString();
  try {
    const config = loadConfig();
    const repos = getRepos();
    const [lists, mergedLinkable] = await Promise.all([
      buildPullSidebarLists(repos),
      fetchMergedAuthoredLinkablePRs(repos),
    ]);

    if (lists.githubUserUnavailable) {
      const snap = emptySnapshot(generatedAt);
      return { snapshot: snap, error: "GitHub user unavailable" };
    }

    const tState = getTicketState();
    const toPRsRecord: Record<string, Array<{ number: number; repo: string; title: string }>> = {};
    for (const [k, v] of tState.linkMap.ticketToPRs) {
      toPRsRecord[k] = v;
    }
    const toTicketsRecord: Record<string, string[]> = {};
    for (const [k, v] of tState.linkMap.prToTickets) {
      toTicketsRecord[k] = v;
    }

    const now = Date.now();
    const coherenceInput: CoherenceInput = {
      myTickets: tState.myIssues,
      repoLinkedTickets: tState.repoLinkedIssues,
      authoredPRs: lists.authored.map(mapSidebarRowToCoherencePR),
      reviewRequestedPRs: lists.reviewRequested.map(mapSidebarRowToCoherencePR),
      ticketToPRs: toPRsRecord,
      prToTickets: toTicketsRecord,
      thresholds: {
        branchStalenessDays: config.coherence?.branchStalenessDays ?? 3,
        approvedUnmergedHours: config.coherence?.approvedUnmergedHours ?? 24,
        reviewWaitHours: config.coherence?.reviewWaitHours ?? 24,
        ticketInactivityDays: config.coherence?.ticketInactivityDays ?? 5,
      },
      now,
    };

    const alerts = evaluateCoherence(coherenceInput);
    const recentlyMerged = mergedLinkable
      .filter((p) => p.mergedAt)
      .map((p) => ({
        repo: p.repo,
        number: p.number,
        title: p.title,
        mergedAt: p.mergedAt!,
      }));

    const snapshot = buildTeamOverviewSnapshotFromData({
      generatedAt,
      now,
      alerts,
      authored: lists.authored,
      reviewRequested: lists.reviewRequested,
      myIssues: tState.myIssues,
      repoLinkedIssues: tState.repoLinkedIssues,
      ticketToPRs: toPRsRecord,
      prToTickets: toTicketsRecord,
      recentlyMerged,
    });

    return { snapshot, error: null };
  } catch (e) {
    return { snapshot: emptySnapshot(generatedAt), error: (e as Error).message };
  }
}
