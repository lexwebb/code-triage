import { LinearClient } from "@linear/sdk";
import type { TicketProvider, TicketIssue, TicketIssueDetail, TicketTeam, TicketUser } from "./types.js";
import { parseGithubPullRequestUrl, type LinkedPRRef } from "./linker.js";
import { recordLinearRequest } from "./stats.js";
import { linearGraphQL } from "./linear-gql.js";

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
    | Promise<{ id?: string; name: string; avatarUrl?: string | null } | null | undefined>
    | { id?: string; name: string; avatarUrl?: string | null }
    | null
    | undefined;
  labels: (vars?: Record<string, unknown>) => Promise<{ nodes: Array<{ name: string; color: string }> }>;
  attachments?: (vars?: Record<string, unknown>) => Promise<{ nodes: Array<{ url: string; title?: string }> }>;
  syncedWith?: Array<{
    service?: string;
    metadata?: { __typename?: string; owner?: string; repo?: string; number?: number };
  }>;
  updatedAt: Date;
  completedAt?: Date | null;
  canceledAt?: Date | null;
  url: string;
};

type GqlIssueNode = {
  id: string;
  identifier: string;
  title: string;
  state?: { name: string; color: string; type: string } | null;
  priority: number;
  assignee?: { id?: string; name: string; avatarUrl?: string | null } | null;
  labels?: { nodes: Array<{ name: string; color: string }> } | null;
  attachments?: { nodes: Array<{ url: string; title?: string | null }> } | null;
  // Optional in query because older/stricter schemas may reject this field.
  syncedWith?: Array<{
    service?: string | null;
    metadata?: {
      __typename?: string;
      owner?: string;
      repo?: string;
      number?: number;
    } | null;
  }> | null;
  updatedAt: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  url: string;
};

type GqlIssuesConnection = {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    nodes: GqlIssueNode[];
  };
};

type SyncedWithCarrier = {
  syncedWith?: Array<{
    service?: string | null;
    metadata?: {
      __typename?: string;
      owner?: string;
      repo?: string;
      number?: number;
    } | null;
  }> | null;
};

const ISSUES_LIST_GQL_WITH_SYNCED_WITH = `
  query IssuesForCodeTriage($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        priority
        updatedAt
        completedAt
        canceledAt
        url
        state { name color type }
        assignee { id name avatarUrl }
        labels(first: 50) { nodes { name color } }
        attachments(first: 100) { nodes { url title } }
        syncedWith {
          service
          metadata {
            __typename
            ... on ExternalEntityInfoGithubMetadata {
              owner
              repo
              number
            }
          }
        }
      }
    }
  }
`;

const ISSUES_LIST_GQL = `
  query IssuesForCodeTriage($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        priority
        updatedAt
        completedAt
        canceledAt
        url
        state { name color type }
        assignee { id name avatarUrl }
        labels(first: 50) { nodes { name color } }
        attachments(first: 100) { nodes { url title } }
      }
    }
  }
`;

const WORKSPACE_USERS_GQL = `
  query CodeTriageWorkspaceUsers($first: Int!, $after: String) {
    users(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        displayName
      }
    }
  }
`;

type GqlUsersConnection = {
  users: {
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    nodes: Array<{ id: string; name: string; displayName?: string | null }>;
  };
};

export class LinearProvider implements TicketProvider {
  private client: LinearClient;
  private readonly linearApiKey: string;
  private teamKeys?: string[];
  private viewerId: string | null = null;
  private identifierCache = new Map<string, { at: number; issue: TicketIssue | null }>();
  private issuesListQuerySupportsSyncedWith: boolean | null = null;

  constructor(apiKey: string, teamKeys?: string[]) {
    this.linearApiKey = apiKey;
    this.client = new LinearClient({ apiKey });
    this.teamKeys = teamKeys?.map((k) => k.trim()).filter((k) => k.length > 0);
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

    const issues = await this.fetchIssuesByFilter(filter);
    this.primeIdentifierCache(issues);
    return issues;
  }

  /**
   * Non-assignee-scoped issues for configured `linearTeamKeys` (active states only).
   * Requires `linearTeamKeys`; returns [] when unset to avoid workspace-wide fetch.
   */
  async fetchTeamScopeIssues(maxIssues: number): Promise<TicketIssue[]> {
    const cap = Math.max(1, Math.floor(maxIssues));
    if (!this.teamKeys?.length) return [];

    const filter = {
      team: { key: { in: this.teamKeys } },
      state: { type: { nin: ["completed", "canceled"] } },
    };

    const issues = await this.fetchIssuesByFilterCapped(filter, cap);
    this.primeIdentifierCache(issues);
    return issues;
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
      const teamIssues = await this.fetchIssuesByFilter({
        team: { key: { eq: teamKey } },
        number: { in: numbers },
      });
      allIssues.push(...teamIssues);
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

  private async fetchIssuesByFilter(filter: Record<string, unknown>): Promise<TicketIssue[]> {
    const all: TicketIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const data = await this.fetchIssuesPage(filter, after);
      for (const node of data.issues.nodes) {
        all.push(this.ticketIssueFromGqlNode(node));
      }
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor ?? undefined;
      if (!after) break;
    }
    return all;
  }

  private async fetchIssuesByFilterCapped(
    filter: Record<string, unknown>,
    maxIssues: number,
  ): Promise<TicketIssue[]> {
    const all: TicketIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const data = await this.fetchIssuesPage(filter, after);
      for (const node of data.issues.nodes) {
        all.push(this.ticketIssueFromGqlNode(node));
        if (all.length >= maxIssues) return all;
      }
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor ?? undefined;
      if (!after) break;
    }
    return all;
  }

  private async fetchIssuesPage(
    filter: Record<string, unknown>,
    after?: string,
  ): Promise<GqlIssuesConnection> {
    const variables = {
      filter,
      first: 50,
      after: after ?? null,
    };

    const shouldTrySyncedWith = this.issuesListQuerySupportsSyncedWith !== false;
    if (shouldTrySyncedWith) {
      try {
        const data = await linearGraphQL<GqlIssuesConnection>(
          this.linearApiKey,
          ISSUES_LIST_GQL_WITH_SYNCED_WITH,
          variables,
        );
        this.issuesListQuerySupportsSyncedWith = true;
        return data;
      } catch (error) {
        if (!isMissingSyncedWithFieldError(error)) throw error;
        // Some Linear schemas don't expose Issue.syncedWith. Fall back to attachments-only links.
        this.issuesListQuerySupportsSyncedWith = false;
      }
    }

    return linearGraphQL<GqlIssuesConnection>(
      this.linearApiKey,
      ISSUES_LIST_GQL,
      variables,
    );
  }

  private ticketIssueFromGqlNode(node: GqlIssueNode): TicketIssue {
    const attachmentRefs: LinkedPRRef[] = [];
    for (const attachment of node.attachments?.nodes ?? []) {
      const parsed = parseGithubPullRequestUrl(attachment.url);
      if (parsed) {
        attachmentRefs.push({
          repo: parsed.repo,
          number: parsed.number,
          title: attachment.title ?? "",
        });
      }
    }
    const providerLinkedPulls = dedupeLinkedPrRefs([
      ...attachmentRefs,
      ...this.syncedGithubPullRefs(node),
    ]);

    const state = node.state;
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
      assignee: node.assignee
        ? {
            ...(node.assignee.id ? { id: node.assignee.id } : {}),
            name: node.assignee.name,
            avatarUrl: node.assignee.avatarUrl ?? undefined,
          }
        : undefined,
      labels: (node.labels?.nodes ?? []).map((label) => ({ name: label.name, color: label.color })),
      updatedAt: node.updatedAt,
      providerUrl: node.url,
    };
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

  async listWorkspaceUsers(): Promise<Array<{ id: string; name: string }>> {
    recordLinearRequest("users");
    const out: Array<{ id: string; name: string }> = [];
    let after: string | null = null;
    const pageSize = 100;
    for (;;) {
      const data: GqlUsersConnection = await linearGraphQL<GqlUsersConnection>(
        this.linearApiKey,
        WORKSPACE_USERS_GQL,
        {
          first: pageSize,
          after,
        },
      );
      const conn: GqlUsersConnection["users"] = data.users;
      for (const u of conn.nodes ?? []) {
        const display = (u.displayName?.trim() || u.name?.trim() || "").trim();
        if (u.id && display) {
          out.push({ id: u.id, name: display });
        }
      }
      if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
      if (out.length > 2_000) break;
    }
    return out;
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
      assignee: assignee
        ? {
            ...(assignee.id ? { id: assignee.id } : {}),
            name: assignee.name,
            avatarUrl: assignee.avatarUrl ?? undefined,
          }
        : undefined,
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
    if (typeof node.attachments !== "function") return [];
    try {
      recordLinearRequest("issue.attachments");
      const conn = await node.attachments({ first: 100 });
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
  private syncedGithubPullRefs(node: SyncedWithCarrier): LinkedPRRef[] {
    if (!node.syncedWith?.length) return [];
    const refs: LinkedPRRef[] = [];
    for (const s of node.syncedWith) {
      const svc = (s.service ?? "").toLowerCase();
      if (!svc.includes("github")) continue;
      const m = s.metadata;
      if (
        m
        && typeof m.owner === "string"
        && typeof m.repo === "string"
        && typeof m.number === "number"
      ) {
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

function isMissingSyncedWithFieldError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const m = error.message;
  return (
    /cannot query field\s+"?syncedwith"?\s+on type\s+"?issue"?/i.test(m)
    // Linear sometimes returns HTTP 400 with the same message in the error text.
    || (/Linear GraphQL HTTP 400/i.test(m) && /syncedwith/i.test(m))
  );
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

export function dedupeIssuesByIdentifier(issues: TicketIssue[]): TicketIssue[] {
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
