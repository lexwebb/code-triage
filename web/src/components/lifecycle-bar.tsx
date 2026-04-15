import { cn } from "../lib/utils";
import type { PullRequest } from "../types";
import type { TicketIssue, TicketIssueDetail } from "../types";

export type LifecycleStage =
  | "created"
  | "branch"
  | "pr-open"
  | "review-requested"
  | "approved"
  | "merged"
  | "closed";

const STAGES: { key: LifecycleStage; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "branch", label: "Branch" },
  { key: "pr-open", label: "PR" },
  { key: "review-requested", label: "Review" },
  { key: "approved", label: "Approved" },
  { key: "merged", label: "Merged" },
  { key: "closed", label: "Closed" },
];

interface LifecycleBarProps {
  currentStage?: LifecycleStage;
  stuck?: boolean;
  compact?: boolean;
  className?: string;
}

const STAGE_KEYS = new Set(STAGES.map((s) => s.key));

function stageIndex(stage: LifecycleStage): number {
  return STAGES.findIndex((s) => s.key === stage);
}

// eslint-disable-next-line react-refresh/only-export-components
export function coerceLifecycleStage(value: string | undefined): LifecycleStage | undefined {
  if (!value) return undefined;
  return STAGE_KEYS.has(value as LifecycleStage) ? (value as LifecycleStage) : undefined;
}

/**
 * Prefer live store-derived lifecycle (same as tickets / PR sidebar); fall back to persisted attention `stage`.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveAttentionLifecycleStage(
  item: { entityKind: "pr" | "ticket"; entityIdentifier: string; stage?: string },
  ctx: {
    prToTickets: Record<string, string[]>;
    openPulls: PullRequest[];
    myTickets: TicketIssue[];
    repoLinkedTickets: TicketIssue[];
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

export function LifecycleBar({ currentStage, stuck, compact = true, className }: LifecycleBarProps) {
  if (!currentStage) return null;
  const currentIdx = stageIndex(currentStage);
  const currentLabel = STAGES[currentIdx]?.label ?? "Unknown";

  return (
    <div className={cn("flex items-center gap-0.5", className)} title={`Stage: ${currentLabel}`}>
      {STAGES.map((stage, i) => {
        const isCurrent = i === currentIdx;
        const isCompleted = i < currentIdx;
        const isFuture = i > currentIdx;
        return (
          <div
            key={stage.key}
            className={cn(
              "h-1.5 w-1.5 rounded-full transition-colors",
              isCompleted && "bg-green-500",
              isCurrent && !stuck && "bg-blue-400",
              isCurrent && stuck && "bg-amber-400",
              isFuture && "bg-zinc-700",
            )}
            title={stage.label}
          />
        );
      })}
      {!compact && (
        <span className={cn("ml-1 text-[10px]", stuck ? "text-amber-400" : "text-zinc-500")}>
          {currentLabel}
        </span>
      )}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
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

  // Linear workflow names when GitHub linkage is missing or stale
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

  // Assigned / active Linear state but no open PR in our sidebar lists
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

function linkedPrRefs(issue: TicketIssue | TicketIssueDetail, prToTickets: Record<string, string[]>): Array<{ repo: string; number: number }> {
  if ("linkedPRs" in issue && issue.linkedPRs.length > 0) {
    return issue.linkedPRs.map((p) => ({ repo: p.repo, number: p.number }));
  }
  return Object.entries(prToTickets)
    .filter(([, ids]) => ids.includes(issue.identifier))
    .map(([key]) => parsePrToTicketKey(key))
    .filter((x): x is { repo: string; number: number } => x != null);
}

/**
 * Lifecycle for a ticket using Linear fields plus GitHub open PRs.
 * Detects merged PRs (still linked in Linear / map) that no longer appear in open pull lists.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function deriveTicketIssueLifecycleStage(
  issue: TicketIssue | TicketIssueDetail,
  prToTickets: Record<string, string[]>,
  openPulls: PullRequest[],
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
