/**
 * Shared lifecycle stage derivation for attention feed, team snapshot, and coherence.
 * Keep in sync with product semantics (Linear + GitHub open PRs).
 */

export type LifecycleStage =
  | "created"
  | "branch"
  | "pr-open"
  | "review-requested"
  | "approved"
  | "merged"
  | "closed";

const STAGE_KEYS = new Set<string>([
  "created",
  "branch",
  "pr-open",
  "review-requested",
  "approved",
  "merged",
  "closed",
]);

export function coerceLifecycleStage(value: string | undefined): LifecycleStage | undefined {
  if (!value) return undefined;
  return STAGE_KEYS.has(value) ? (value as LifecycleStage) : undefined;
}

export interface OpenPullLike {
  repo: string;
  number: number;
  hasHumanApproval: boolean;
}

export interface TicketIssueLike {
  identifier: string;
  title: string;
  state: { name: string; type: string };
  isDone?: boolean;
  providerLinkedPulls?: Array<{ number: number; repo: string; title: string }>;
}

export interface TicketIssueDetailLike extends TicketIssueLike {
  linkedPRs?: Array<{ repo: string; number: number }>;
}

export function deriveLifecycleStage(opts: {
  ticketState?: string;
  /** Linear workflow state label (e.g. "In Progress", "Merged") */
  ticketStateName?: string;
  isDone?: boolean;
  hasBranch?: boolean;
  prOpen?: boolean;
  hasReviewers?: boolean;
  approved?: boolean;
  merged?: boolean;
  ticketClosed?: boolean;
}): LifecycleStage {
  const type = opts.ticketState ?? "";
  const name = (opts.ticketStateName ?? "").toLowerCase();

  if (
    opts.ticketClosed ||
    opts.isDone ||
    type === "completed" ||
    type === "canceled"
  ) {
    return "closed";
  }

  if (/\b(done|complete|completed|wont fix|won't fix|cancelled|canceled)\b/.test(name)) {
    return "closed";
  }
  if (/\bmerged\b/.test(name)) return "merged";
  if (/\b(deployed|released|shipped|in production)\b/.test(name)) return "merged";
  if (/\b(in review|in-review|code review)\b/.test(name)) {
    if (opts.prOpen || opts.hasBranch) return "review-requested";
    return "pr-open";
  }

  if (opts.merged) return "merged";
  if (opts.approved) return "approved";
  if (opts.hasReviewers) return "review-requested";
  if (opts.prOpen) return "pr-open";
  if (opts.hasBranch) return "branch";

  if (type === "started") return "branch";

  return "created";
}

function parsePrToTicketKey(key: string): { repo: string; number: number } | null {
  const i = key.lastIndexOf("#");
  if (i <= 0) return null;
  const repo = key.slice(0, i);
  const num = parseInt(key.slice(i + 1), 10);
  if (!Number.isFinite(num)) return null;
  return { repo, number: num };
}

function linkedPrRefs(
  issue: TicketIssueLike | TicketIssueDetailLike,
  prToTickets: Record<string, string[]>,
): Array<{ repo: string; number: number }> {
  if ("linkedPRs" in issue && issue.linkedPRs && issue.linkedPRs.length > 0) {
    return issue.linkedPRs.map((p) => ({ repo: p.repo, number: p.number }));
  }
  return Object.entries(prToTickets)
    .filter(([, ids]) => ids.includes(issue.identifier))
    .map(([key]) => parsePrToTicketKey(key))
    .filter((x): x is { repo: string; number: number } => x != null);
}

export function deriveTicketIssueLifecycleStage(
  issue: TicketIssueLike | TicketIssueDetailLike,
  prToTickets: Record<string, string[]>,
  openPulls: OpenPullLike[],
): LifecycleStage {
  const refs = linkedPrRefs(issue, prToTickets);
  const openByKey = new Map(openPulls.map((p) => [`${p.repo}#${p.number}`, p] as const));

  let linkedOpen = false;
  let approved = false;
  for (const ref of refs) {
    const pull = openByKey.get(`${ref.repo}#${ref.number}`);
    if (pull) {
      linkedOpen = true;
      if (pull.hasHumanApproval) approved = true;
    }
  }

  const hasAnyLink = refs.length > 0;
  const inactiveLinear = issue.state.type === "unstarted" || issue.state.type === "backlog";
  const inferredMerged =
    hasAnyLink && !linkedOpen && !issue.isDone && !inactiveLinear;

  return deriveLifecycleStage({
    ticketState: issue.state.type,
    ticketStateName: issue.state.name,
    isDone: issue.isDone,
    hasBranch: hasAnyLink,
    prOpen: linkedOpen,
    approved,
    merged: inferredMerged,
    ticketClosed: issue.state.type === "canceled",
  });
}

/**
 * Same rules as the web attention row: prefer live PR/ticket maps, fall back to persisted `stage`.
 */
export function resolveAttentionLifecycleStage(
  item: { entityKind: "pr" | "ticket"; entityIdentifier: string; stage?: string },
  ctx: {
    prToTickets: Record<string, string[]>;
    openPulls: OpenPullLike[];
    myTickets: TicketIssueLike[];
    repoLinkedTickets: TicketIssueLike[];
  },
): LifecycleStage | undefined {
  if (item.entityKind === "ticket") {
    const ticket = [...ctx.myTickets, ...ctx.repoLinkedTickets].find(
      (t) => t.identifier === item.entityIdentifier,
    );
    if (ticket) return deriveTicketIssueLifecycleStage(ticket, ctx.prToTickets, ctx.openPulls);
    return coerceLifecycleStage(item.stage);
  }

  const pr = ctx.openPulls.find((p) => `${p.repo}#${p.number}` === item.entityIdentifier);
  if (pr) {
    const ticketIds = ctx.prToTickets[item.entityIdentifier] ?? [];
    const linkedTicket = [...ctx.myTickets, ...ctx.repoLinkedTickets].find((t) =>
      ticketIds.includes(t.identifier),
    );
    if (linkedTicket) {
      return deriveLifecycleStage({
        ticketState: linkedTicket.state.type,
        ticketStateName: linkedTicket.state.name,
        isDone: linkedTicket.isDone,
        hasBranch: true,
        prOpen: true,
        approved: pr.hasHumanApproval,
        merged: false,
        ticketClosed:
          linkedTicket.state.type === "completed" || linkedTicket.state.type === "canceled",
      });
    }
    return deriveLifecycleStage({
      hasBranch: true,
      prOpen: true,
      approved: pr.hasHumanApproval,
    });
  }

  return coerceLifecycleStage(item.stage);
}

/** Merged PRs in the snapshot: stage is always merged. */
export function mergedPullLifecycleStage(): LifecycleStage {
  return "merged";
}
