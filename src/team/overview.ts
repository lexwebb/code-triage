import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { openStateDatabase } from "../db/client.js";
import { log } from "../logger.js";
import { isTeamFeaturesEnabled, loadConfig } from "../config.js";
import { getRepos, getTicketState } from "../server.js";
import { getGitHubViewerCached } from "../exec.js";
import { discoverTrackedOrgMemberLogins } from "../github-org-team-scope.js";
import { buildPullSidebarLists, fetchMergedAuthoredLinkablePRs } from "../api.js";
import { dedupeIssuesByIdentifier } from "../tickets/linear.js";
import {
  filterPrToTicketsRecordForMutedRepos,
  filterPullRowsByMutedRepos,
  filterSidebarRecordsByMutedRepos,
  filterTicketToPRsRecordForMutedRepos,
  mutedReposAsSet,
} from "../muted-repos.js";
import { evaluateCoherence, type CoherenceAlert, type CoherenceInput, type CoherencePR } from "../coherence.js";
import type { TicketIssue } from "../tickets/types.js";
import {
  deriveTicketIssueLifecycleStage,
  mergedPullLifecycleStage,
  resolveAttentionLifecycleStage,
  type LifecycleStage,
  type OpenPullLike,
} from "../lifecycle-stage.js";
import {
  createTeamMemberIdentityResolver,
  normalizeTeamIdentityKey,
  regenerateMemberLinks,
  type LinearUserRef,
  type TeamMemberLink,
} from "./member-identity.js";

/** GitHub login or Linear person contributing to a member rollup (for linking UI). */
export type TeamMemberSummaryIdentityHint =
  | { kind: "github"; login: string }
  | { kind: "linear"; userId?: string; name: string };

/** One PR or ticket line in the per-teammate accordion (same core fields as radar rows). */
export type TeamMemberSummaryItem = {
  title: string;
  entityKind: "pr" | "ticket";
  entityIdentifier: string;
  lifecycleStage?: LifecycleStage;
  lifecycleStuck?: boolean;
  providerUrl?: string;
  waitLabel?: string;
  /**
   * ISO timestamp for AI digest freshness: PR `updated_at` / `created_at`, ticket `updatedAt`, or merge time.
   * Used to exclude work older than 30 days from Claude summaries (see `member-summary-ai`).
   */
  activityAt?: string;
};

export interface TeamOverviewSnapshot {
  generatedAt: string;
  summaryCounts: {
    stuck: number;
    awaitingReview: number;
    recentlyMerged: number;
    unlinkedPrs: number;
    unlinkedTickets: number;
  };
  stuck: Array<{
    entityKind: "pr" | "ticket";
    entityIdentifier: string;
    title: string;
    lifecycleStage?: LifecycleStage;
    /** When true, lifecycle bar uses amber for the current stage (attention parity for stuck work). */
    lifecycleStuck?: boolean;
    /** PR author login or ticket assignee display name. */
    actorLabel?: string;
    /** Ticket provider URL when known (e.g. Linear); omitted for PR rows. */
    providerUrl?: string;
  }>;
  awaitingReview: Array<{
    repo: string;
    number: number;
    title: string;
    waitHours: number;
    lifecycleStage?: LifecycleStage;
    lifecycleStuck?: boolean;
    actorLabel?: string;
  }>;
  recentlyMerged: Array<{
    repo: string;
    number: number;
    title: string;
    mergedAt: string;
    lifecycleStage?: LifecycleStage;
    lifecycleStuck?: boolean;
    actorLabel?: string;
  }>;
  unlinkedPrs: Array<{
    repo: string;
    number: number;
    title: string;
    lifecycleStage?: LifecycleStage;
    lifecycleStuck?: boolean;
    actorLabel?: string;
  }>;
  unlinkedTickets: Array<{
    identifier: string;
    title: string;
    lifecycleStage?: LifecycleStage;
    lifecycleStuck?: boolean;
    actorLabel?: string;
    /** e.g. Linear issue URL from the API */
    providerUrl?: string;
  }>;
  /** Per-person rollups derived from snapshot inputs (GitHub login for PR authors, ticket assignee display names). */
  memberSummaries: Array<{
    memberLabel: string;
    /** Raw identities seen for this label; used to suggest manual GitHub ↔ Linear links. */
    identityHints?: TeamMemberSummaryIdentityHint[];
    workingOn: TeamMemberSummaryItem[];
    waiting: TeamMemberSummaryItem[];
    comingUp: TeamMemberSummaryItem[];
    /**
     * Claude-generated bullet summary from this snapshot's PRs/tickets for this teammate.
     * Regenerated only when `workFingerprint` differs from the last cached run for this teammate.
     */
    aiDigest?: {
      bullets: string[];
      workFingerprint: string;
      generatedAt: string;
    };
  }>;
  /**
   * Fingerprint of the entire team's work-item sets (PRs + tickets per member).
   * When this changes vs the previous snapshot, at least one teammate's digest inputs changed.
   */
  teamMemberAiDigestInputFingerprint?: string;
  /** Fingerprint of manual links + unrecognised GitHub logins + uncovered assignees when Claude linking last ran. */
  memberLinkClaudeFingerprint?: string;
  /** Last Claude-suggested identity links (merged after manual config `team.memberLinks`). */
  claudeMemberLinkSuggestions?: TeamMemberLink[];
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
    memberSummaries: [],
  };
}

const MEMBER_SUMMARY_CAP = 6;

function ticketAssigneeLabel(ticket: TicketIssue): string {
  const n = ticket.assignee?.name?.trim();
  return n || "Unassigned";
}

function ticketIsInProgress(ticket: TicketIssue): boolean {
  return ticket.state.type.toLowerCase() === "started";
}

function ticketIsUpcoming(ticket: TicketIssue): boolean {
  const ty = ticket.state.type.toLowerCase();
  return ty === "unstarted" || ty === "backlog";
}

type MemberSummaryWaitingInternal = TeamMemberSummaryItem & { sortKey: number };

type MemberBuckets = {
  workingOn: TeamMemberSummaryItem[];
  waiting: MemberSummaryWaitingInternal[];
  comingUp: TeamMemberSummaryItem[];
};

function identityHintKey(h: TeamMemberSummaryIdentityHint): string {
  if (h.kind === "github") return `g:${normalizeTeamIdentityKey(h.login)}`;
  return `l:${h.userId ?? ""}:${normalizeTeamIdentityKey(h.name)}`;
}

function buildMemberSummariesFromData(input: {
  authored: Array<Record<string, unknown>>;
  reviewRequested: Array<Record<string, unknown>>;
  generatedAt: string;
  myIssues: TicketIssue[];
  repoLinkedIssues: TicketIssue[];
  recentlyMerged: Array<{ repo: string; number: number; title: string; mergedAt: string; authorLogin?: string }>;
  stuck: TeamOverviewSnapshot["stuck"];
  awaitingReview: TeamOverviewSnapshot["awaitingReview"];
  unlinkedPrs: TeamOverviewSnapshot["unlinkedPrs"];
  unlinkedTickets: TeamOverviewSnapshot["unlinkedTickets"];
  resolveMember: (raw: string, opts?: { linearUserId?: string | null }) => string;
  lifecycleCtx: {
    prToTickets: Record<string, string[]>;
    openPulls: OpenPullLike[];
    myTickets: TicketIssue[];
    repoLinkedTickets: TicketIssue[];
  };
}): TeamOverviewSnapshot["memberSummaries"] {
  const { resolveMember, lifecycleCtx } = input;
  const fallbackActivity = input.generatedAt;
  const ticketByIdentifier = new Map<string, TicketIssue>();
  for (const t of [...input.myIssues, ...input.repoLinkedIssues]) {
    ticketByIdentifier.set(t.identifier, t);
  }

  const buckets = new Map<string, MemberBuckets>();
  const hintByLabel = new Map<string, Map<string, TeamMemberSummaryIdentityHint>>();

  const ensure = (label: string): MemberBuckets => {
    let b = buckets.get(label);
    if (!b) {
      b = { workingOn: [], waiting: [], comingUp: [] };
      buckets.set(label, b);
    }
    return b;
  };

  const addHints = (label: string, hints: TeamMemberSummaryIdentityHint[]) => {
    let m = hintByLabel.get(label);
    if (!m) {
      m = new Map();
      hintByLabel.set(label, m);
    }
    for (const h of hints) {
      m.set(identityHintKey(h), h);
    }
  };

  const pushCap = <T>(arr: T[], item: T, cap: number) => {
    if (arr.length < cap) arr.push(item);
  };

  const stuckPrKeys = new Set(
    input.stuck.filter((s) => s.entityKind === "pr").map((s) => s.entityIdentifier),
  );
  const stuckTicketIds = new Set(
    input.stuck.filter((s) => s.entityKind === "ticket").map((s) => s.entityIdentifier),
  );

  for (const row of input.authored) {
    const repo = row.repo as string;
    const number = row.number as number;
    const key = prEntityKey(repo, number);
    if (stuckPrKeys.has(key)) continue;
    const ghLogin = sidebarAuthorLogin(row);
    const label = resolveMember(ghLogin ?? "Unknown");
    if (ghLogin && ghLogin !== "Unknown") {
      addHints(label, [{ kind: "github", login: ghLogin }]);
    }
    pushCap(ensure(label).workingOn, {
      title: row.title as string,
      entityKind: "pr",
      entityIdentifier: key,
      lifecycleStage: resolveAttentionLifecycleStage({ entityKind: "pr", entityIdentifier: key }, lifecycleCtx),
      lifecycleStuck: false,
      activityAt: coalesceActivityIso(fallbackActivity, activityIsoFromSidebarRow(row)),
    }, MEMBER_SUMMARY_CAP);
  }

  const seenTicket = new Set<string>();
  for (const ticket of [...input.myIssues, ...input.repoLinkedIssues]) {
    const id = ticket.identifier;
    if (seenTicket.has(id)) continue;
    seenTicket.add(id);
    if (isDoneTicket(ticket)) continue;
    const label = resolveMember(ticketAssigneeLabel(ticket), { linearUserId: ticket.assignee?.id });
    const b = ensure(label);
    if (ticket.assignee && (ticket.assignee.name?.trim() || ticket.assignee.id)) {
      addHints(label, [{
        kind: "linear",
        userId: ticket.assignee.id,
        name: ticket.assignee.name?.trim() || "Unknown",
      }]);
    }
    if (stuckTicketIds.has(id)) continue;
    if (ticketIsInProgress(ticket)) {
      pushCap(b.workingOn, {
        title: ticket.title,
        entityKind: "ticket",
        entityIdentifier: id,
        lifecycleStage: deriveTicketIssueLifecycleStage(ticket, lifecycleCtx.prToTickets, lifecycleCtx.openPulls),
        lifecycleStuck: false,
        providerUrl: ticket.providerUrl,
        activityAt: coalesceActivityIso(fallbackActivity, ticket.updatedAt),
      }, MEMBER_SUMMARY_CAP);
    } else if (ticketIsUpcoming(ticket)) {
      pushCap(b.comingUp, {
        title: ticket.title,
        entityKind: "ticket",
        entityIdentifier: id,
        lifecycleStage: deriveTicketIssueLifecycleStage(ticket, lifecycleCtx.prToTickets, lifecycleCtx.openPulls),
        lifecycleStuck: false,
        providerUrl: ticket.providerUrl,
        activityAt: coalesceActivityIso(fallbackActivity, ticket.updatedAt),
      }, MEMBER_SUMMARY_CAP);
    }
  }

  for (const pr of input.recentlyMerged) {
    const raw = pr.authorLogin?.trim() || "Unknown";
    if (!raw || raw === "Unknown") continue;
    const label = resolveMember(raw);
    addHints(label, [{ kind: "github", login: raw }]);
    const ref = prEntityKey(pr.repo, pr.number);
    pushCap(ensure(label).workingOn, {
      title: pr.title,
      entityKind: "pr",
      entityIdentifier: ref,
      lifecycleStage: mergedPullLifecycleStage(),
      lifecycleStuck: false,
      waitLabel: "Merged",
      activityAt: coalesceActivityIso(fallbackActivity, pr.mergedAt),
    }, MEMBER_SUMMARY_CAP);
  }

  for (const s of input.stuck) {
    const raw = s.actorLabel?.trim() || "Unknown";
    const ticket =
      s.entityKind === "ticket" ? ticketByIdentifier.get(s.entityIdentifier) : undefined;
    const linearUserId = ticket?.assignee?.id;
    const label = resolveMember(raw, { linearUserId });
    if (s.entityKind === "pr" && raw !== "Unknown") {
      addHints(label, [{ kind: "github", login: raw }]);
    }
    if (s.entityKind === "ticket" && ticket?.assignee && (ticket.assignee.name?.trim() || ticket.assignee.id)) {
      addHints(label, [{
        kind: "linear",
        userId: ticket.assignee.id,
        name: ticket.assignee.name?.trim() || "Unknown",
      }]);
    }
    const b = ensure(label);
    const stuckActivity =
      s.entityKind === "pr"
        ? coalesceActivityIso(
            fallbackActivity,
            activityIsoFromSidebarRow(
              findSidebarRowForPrKey(input.authored, input.reviewRequested, s.entityIdentifier),
            ),
          )
        : coalesceActivityIso(fallbackActivity, ticket?.updatedAt);
    pushCap(b.waiting, {
      title: s.title,
      entityKind: s.entityKind,
      entityIdentifier: s.entityIdentifier,
      lifecycleStage: s.lifecycleStage,
      lifecycleStuck: s.lifecycleStuck,
      providerUrl: s.entityKind === "ticket" ? ticket?.providerUrl : undefined,
      waitLabel: "Stuck",
      sortKey: 1e9,
      activityAt: stuckActivity,
    }, MEMBER_SUMMARY_CAP);
  }

  for (const pr of input.awaitingReview) {
    const gh = pr.actorLabel?.trim() || "Unknown";
    const label = resolveMember(gh);
    if (gh !== "Unknown") {
      addHints(label, [{ kind: "github", login: gh }]);
    }
    const ref = prEntityKey(pr.repo, pr.number);
    const waitHours = pr.waitHours;
    const waitLabel =
      waitHours >= 72
        ? `${Math.round(waitHours / 24)}d waiting`
        : waitHours >= 1
          ? `${Math.round(waitHours)}h waiting`
          : "<1h waiting";
    const prRow = findSidebarRowForPrKey(input.authored, input.reviewRequested, ref);
    pushCap(
      ensure(label).waiting,
      {
        title: pr.title,
        entityKind: "pr",
        entityIdentifier: ref,
        lifecycleStage: pr.lifecycleStage,
        lifecycleStuck: pr.lifecycleStuck,
        waitLabel,
        sortKey: waitHours,
        activityAt: coalesceActivityIso(fallbackActivity, activityIsoFromSidebarRow(prRow)),
      },
      MEMBER_SUMMARY_CAP,
    );
  }

  for (const pr of input.unlinkedPrs) {
    const gh = pr.actorLabel?.trim() || "Unknown";
    const label = resolveMember(gh);
    if (gh !== "Unknown") {
      addHints(label, [{ kind: "github", login: gh }]);
    }
    const uKey = prEntityKey(pr.repo, pr.number);
    const uRow = findSidebarRowForPrKey(input.authored, input.reviewRequested, uKey);
    pushCap(
      ensure(label).waiting,
      {
        title: pr.title,
        entityKind: "pr",
        entityIdentifier: uKey,
        lifecycleStage: pr.lifecycleStage,
        lifecycleStuck: pr.lifecycleStuck,
        waitLabel: "Unlinked PR",
        sortKey: -1,
        activityAt: coalesceActivityIso(fallbackActivity, activityIsoFromSidebarRow(uRow)),
      },
      MEMBER_SUMMARY_CAP,
    );
  }

  for (const t of input.unlinkedTickets) {
    const linearUserId = ticketByIdentifier.get(t.identifier)?.assignee?.id;
    const label = resolveMember(t.actorLabel?.trim() || "Unassigned", { linearUserId });
    const fullTicket = ticketByIdentifier.get(t.identifier);
    if (fullTicket?.assignee && (fullTicket.assignee.name?.trim() || fullTicket.assignee.id)) {
      addHints(label, [{
        kind: "linear",
        userId: fullTicket.assignee.id,
        name: fullTicket.assignee.name?.trim() || "Unknown",
      }]);
    }
    pushCap(
      ensure(label).waiting,
      {
        title: t.title,
        entityKind: "ticket",
        entityIdentifier: t.identifier,
        lifecycleStage: t.lifecycleStage,
        lifecycleStuck: t.lifecycleStuck,
        providerUrl: t.providerUrl,
        waitLabel: "Unlinked ticket",
        sortKey: -2,
        activityAt: coalesceActivityIso(fallbackActivity, fullTicket?.updatedAt),
      },
      MEMBER_SUMMARY_CAP,
    );
  }

  const out: TeamOverviewSnapshot["memberSummaries"] = [];
  for (const [memberLabel, b] of buckets) {
    if (
      b.workingOn.length === 0 &&
      b.waiting.length === 0 &&
      b.comingUp.length === 0
    ) {
      continue;
    }
    b.waiting.sort((x, y) => y.sortKey - x.sortKey);
    const hintsMap = hintByLabel.get(memberLabel);
    const identityHints = hintsMap ? [...hintsMap.values()] : undefined;
    out.push({
      memberLabel,
      ...(identityHints?.length ? { identityHints } : {}),
      workingOn: b.workingOn,
      waiting: b.waiting.map(({ sortKey: _s, ...rest }) => rest),
      comingUp: b.comingUp,
    });
  }
  out.sort((a, b) => a.memberLabel.localeCompare(b.memberLabel));
  return out;
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

function prEntityKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function parsePrEntityKey(key: string): { repo: string; number: number } | null {
  const i = key.lastIndexOf("#");
  if (i <= 0) return null;
  const repo = key.slice(0, i);
  const num = parseInt(key.slice(i + 1), 10);
  if (!Number.isFinite(num)) return null;
  return { repo, number: num };
}

function findSidebarRowForPrKey(
  authored: Array<Record<string, unknown>>,
  reviewRequested: Array<Record<string, unknown>>,
  entityIdentifier: string,
): Record<string, unknown> | undefined {
  const parsed = parsePrEntityKey(entityIdentifier);
  if (!parsed) return undefined;
  for (const row of [...authored, ...reviewRequested]) {
    if (row.repo === parsed.repo && row.number === parsed.number) return row;
  }
  return undefined;
}

function sidebarAuthorLogin(row: Record<string, unknown> | undefined): string | undefined {
  const a = row?.author;
  return typeof a === "string" && a.trim() ? a.trim() : undefined;
}

function coalesceActivityIso(fallback: string, ...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    const s = c?.trim();
    if (s && Number.isFinite(Date.parse(s))) return s;
  }
  return fallback;
}

function activityIsoFromSidebarRow(row: Record<string, unknown> | undefined): string | undefined {
  if (!row) return undefined;
  const u = row.updatedAt;
  const c = row.createdAt;
  const uStr = typeof u === "string" ? u : undefined;
  const cStr = typeof c === "string" ? c : undefined;
  if (uStr?.trim() && Number.isFinite(Date.parse(uStr))) return uStr;
  if (cStr?.trim() && Number.isFinite(Date.parse(cStr))) return cStr;
  return undefined;
}

function buildOpenPulls(
  authored: Array<Record<string, unknown>>,
  reviewRequested: Array<Record<string, unknown>>,
): OpenPullLike[] {
  const seen = new Set<string>();
  const out: OpenPullLike[] = [];
  for (const row of [...authored, ...reviewRequested]) {
    const repo = row.repo as string;
    const number = row.number as number;
    const k = prEntityKey(repo, number);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      repo,
      number,
      hasHumanApproval: Boolean(row.hasHumanApproval),
    });
  }
  return out;
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
 * Uses the same inputs as the team snapshot rebuild (including optional org-wide PRs and Linear team scope when configured).
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
  recentlyMerged: Array<{ repo: string; number: number; title: string; mergedAt: string; authorLogin?: string }>;
  teamMemberLinks?: TeamMemberLink[];
  linearUsers?: LinearUserRef[];
}): TeamOverviewSnapshot {
  const openPulls = buildOpenPulls(input.authored, input.reviewRequested);
  const lifecycleCtx = {
    prToTickets: input.prToTickets,
    openPulls,
    myTickets: input.myIssues,
    repoLinkedTickets: input.repoLinkedIssues,
  };

  const stuck: TeamOverviewSnapshot["stuck"] = [];
  for (const a of input.alerts) {
    if (!STUCK_ALERT_TYPES.has(a.type)) continue;
    const lifecycleStage = resolveAttentionLifecycleStage(
      { entityKind: a.entityKind, entityIdentifier: a.entityIdentifier, stage: a.stage },
      lifecycleCtx,
    );
    let actorLabel: string | undefined;
    let providerUrl: string | undefined;
    if (a.entityKind === "pr") {
      actorLabel = sidebarAuthorLogin(findSidebarRowForPrKey(input.authored, input.reviewRequested, a.entityIdentifier));
    } else {
      const ticket = [...input.myIssues, ...input.repoLinkedIssues].find((t) => t.identifier === a.entityIdentifier);
      actorLabel = ticket ? (ticket.assignee?.name?.trim() || "Unassigned") : undefined;
      providerUrl = ticket?.providerUrl;
    }
    stuck.push({
      entityKind: a.entityKind,
      entityIdentifier: a.entityIdentifier,
      title: a.title,
      lifecycleStage,
      lifecycleStuck: true,
      actorLabel,
      ...(providerUrl ? { providerUrl } : {}),
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
    const key = prEntityKey(repo, number);
    const lifecycleStage = resolveAttentionLifecycleStage({ entityKind: "pr", entityIdentifier: key }, lifecycleCtx);
    awaitingReview.push({
      repo,
      number,
      title,
      waitHours,
      lifecycleStage,
      lifecycleStuck: false,
      actorLabel: sidebarAuthorLogin(row),
    });
  }
  awaitingReview.sort((a, b) => b.waitHours - a.waitHours);

  const unlinkedPrs: TeamOverviewSnapshot["unlinkedPrs"] = [];
  const seenPr = new Set<string>();
  for (const row of [...input.authored, ...input.reviewRequested]) {
    const repo = row.repo as string;
    const number = row.number as number;
    const key = prEntityKey(repo, number);
    const tickets = input.prToTickets[key];
    if (tickets && tickets.length > 0) continue;
    if (seenPr.has(key)) continue;
    seenPr.add(key);
    const lifecycleStage = resolveAttentionLifecycleStage({ entityKind: "pr", entityIdentifier: key }, lifecycleCtx);
    unlinkedPrs.push({
      repo,
      number,
      title: row.title as string,
      lifecycleStage,
      lifecycleStuck: false,
      actorLabel: sidebarAuthorLogin(row),
    });
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
    const lifecycleStage = deriveTicketIssueLifecycleStage(ticket, input.prToTickets, openPulls);
    unlinkedTickets.push({
      identifier: id,
      title: ticket.title,
      lifecycleStage,
      lifecycleStuck: false,
      actorLabel: ticket.assignee?.name?.trim() || "Unassigned",
      ...(ticket.providerUrl ? { providerUrl: ticket.providerUrl } : {}),
    });
  }

  const recentlyMerged = [...input.recentlyMerged]
    .filter((r) => r.mergedAt)
    .sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime())
    .slice(0, 15)
    .map(({ authorLogin, ...r }) => ({
      ...r,
      lifecycleStage: mergedPullLifecycleStage(),
      lifecycleStuck: false,
      actorLabel: authorLogin,
    }));

  const teamMemberLinksForResolve =
    input.teamMemberLinks?.length ? regenerateMemberLinks(input.teamMemberLinks) : input.teamMemberLinks;
  const { resolve } = createTeamMemberIdentityResolver(teamMemberLinksForResolve, input.linearUsers);
  const memberSummaries = buildMemberSummariesFromData({
    authored: input.authored,
    reviewRequested: input.reviewRequested,
    generatedAt: input.generatedAt,
    myIssues: input.myIssues,
    repoLinkedIssues: input.repoLinkedIssues,
    recentlyMerged: input.recentlyMerged,
    stuck,
    awaitingReview,
    unlinkedPrs,
    unlinkedTickets,
    resolveMember: resolve,
    lifecycleCtx,
  });

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
    memberSummaries,
  };
}

export function readTeamOverviewCache():
  | { snapshot: TeamOverviewSnapshot; updatedAtMs: number; refreshError: string | null }
  | null {
  const row = openStateDatabase()
    .select({
      payloadJson: schema.teamOverviewCache.payloadJson,
      updatedAtMs: schema.teamOverviewCache.updatedAtMs,
      refreshError: schema.teamOverviewCache.refreshError,
    })
    .from(schema.teamOverviewCache)
    .where(eq(schema.teamOverviewCache.id, 1))
    .get();
  if (!row) return null;
  return {
    snapshot: JSON.parse(row.payloadJson) as TeamOverviewSnapshot,
    updatedAtMs: row.updatedAtMs,
    refreshError: row.refreshError,
  };
}

export function writeTeamOverviewCache(snapshot: TeamOverviewSnapshot, errorMessage: string | null): void {
  const now = Date.now();
  openStateDatabase()
    .insert(schema.teamOverviewCache)
    .values({
      id: 1,
      payloadJson: JSON.stringify(snapshot),
      updatedAtMs: now,
      refreshError: errorMessage,
    })
    .onConflictDoUpdate({
      target: schema.teamOverviewCache.id,
      set: {
        payloadJson: JSON.stringify(snapshot),
        updatedAtMs: now,
        refreshError: errorMessage,
      },
    })
    .run();
}

export async function rebuildTeamOverviewSnapshot(): Promise<{ snapshot: TeamOverviewSnapshot; error: string | null }> {
  const generatedAt = new Date().toISOString();
  try {
    const config = loadConfig();
    const repos = getRepos();
    const includeOrgPulls = config.team?.includeGithubOrgMemberPulls !== false;
    const viewer = includeOrgPulls ? await getGitHubViewerCached() : null;
    const repoPaths = repos.map((r) => r.repo);

    const [lists, mergedLinkable] = await Promise.all([
      (async () => {
        if (!viewer) return buildPullSidebarLists(repos);
        const extra = await discoverTrackedOrgMemberLogins(repoPaths, viewer.login);
        return buildPullSidebarLists(repos, extra.size ? { includeAuthoredByLogins: extra } : undefined);
      })(),
      fetchMergedAuthoredLinkablePRs(repos),
    ]);

    if (lists.githubUserUnavailable) {
      const snap = emptySnapshot(generatedAt);
      return { snapshot: snap, error: "GitHub user unavailable" };
    }

    const muted = mutedReposAsSet(config.mutedRepos);
    const authored = filterSidebarRecordsByMutedRepos(lists.authored, muted);
    const reviewRequested = filterSidebarRecordsByMutedRepos(lists.reviewRequested, muted);
    const mergedLinkableVisible = filterPullRowsByMutedRepos(mergedLinkable, muted);

    const tState = getTicketState();

    let teamScopeIssues: TicketIssue[] = [];
    if (
      config.team?.includeLinearTeamScopeIssues !== false
      && (config.linearTeamKeys?.length ?? 0) > 0
    ) {
      try {
        const { getTicketProvider } = await import("../tickets/index.js");
        const provider = await getTicketProvider(config);
        if (provider?.fetchTeamScopeIssues) {
          const cap = Math.max(1, Math.min(500, config.team?.linearTeamIssueCap ?? 200));
          teamScopeIssues = await provider.fetchTeamScopeIssues(cap);
        }
      } catch {
        teamScopeIssues = [];
      }
    }

    const overviewMyIssues = dedupeIssuesByIdentifier([...tState.myIssues, ...teamScopeIssues]);
    const ticketsForClaude = dedupeIssuesByIdentifier([...overviewMyIssues, ...tState.repoLinkedIssues]);
    const toPRsRaw: Record<string, Array<{ number: number; repo: string; title: string }>> = {};
    for (const [k, v] of tState.linkMap.ticketToPRs) {
      toPRsRaw[k] = v;
    }
    const prToTicketsRaw: Record<string, string[]> = {};
    for (const [k, v] of tState.linkMap.prToTickets) {
      prToTicketsRaw[k] = v;
    }
    const ticketToPRs = filterTicketToPRsRecordForMutedRepos(toPRsRaw, muted);
    const prToTickets = filterPrToTicketsRecordForMutedRepos(prToTicketsRaw, muted);

    const now = Date.now();
    const coherenceInput: CoherenceInput = {
      myTickets: overviewMyIssues,
      repoLinkedTickets: tState.repoLinkedIssues,
      authoredPRs: authored.map(mapSidebarRowToCoherencePR),
      reviewRequestedPRs: reviewRequested.map(mapSidebarRowToCoherencePR),
      ticketToPRs,
      prToTickets,
      thresholds: {
        branchStalenessDays: config.coherence?.branchStalenessDays ?? 3,
        approvedUnmergedHours: config.coherence?.approvedUnmergedHours ?? 24,
        reviewWaitHours: config.coherence?.reviewWaitHours ?? 24,
        ticketInactivityDays: config.coherence?.ticketInactivityDays ?? 5,
      },
      now,
      mutedRepos: config.mutedRepos ?? [],
    };

    const alerts = evaluateCoherence(coherenceInput);
    const recentlyMerged = mergedLinkableVisible
      .filter((p) => p.mergedAt)
      .map((p) => ({
        repo: p.repo,
        number: p.number,
        title: p.title,
        mergedAt: p.mergedAt!,
        authorLogin: p.authorLogin,
      }));

    let linearUsers: LinearUserRef[] | undefined;
    try {
      const { getTicketProvider } = await import("../tickets/index.js");
      const provider = await getTicketProvider(config);
      if (provider?.listWorkspaceUsers) {
        const users = await provider.listWorkspaceUsers();
        if (users.length > 0) linearUsers = users;
      }
    } catch {
      linearUsers = undefined;
    }

    const {
      collectGithubLoginsForMemberLinking,
      collectUncoveredAssigneeKeys,
      hasUncoveredLinearAssigneeOnTickets,
      listUnrecognisedGithubLogins,
      memberLinkClaudeJobFingerprint,
      mergeManualAndClaudeMemberLinks,
      suggestMemberLinksWithClaude,
    } = await import("./member-link-claude.js");

    const githubLogins = collectGithubLoginsForMemberLinking(authored, reviewRequested, recentlyMerged);
    const ticketList = ticketsForClaude;

    const prevCache = readTeamOverviewCache();
    const prevSnap = prevCache?.snapshot;
    const prevClaude = Array.isArray(prevSnap?.claudeMemberLinkSuggestions)
      ? prevSnap!.claudeMemberLinkSuggestions!
      : [];

    const mergedForCoverage = mergeManualAndClaudeMemberLinks(config.team?.memberLinks, prevClaude);
    const unrecognisedGithub = listUnrecognisedGithubLogins(githubLogins, mergedForCoverage);
    const hasUncoveredAssignee = hasUncoveredLinearAssigneeOnTickets(ticketList, mergedForCoverage);
    const uncoveredAssigneeKeys = collectUncoveredAssigneeKeys(ticketList, mergedForCoverage);

    let claudeMemberLinkSuggestions = prevClaude;
    const claudeMemberLinkingOn = config.team?.claudeMemberLinking !== false;
    const needsClaudeMemberJob =
      claudeMemberLinkingOn && Boolean(linearUsers?.length)
      && githubLogins.length > 0
      && (unrecognisedGithub.length > 0 || hasUncoveredAssignee);

    let memberLinkJobFp = "";
    if (needsClaudeMemberJob && linearUsers) {
      memberLinkJobFp = memberLinkClaudeJobFingerprint(
        config.team?.memberLinks,
        unrecognisedGithub,
        uncoveredAssigneeKeys,
      );
      if (
        prevSnap?.memberLinkClaudeFingerprint === memberLinkJobFp
        && Array.isArray(prevSnap.claudeMemberLinkSuggestions)
      ) {
        claudeMemberLinkSuggestions = prevSnap.claudeMemberLinkSuggestions;
      } else {
        const githubForPrompt = hasUncoveredAssignee ? githubLogins : unrecognisedGithub;
        const newSuggestions = await suggestMemberLinksWithClaude(githubForPrompt, linearUsers);
        claudeMemberLinkSuggestions = mergeManualAndClaudeMemberLinks(prevClaude, newSuggestions);
      }
    }

    const mergedMemberLinks = mergeManualAndClaudeMemberLinks(
      config.team?.memberLinks,
      claudeMemberLinkSuggestions,
    );

    const snapshot = buildTeamOverviewSnapshotFromData({
      generatedAt,
      now,
      alerts,
      authored,
      reviewRequested,
      myIssues: overviewMyIssues,
      repoLinkedIssues: tState.repoLinkedIssues,
      ticketToPRs,
      prToTickets,
      recentlyMerged,
      teamMemberLinks: mergedMemberLinks,
      linearUsers,
    });

    if (memberLinkJobFp) {
      snapshot.memberLinkClaudeFingerprint = memberLinkJobFp;
    }
    snapshot.claudeMemberLinkSuggestions = claudeMemberLinkSuggestions;

    if (isTeamFeaturesEnabled(config) && config.team?.claudeMemberSummaries !== false) {
      try {
        const { enrichMemberSummariesWithAiDigests } = await import("./member-summary-ai.js");
        await enrichMemberSummariesWithAiDigests(snapshot);
      } catch (e) {
        log.warn(`[team] member AI digests skipped: ${(e as Error).message}`);
      }
    }

    return { snapshot, error: null };
  } catch (e) {
    return { snapshot: emptySnapshot(generatedAt), error: (e as Error).message };
  }
}
