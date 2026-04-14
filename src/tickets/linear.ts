import { LinearClient } from "@linear/sdk";
import type { TicketProvider, TicketIssue, TicketIssueDetail, TicketTeam, TicketUser } from "./types.js";

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
  labels: () => Promise<{ nodes: Array<{ name: string; color: string }> }>;
  updatedAt: Date;
  url: string;
};

export class LinearProvider implements TicketProvider {
  private client: LinearClient;
  private teamKeys?: string[];
  private viewerId: string | null = null;

  constructor(apiKey: string, teamKeys?: string[]) {
    this.client = new LinearClient({ apiKey });
    this.teamKeys = teamKeys;
  }

  async fetchMyIssues(): Promise<TicketIssue[]> {
    if (!this.viewerId) {
      const viewer = await this.getViewer();
      this.viewerId = viewer.id;
    }

    const result = await this.client.issues({
      filter: {
        assignee: { id: { eq: this.viewerId } },
        state: { type: { nin: ["completed", "canceled"] } },
        ...(this.teamKeys?.length ? { team: { key: { in: this.teamKeys } } } : {}),
      },
      orderBy: "updatedAt" as never,
    });

    return Promise.all(result.nodes.map((n) => this.mapIssue(n as unknown as IssueNode)));
  }

  async fetchIssuesByIdentifiers(identifiers: string[]): Promise<TicketIssue[]> {
    if (identifiers.length === 0) return [];

    const parsed = identifiers
      .map((id) => {
        const match = id.match(/^([A-Z]{2,10})-(\d+)$/);
        return match ? { teamKey: match[1]!, number: parseInt(match[2]!, 10) } : null;
      })
      .filter((p): p is { teamKey: string; number: number } => p !== null);

    if (parsed.length === 0) return [];

    const byTeam = new Map<string, number[]>();
    for (const { teamKey, number } of parsed) {
      const nums = byTeam.get(teamKey) ?? [];
      nums.push(number);
      byTeam.set(teamKey, nums);
    }

    const allIssues: TicketIssue[] = [];
    for (const [teamKey, numbers] of byTeam) {
      const result = await this.client.issues({
        filter: {
          team: { key: { eq: teamKey } },
          number: { in: numbers },
        },
      });
      const mapped = await Promise.all(result.nodes.map((n) => this.mapIssue(n as unknown as IssueNode)));
      allIssues.push(...mapped);
    }

    return allIssues;
  }

  async getIssueDetail(id: string): Promise<TicketIssueDetail> {
    const issue = await this.client.issue(id);
    const base = await this.mapIssue(issue as unknown as IssueNode);
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
      return (viewerRef as () => Promise<{ id: string; name: string; email?: string | null }>)();
    }
    return viewerRef as Promise<{ id: string; name: string; email?: string | null }>;
  }

  private async mapIssue(node: IssueNode): Promise<TicketIssue> {
    const [state, assignee, labelsResult] = await Promise.all([
      Promise.resolve(node.state),
      Promise.resolve(node.assignee),
      node.labels(),
    ]);

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      state: state
        ? { name: state.name, color: state.color, type: state.type }
        : { name: "Unknown", color: "#888888", type: "unstarted" },
      priority: node.priority,
      assignee: assignee ? { name: assignee.name, avatarUrl: assignee.avatarUrl ?? undefined } : undefined,
      labels: labelsResult.nodes.map((l) => ({ name: l.name, color: l.color })),
      updatedAt: node.updatedAt.toISOString(),
      providerUrl: node.url,
    };
  }
}
