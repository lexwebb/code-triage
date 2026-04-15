const IDENTIFIER_RE = /\b([A-Za-z]{2,10}-\d+)\b/g;

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
    for (const m of text.matchAll(IDENTIFIER_RE)) {
      const id = m[1]!.toUpperCase();
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
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

/** `owner/repo/pull/123` on any GitHub host; allows `/pull/123/files`, `/commits`, etc. */
export function parseGithubPullRequestUrl(url: string): { repo: string; number: number } | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
    if (!m) return null;
    return { repo: m[1]!, number: parseInt(m[2]!, 10) };
  } catch {
    return null;
  }
}

/** Merge Linear (or other provider) GitHub links into maps built from PR title/branch scraping. */
export function mergeProviderPullLinksIntoLinkMap(
  map: LinkMap,
  ticketIdentifier: string,
  refs: LinkedPRRef[],
): void {
  for (const ref of refs) {
    const prKey = `${ref.repo}#${ref.number}`;
    const ticketIds = map.prToTickets.get(prKey) ?? [];
    if (!ticketIds.includes(ticketIdentifier)) {
      map.prToTickets.set(prKey, [...ticketIds, ticketIdentifier]);
    }
    const existing = map.ticketToPRs.get(ticketIdentifier) ?? [];
    if (!existing.some((r) => r.repo === ref.repo && r.number === ref.number)) {
      map.ticketToPRs.set(ticketIdentifier, [...existing, ref]);
    }
  }
}
