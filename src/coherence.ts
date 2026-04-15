import {
  filterPrToTicketsRecordForMutedRepos,
  filterPullRowsByMutedRepos,
  filterTicketToPRsRecordForMutedRepos,
  mutedReposAsSet,
  normalizeRepoMuteKey,
} from "./muted-repos.js";

export interface CoherenceThresholds {
  branchStalenessDays: number;
  approvedUnmergedHours: number;
  reviewWaitHours: number;
  ticketInactivityDays: number;
}

export interface CoherencePR {
  number: number;
  repo: string;
  title: string;
  branch: string;
  updatedAt: string;
  checksStatus: string;
  hasHumanApproval: boolean;
  merged: boolean;
  reviewers: Array<{ login: string; state: string }>;
  pendingTriage?: number;
}

export interface CoherenceTicket {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; color: string; type: string };
  isDone?: boolean;
  /** Linear attachments / sync — truth when ticketToPRs merge is incomplete */
  providerLinkedPulls?: Array<{ number: number; repo: string; title: string }>;
  priority: number;
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  providerUrl: string;
}

export interface CoherenceInput {
  myTickets: CoherenceTicket[];
  repoLinkedTickets: CoherenceTicket[];
  authoredPRs: CoherencePR[];
  reviewRequestedPRs: CoherencePR[];
  ticketToPRs: Record<string, Array<{ number: number; repo: string; title: string }>>;
  prToTickets: Record<string, string[]>;
  thresholds: CoherenceThresholds;
  now: number;
  /** `owner/repo` (case-insensitive); PRs in these repos are excluded from coherence and attention. */
  mutedRepos?: string[];
}

export interface CoherenceAlert {
  id: string;
  type: string;
  entityKind: "pr" | "ticket";
  entityIdentifier: string;
  priority: "high" | "medium" | "low";
  title: string;
  stage?: string;
  stuckSince?: string;
}

function msToHours(ms: number): number {
  return ms / (1000 * 60 * 60);
}

function msToDays(ms: number): number {
  return msToHours(ms) / 24;
}

/** Broad: suppress "no PR" / noise when the workflow label already says the work shipped. */
function isDoneTicket(ticket: CoherenceTicket): boolean {
  if (ticket.isDone) return true;
  const type = ticket.state.type.toLowerCase();
  if (type === "completed" || type === "canceled") return true;
  const name = (ticket.state.name ?? "").toLowerCase();
  if (/\b(merged|done|complete|completed|closed|shipped|released|deployed)\b/.test(name)) return true;
  if (/\b(wont fix|won't fix|cancelled|canceled)\b/.test(name)) return true;
  return false;
}

/** Narrow: "done but PR open" only when Linear/provider says the issue is actually terminal. */
function isStrictLinearDone(ticket: CoherenceTicket): boolean {
  if (ticket.isDone) return true;
  const type = ticket.state.type.toLowerCase();
  return type === "completed" || type === "canceled";
}

export function evaluateCoherence(input: CoherenceInput): CoherenceAlert[] {
  const alerts: CoherenceAlert[] = [];
  const { thresholds, now } = input;

  const muted = mutedReposAsSet(input.mutedRepos);
  const authoredPRs =
    muted.size === 0 ? input.authoredPRs : filterPullRowsByMutedRepos(input.authoredPRs, muted);
  const reviewRequestedPRs =
    muted.size === 0 ? input.reviewRequestedPRs : filterPullRowsByMutedRepos(input.reviewRequestedPRs, muted);

  const ticketToPRs =
    muted.size === 0 ? input.ticketToPRs : filterTicketToPRsRecordForMutedRepos(input.ticketToPRs, muted);
  const prToTickets =
    muted.size === 0 ? input.prToTickets : filterPrToTicketsRecordForMutedRepos(input.prToTickets, muted);

  const prByKey = new Map<string, CoherencePR>();
  for (const pr of [...authoredPRs, ...reviewRequestedPRs]) {
    prByKey.set(`${pr.repo}#${pr.number}`, pr);
  }

  const allTickets = [...input.myTickets, ...input.repoLinkedTickets];
  const seenTickets = new Set<string>();
  for (const ticket of allTickets) {
    if (seenTickets.has(ticket.identifier)) continue;
    seenTickets.add(ticket.identifier);

    const linkedPRs = ticketToPRs[ticket.identifier] ?? [];
    const linkedPRData = linkedPRs
      .map((ref) => prByKey.get(`${ref.repo}#${ref.number}`))
      .filter((pr): pr is CoherencePR => Boolean(pr));

    const visibleProviderPulls =
      muted.size === 0
        ? (ticket.providerLinkedPulls ?? [])
        : (ticket.providerLinkedPulls ?? []).filter((p) => !muted.has(normalizeRepoMuteKey(p.repo)));

    if (ticket.state.type === "started" && linkedPRData.length > 0) {
      const mostRecentPRActivity = Math.max(
        ...linkedPRData.map((pr) => new Date(pr.updatedAt).getTime()),
      );
      const daysSinceActivity = msToDays(now - mostRecentPRActivity);
      if (daysSinceActivity >= thresholds.branchStalenessDays) {
        alerts.push({
          id: `stale-in-progress:${ticket.identifier}`,
          type: "stale-in-progress",
          entityKind: "ticket",
          entityIdentifier: ticket.identifier,
          priority: "medium",
          title: `${ticket.identifier} says in progress but branch is idle`,
          stage: "pr-open",
          stuckSince: new Date(mostRecentPRActivity).toISOString(),
        });
      }
    }

    // Rule: Ticket assigned with no PR signal (GitHub scrape + provider-linked PRs).
    const hasProviderPrs = visibleProviderPulls.length > 0;
    if (ticket.state.type === "started" && linkedPRs.length === 0 && !hasProviderPrs && !isDoneTicket(ticket)) {
      alerts.push({
        id: `ticket-no-pr:${ticket.identifier}`,
        type: "ticket-no-pr",
        entityKind: "ticket",
        entityIdentifier: ticket.identifier,
        priority: "medium",
        title: `${ticket.identifier} is in progress but has no PR`,
        stage: "created",
      });
    }

    if (isStrictLinearDone(ticket) && linkedPRData.some((pr) => !pr.merged)) {
      const firstOpen = linkedPRData.find((pr) => !pr.merged);
      if (firstOpen) {
        alerts.push({
          id: `done-but-unmerged:${ticket.identifier}`,
          type: "done-but-unmerged",
          entityKind: "ticket",
          entityIdentifier: ticket.identifier,
          priority: "medium",
          title: `${ticket.identifier} marked done but PR #${firstOpen.number} isn't merged`,
        });
      }
    }

    // "No activity" only once work has reached In Progress — not for Todo/backlog sitting idle.
    if (ticket.state.type === "started" && !isDoneTicket(ticket)) {
      const daysSinceUpdate = msToDays(now - new Date(ticket.updatedAt).getTime());
      if (daysSinceUpdate >= thresholds.ticketInactivityDays && linkedPRData.length === 0) {
        alerts.push({
          id: `ticket-inactive:${ticket.identifier}`,
          type: "ticket-inactive",
          entityKind: "ticket",
          entityIdentifier: ticket.identifier,
          priority: "low",
          title: `${ticket.identifier} has no activity for ${Math.floor(daysSinceUpdate)} days`,
        });
      }
    }
  }

  for (const pr of authoredPRs) {
    const prKey = `${pr.repo}#${pr.number}`;

    // Rule: CI failure
    if (pr.checksStatus === "failure") {
      alerts.push({
        id: `ci-failure:${prKey}`,
        type: "ci-failure",
        entityKind: "pr",
        entityIdentifier: prKey,
        priority: "medium",
        title: `PR #${pr.number} CI is failing`,
        stage: pr.hasHumanApproval ? "approved" : "review-requested",
      });
    }

    if (pr.hasHumanApproval) {
      const hoursSinceUpdate = msToHours(now - new Date(pr.updatedAt).getTime());
      if (hoursSinceUpdate >= thresholds.approvedUnmergedHours) {
        const days = Math.floor(hoursSinceUpdate / 24);
        const label = days >= 1
          ? `${days} day${days > 1 ? "s" : ""} ago`
          : `${Math.floor(hoursSinceUpdate)} hours ago`;
        alerts.push({
          id: `approved-but-lingering:${prKey}`,
          type: "approved-but-lingering",
          entityKind: "pr",
          entityIdentifier: prKey,
          priority: "medium",
          title: `PR #${pr.number} approved ${label} - merge or update?`,
          stage: "approved",
        });
      }
    }

    const tickets = prToTickets[prKey];
    if (!tickets || tickets.length === 0) {
      alerts.push({
        id: `pr-without-ticket:${prKey}`,
        type: "pr-without-ticket",
        entityKind: "pr",
        entityIdentifier: prKey,
        priority: "low",
        title: `PR #${pr.number} has no linked ticket`,
      });
    }
  }

  for (const pr of reviewRequestedPRs) {
    const prKey = `${pr.repo}#${pr.number}`;
    const hoursSinceUpdate = msToHours(now - new Date(pr.updatedAt).getTime());
    if (hoursSinceUpdate >= thresholds.reviewWaitHours) {
      alerts.push({
        id: `review-bottleneck:${prKey}`,
        type: "review-bottleneck",
        entityKind: "pr",
        entityIdentifier: prKey,
        priority: "high",
        title: `PR #${pr.number} waiting on review for ${Math.floor(hoursSinceUpdate)} hours`,
      });
    }
  }

  return alerts;
}
