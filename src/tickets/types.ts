export interface TicketIssue {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; color: string; type: string };
  /** Provider-derived terminal marker (e.g. Linear completedAt/canceledAt). */
  isDone?: boolean;
  /** GitHub PRs linked in the ticket provider (e.g. Linear attachments). */
  providerLinkedPulls?: Array<{ number: number; repo: string; title: string }>;
  priority: number;
  assignee?: { id?: string; name: string; avatarUrl?: string };
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  providerUrl: string;
}

export interface TicketComment {
  id: string;
  body: string;
  author: { name: string; avatarUrl?: string };
  createdAt: string;
}

export interface TicketIssueDetail extends TicketIssue {
  description?: string;
  comments: TicketComment[];
}

export interface TicketTeam {
  id: string;
  key: string;
  name: string;
}

export interface TicketUser {
  id: string;
  name: string;
  email: string;
}

export interface TicketProvider {
  fetchMyIssues(): Promise<TicketIssue[]>;
  fetchIssuesByIdentifiers(identifiers: string[]): Promise<TicketIssue[]>;
  getIssueDetail(id: string): Promise<TicketIssueDetail>;
  getCurrentUser(): Promise<TicketUser>;
  getTeams(): Promise<TicketTeam[]>;
  /** Linear workspace directory for team identity rollups; optional on providers that do not support it. */
  listWorkspaceUsers?(): Promise<Array<{ id: string; name: string }>>;
  /**
   * Active issues for the configured team filter (e.g. `linearTeamKeys`), not restricted to the viewer.
   * Implementations should enforce `maxIssues`.
   */
  fetchTeamScopeIssues?(maxIssues: number): Promise<TicketIssue[]>;
}
