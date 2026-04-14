export interface TicketIssue {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; color: string; type: string };
  priority: number;
  assignee?: { name: string; avatarUrl?: string };
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
}
