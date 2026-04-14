const IDENTIFIER_RE = /\b([A-Z]{2,10}-\d+)\b/;

export interface LinkablePR {
  number: number;
  repo: string;
  branch: string;
  title: string;
  body: string;
}

export interface LinkedPRRef {
  number: number;
  repo: string;
  title: string;
}

export interface LinkMap {
  ticketToPRs: Map<string, LinkedPRRef[]>;
  prToTickets: Map<string, string[]>;
}

export function extractTicketIdentifiers(pr: LinkablePR): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const text of [pr.branch, pr.title, pr.body]) {
    const match = text.match(IDENTIFIER_RE);
    if (match && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      result.push(match[1]!);
    }
  }

  return result;
}

export function buildLinkMap(prs: LinkablePR[], validIdentifiers: Set<string>): LinkMap {
  const ticketToPRs = new Map<string, LinkedPRRef[]>();
  const prToTickets = new Map<string, string[]>();

  for (const pr of prs) {
    const identifiers = extractTicketIdentifiers(pr).filter((id) => validIdentifiers.has(id));
    if (identifiers.length === 0) continue;

    const prKey = `${pr.repo}#${pr.number}`;
    prToTickets.set(prKey, identifiers);

    for (const id of identifiers) {
      const refs = ticketToPRs.get(id) ?? [];
      refs.push({ number: pr.number, repo: pr.repo, title: pr.title });
      ticketToPRs.set(id, refs);
    }
  }

  return { ticketToPRs, prToTickets };
}
