import { LinearClient } from "@linear/sdk";
import type { TicketProvider, TicketIssue, TicketIssueDetail, TicketTeam, TicketUser } from "./types.js";
import { parseGithubPullRequestUrl, type LinkedPRRef } from "./linker.js";
import { recordLinearRequest } from "./stats.js";

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  state:
    | Promise<{ name: string; color: string; type: string }>
    | { name: string; color: string; type: string }
    | undefined;
  priority: number;
  assignee:
    | Promise<{ name: string; avatarUrl?: string | null } | null | undefined>
    | { name: string; avatarUrl?: string | null }
    | null
    | undefined;
  labels: (vars?: Record<string, unknown>) => Promise<{ nodes: Array<{ name: string; color: string }> }>;
  updatedAt: Date;
  completedAt?: Date | null;
  canceledAt?: Date | null;
  url: string;
};

export class LinearProvider implements TicketProvider {
  private client: LinearClient;
  private teamKeys?: string[];
  private viewerId: string | null = null;
  private identifierCache = new Map<string, { at: number; issue: TicketIssue | null }>();

  constructor(apiKey: string, teamKeys?: string[]) {
    this.client = new LinearClient({ apiKey });
    this.teamKeys = teamKeys;
  }

  /** Keep ticket identifier lookups warm across poll cycles to cut Linear request volume. */
  private static readonly IDENTIFIER_CACHE_TTL_MS = 15 * 60_000;

  async fetchMyIssues(): Promise<TicketIssue[]> {
    if (!this.viewerId) {
      const viewer = await this.getViewer();
      this.viewerId = viewer.id;
    }

    const filter = {
      assignee: { id: { eq: this.viewerId } },
      state: { type: { nin: ["completed", "canceled"] } },
      ...(this.teamKeys?.length ? { team: { key: { in: this.teamKeys } } } : {}),
    };

    recordLinearRequest("issues");
    const connection = await this.client.issues({
      filter,
      orderBy: "updatedAt" as never,
    });

    // Linear defaults to ~50 issues per page; fetch the rest so /api/tickets/mine is complete.
    const paginated = connection as {
      nodes: unknown[];
      pageInfo?: { hasNextPage?: boolean };
      fetchNext?: () => Promise<unknown>;
    };
    while (paginated.pageInfo?.hasNextPage && typeof paginated.fetchNext === "function") {
      recordLinearRequest("issues.fetchNext");
      await paginated.fetchNext();
    }

    const mapped = await Promise.all(
      paginated.nodes.map((n) => this.mapIssue(n as unknown as IssueNode)),
    );
    this.primeIdentifierCache(mapped);
    return mapped;
  }

  async fetchIssuesByIdentifiers(identifiers: string[]): Promise<TicketIssue[]> {
    if (identifiers.length === 0) return [];

    const normalized = Array.from(new Set(identifiers.map((id) => id.toUpperCase())));
    const now = Date.now();
    const cachedOut: TicketIssue[] = [];
    const misses: string[] = [];
    for (const id of normalized) {
      const hit = this.identifierCache.get(id);
      if (hit && now - hit.at < LinearProvider.IDENTIFIER_CACHE_TTL_MS) {
        if (hit.issue) cachedOut.push(hit.issue);
      } else {
        misses.push(id);
      }
    }

    if (misses.length === 0) return dedupeIssuesByIdentifier(cachedOut);

    const parsed = misses
      .map((id) => {
        const match = id.match(/^([A-Za-z]{2,10})-(\d+)$/);
        return match
          ? { teamKey: match[1]!.toUpperCase(), number: parseInt(match[2]!, 10) }
          : null;
      })
      .filter((p): p is { teamKey: string; number: number } => p !== null);

    if (parsed.length === 0) return dedupeIssuesByIdentifier(cachedOut);

    const byTeam = new Map<string, number[]>();
    for (const { teamKey, number } of parsed) {
      const nums = byTeam.get(teamKey) ?? [];
      nums.push(number);
      byTeam.set(teamKey, nums);
    }

    const allIssues: TicketIssue[] = [];
    for (const [teamKey, numbers] of Array.from(byTeam.entries())) {
      recordLinearRequest("issues");
      const result = await this.client.issues({
        // one query per team bucket
        filter: {
          team: { key: { eq: teamKey } },
          number: { in: numbers },
        },
      });
      const mapped = await Promise.all(result.nodes.map((n) => this.mapIssue(n as unknown as IssueNode)));
      allIssues.push(...mapped);
    }

    this.primeIdentifierCache(allIssues);
    // Negative caching: identifiers that were requested but not returned.
    const found = new Set(allIssues.map((i) => i.identifier.toUpperCase()));
    const stamped = Date.now();
    for (const id of misses) {
      if (!found.has(id)) this.identifierCache.set(id, { at: stamped, issue: null });
    }

    return dedupeIssuesByIdentifier([...cachedOut, ...allIssues]);
  }

  async getIssueDetail(id: string): Promise<TicketIssueDetail> {
    recordLinearRequest("issue");
    const issue = await this.client.issue(id);
    const base = await this.mapIssue(issue as unknown as IssueNode);
    recordLinearRequest("issue.comments");
    const commentsResult = await issue.comments();
    const comments = await Promise.all(
      commentsResult.nodes.map(async (c) => {
        const user = await (c.user as unknown as Promise<{ name: string; avatarUrl: string | null } | null | undefined>);
        return {
          id: c.id,
          body: c.body,
          author: { name: user?.name ?? "Unknown", avatarUrl: user?.avatarUrl as string | undefined },
          createdAt: c.createdAt.toISOString(),
        };
      }),
    );

    return {
      ...base,
      description: issue.description ?? undefined,
      comments,
    };
  }

  async getCurrentUser(): Promise<TicketUser> {
    const viewer = await this.getViewer();
    this.viewerId = viewer.id;
    return { id: viewer.id, name: viewer.name, email: viewer.email ?? "" };
  }

  async getTeams(): Promise<TicketTeam[]> {
    recordLinearRequest("teams");
    const result = await this.client.teams();
    return result.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
  }

  /**
   * Resolves viewer — works with both the real SDK (getter returning a Promise)
   * and test mocks (vi.fn() returning a resolved value when called).
   */
  private async getViewer(): Promise<{ id: string; name: string; email?: string | null }> {
    const viewerRef = this.client.viewer as unknown;
    if (typeof viewerRef === "function") {
      recordLinearRequest("viewer");
      return (viewerRef as () => Promise<{ id: string; name: string; email?: string | null }>)();
    }
    recordLinearRequest("viewer");
    return viewerRef as Promise<{ id: string; name: string; email?: string | null }>;
  }

  private async mapIssue(node: IssueNode): Promise<TicketIssue> {
    const state = await Promise.resolve(node.state);
    const assignee = await Promise.resolve(node.assignee);
    let labelNodes: Array<{ name: string; color: string }> = [];
    try {
      recordLinearRequest("issue.labels");
      const labelsResult = await node.labels({ first: 50 });
      labelNodes = labelsResult.nodes.map((l) => ({ name: l.name, color: l.color }));
    } catch {
      /* labels connection can fail if pagination vars are required */
    }
    const attachmentRefs = await this.attachmentGithubPullRefs(node);
    const providerLinkedPulls = dedupeLinkedPrRefs([
      ...attachmentRefs,
      ...this.syncedGithubPullRefs(node),
    ]);

    const stateName = state?.name ?? "";
    const terminalByWorkflowName =
      /\b(merged|done|complete|completed|closed|shipped|released|deployed)\b/i.test(stateName)
      || /\b(wont fix|won't fix|cancelled|canceled)\b/i.test(stateName);

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      state: state
        ? { name: state.name, color: state.color, type: state.type }
        : { name: "Unknown", color: "#888888", type: "unstarted" },
      priority: node.priority,
      isDone: Boolean(
        node.completedAt
          || node.canceledAt
          || state?.type === "completed"
          || state?.type === "canceled"
          || terminalByWorkflowName,
      ),
      providerLinkedPulls: providerLinkedPulls.length > 0 ? providerLinkedPulls : undefined,
      assignee: assignee ? { name: assignee.name, avatarUrl: assignee.avatarUrl ?? undefined } : undefined,
      labels: labelNodes,
      updatedAt: node.updatedAt.toISOString(),
      providerUrl: node.url,
    };
  }

  /**
   * GitHub PR URLs from Linear attachments. The GraphQL connection requires `first` (or `last`);
   * calling `attachments()` with no args often fails and was silently returning [].
   */
  private async attachmentGithubPullRefs(node: IssueNode): Promise<LinkedPRRef[]> {
    const raw = node as unknown as {
      attachments?: (vars?: Record<string, unknown>) => Promise<{ nodes: Array<{ url: string; title?: string }> }>;
    };
    if (typeof raw.attachments !== "function") return [];
    try {
      recordLinearRequest("issue.attachments");
      const conn = await raw.attachments({ first: 100 });
      const nodes = conn?.nodes ?? [];
      const refs: LinkedPRRef[] = [];
      for (const n of nodes) {
        const p = parseGithubPullRequestUrl(n.url);
        if (p) refs.push({ repo: p.repo, number: p.number, title: n.title ?? "" });
      }
      return refs;
    } catch {
      return [];
    }
  }

  /**
   * GitHub entity metadata already loaded on the Issue fragment (`syncedWith`), no extra round-trip.
   */
  private syncedGithubPullRefs(node: IssueNode): LinkedPRRef[] {
    const raw = node as unknown as {
      syncedWith?: Array<{ service?: string; metadata?: unknown }>;
    };
    if (!raw.syncedWith?.length) return [];
    const refs: LinkedPRRef[] = [];
    for (const s of raw.syncedWith) {
      const svc = (s.service ?? "").toLowerCase();
      if (!svc.includes("github")) continue;
      const m = s.metadata as { owner?: string; repo?: string; number?: number } | undefined;
      if (m?.owner && m.repo != null && m.number != null) {
        refs.push({ repo: `${m.owner}/${m.repo}`, number: m.number, title: "" });
      }
    }
    return refs;
  }

  private primeIdentifierCache(issues: TicketIssue[]): void {
    const now = Date.now();
    for (const issue of issues) {
      this.identifierCache.set(issue.identifier.toUpperCase(), { at: now, issue });
    }
  }
}

function dedupeLinkedPrRefs(refs: LinkedPRRef[]): LinkedPRRef[] {
  const seen = new Set<string>();
  const out: LinkedPRRef[] = [];
  for (const r of refs) {
    const k = `${r.repo}#${r.number}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function dedupeIssuesByIdentifier(issues: TicketIssue[]): TicketIssue[] {
  const seen = new Set<string>();
  const out: TicketIssue[] = [];
  for (const issue of issues) {
    const key = issue.identifier.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}
