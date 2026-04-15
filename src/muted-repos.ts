/** Normalize `owner/repo` for comparing muted-repo config (GitHub owner is case-insensitive). */
export function normalizeRepoMuteKey(repo: string): string {
  return repo.trim().toLowerCase();
}

export function mutedReposAsSet(fromConfig: string[] | undefined): Set<string> {
  return new Set((fromConfig ?? []).map(normalizeRepoMuteKey).filter((k) => k.length > 0));
}

export function filterPullRowsByMutedRepos<T extends { repo: string }>(rows: T[], muted: Set<string>): T[] {
  if (muted.size === 0) return rows;
  return rows.filter((r) => !muted.has(normalizeRepoMuteKey(r.repo)));
}

/** Sidebar rows typed as loose records; skips rows without a string `repo`. */
export function filterSidebarRecordsByMutedRepos(
  rows: Array<Record<string, unknown>>,
  muted: Set<string>,
): Array<Record<string, unknown>> {
  if (muted.size === 0) return rows;
  return rows.filter((row) => {
    const repo = typeof row.repo === "string" ? row.repo : "";
    if (!repo) return true;
    return !muted.has(normalizeRepoMuteKey(repo));
  });
}

/** Drop PR refs whose `repo` is muted (ticket → PR link map). */
export function filterTicketToPRsRecordForMutedRepos<T extends { repo: string }>(
  ticketToPRs: Record<string, T[]>,
  muted: Set<string>,
): Record<string, T[]> {
  if (muted.size === 0) return ticketToPRs;
  const out: Record<string, T[]> = {};
  for (const [tid, refs] of Object.entries(ticketToPRs)) {
    const filtered = refs.filter((r) => !muted.has(normalizeRepoMuteKey(r.repo)));
    if (filtered.length > 0) out[tid] = filtered;
  }
  return out;
}

/** Drop `owner/repo#n` keys whose repo is muted (PR → tickets map). */
export function filterPrToTicketsRecordForMutedRepos(
  prToTickets: Record<string, string[]>,
  muted: Set<string>,
): Record<string, string[]> {
  if (muted.size === 0) return prToTickets;
  const out: Record<string, string[]> = {};
  for (const [prKey, tickets] of Object.entries(prToTickets)) {
    const hash = prKey.indexOf("#");
    const repoPart = hash >= 0 ? prKey.slice(0, hash) : prKey;
    if (muted.has(normalizeRepoMuteKey(repoPart))) continue;
    out[prKey] = tickets;
  }
  return out;
}
