/**
 * Maps GitHub logins and Linear assignees to a single display label for team rollups.
 */

export type TeamMemberLink = {
  /**
   * Display name for this link row, always derived from identities via {@link autoMemberLinkDisplayLabel}
   * (Linear names first, then GitHub logins, then Linear ids). Stored in config for the resolver.
   */
  label: string;
  /** GitHub usernames (PR authors), case-insensitive. */
  githubLogins?: string[];
  /** Linear assignee display names from issues, case-insensitive. */
  linearNames?: string[];
  /** Linear user IDs (from issue assignee); strongest match for tickets. */
  linearUserIds?: string[];
};

export type LinearUserRef = { id: string; name: string };

/** Case-insensitive key for GitHub logins and Linear display names. */
export function normalizeTeamIdentityKey(s: string): string {
  return s.trim().toLowerCase();
}

function norm(s: string): string {
  return normalizeTeamIdentityKey(s);
}

function uniqTrimmedStrings(arr: string[] | undefined): string[] {
  return [...new Set((arr ?? []).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Derives the display label from linked identities: Linear names (sorted, joined), else GitHub logins, else Linear ids.
 */
export function autoMemberLinkDisplayLabel(
  link: Pick<TeamMemberLink, "githubLogins" | "linearNames" | "linearUserIds">,
): string {
  const names = uniqTrimmedStrings(link.linearNames).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  if (names.length > 0) return names.join(" · ");
  const logins = uniqTrimmedStrings(link.githubLogins).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  if (logins.length > 0) return logins.join(" · ");
  const ids = uniqTrimmedStrings(link.linearUserIds);
  if (ids.length > 0) {
    if (ids.length === 1) return `Linear ${ids[0]}`;
    return `Linear (${ids.length} accounts)`;
  }
  return "Teammate";
}

/** True if two link rows share any GitHub login, Linear user id, or Linear name (case-insensitive). */
export function memberLinksIdentityOverlap(a: TeamMemberLink, b: TeamMemberLink): boolean {
  const ghA = new Set((a.githubLogins ?? []).map(norm));
  for (const g of b.githubLogins ?? []) {
    if (ghA.has(norm(g))) return true;
  }
  const idA = new Set((a.linearUserIds ?? []).filter(Boolean));
  for (const id of b.linearUserIds ?? []) {
    if (id && idA.has(id)) return true;
  }
  const nameA = new Set((a.linearNames ?? []).map(norm));
  for (const n of b.linearNames ?? []) {
    if (nameA.has(norm(n))) return true;
  }
  return false;
}

function mergeTwoMemberLinks(a: TeamMemberLink, b: TeamMemberLink): TeamMemberLink {
  const githubLogins = uniqTrimmedStrings([...(a.githubLogins ?? []), ...(b.githubLogins ?? [])]);
  const linearNames = uniqTrimmedStrings([...(a.linearNames ?? []), ...(b.linearNames ?? [])]);
  const linearUserIds = uniqTrimmedStrings([...(a.linearUserIds ?? []), ...(b.linearUserIds ?? [])]);
  const merged: TeamMemberLink = {
    label: "",
    ...(githubLogins.length ? { githubLogins } : {}),
    ...(linearNames.length ? { linearNames } : {}),
    ...(linearUserIds.length ? { linearUserIds } : {}),
  };
  merged.label = autoMemberLinkDisplayLabel(merged);
  return merged;
}

/**
 * Merge one new or edited link into the list: rows that share an identity are combined; label is always auto-derived.
 */
export function mergeTeamMemberLinkIntoList(
  existing: TeamMemberLink[],
  entry: TeamMemberLink,
): TeamMemberLink[] {
  const normalizedEntry: TeamMemberLink = {
    ...entry,
    label: autoMemberLinkDisplayLabel(entry),
  };
  const idx = existing.findIndex((e) => memberLinksIdentityOverlap(e, normalizedEntry));
  if (idx < 0) return [...existing, normalizedEntry];

  const combined = mergeTwoMemberLinks(existing[idx]!, normalizedEntry);
  return [...existing.slice(0, idx), combined, ...existing.slice(idx + 1)];
}

/**
 * Recompute every row’s label and merge rows that share identities. Sorts by label.
 */
export function regenerateMemberLinks(links: TeamMemberLink[]): TeamMemberLink[] {
  if (links.length === 0) return [];
  let list = links.map((l) => ({
    ...l,
    label: autoMemberLinkDisplayLabel(l),
  }));

  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (memberLinksIdentityOverlap(list[i]!, list[j]!)) {
          const merged = mergeTwoMemberLinks(list[i]!, list[j]!);
          list.splice(j, 1);
          list.splice(i, 1, merged);
          changed = true;
          break outer;
        }
      }
    }
  }

  list = list.map((l) => ({ ...l, label: autoMemberLinkDisplayLabel(l) }));
  return list.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export function parseTeamMemberLinksFromUnknown(value: unknown): TeamMemberLink[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!Array.isArray(value)) throw new Error("team.memberLinks must be an array");
  const out: TeamMemberLink[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) throw new Error("team.memberLinks entries must be objects");
    const r = row as Record<string, unknown>;
    const strings = (k: string): string[] | undefined => {
      if (r[k] === undefined) return undefined;
      if (!Array.isArray(r[k])) throw new Error(`team.memberLinks[].${k} must be an array of strings`);
      return (r[k] as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean);
    };
    const githubLogins = strings("githubLogins");
    const linearNames = strings("linearNames");
    const linearUserIds = strings("linearUserIds");
    const hasAny =
      (githubLogins?.length ?? 0) + (linearNames?.length ?? 0) + (linearUserIds?.length ?? 0) > 0;
    if (!hasAny) {
      throw new Error(
        "team.memberLinks[] needs at least one of githubLogins, linearNames, linearUserIds",
      );
    }
    const base: TeamMemberLink = {
      label: "",
      ...(githubLogins?.length ? { githubLogins } : {}),
      ...(linearNames?.length ? { linearNames } : {}),
      ...(linearUserIds?.length ? { linearUserIds } : {}),
    };
    base.label = autoMemberLinkDisplayLabel(base);
    out.push(base);
  }
  return out.length > 0 ? regenerateMemberLinks(out) : undefined;
}

export function createTeamMemberIdentityResolver(
  links: TeamMemberLink[] | undefined,
  linearUsers: LinearUserRef[] | undefined,
): { resolve: (raw: string, opts?: { linearUserId?: string | null }) => string } {
  const byGithub = new Map<string, string>();
  const byLinearName = new Map<string, string>();
  const byLinearId = new Map<string, string>();

  for (const row of links ?? []) {
    const label = row.label.trim();
    if (!label) continue;
    for (const g of row.githubLogins ?? []) {
      const k = norm(g);
      if (k) byGithub.set(k, label);
    }
    for (const n of row.linearNames ?? []) {
      const k = norm(n);
      if (k) byLinearName.set(k, label);
    }
    for (const id of row.linearUserIds ?? []) {
      if (id) byLinearId.set(id, label);
    }
  }

  for (const u of linearUsers ?? []) {
    const id = u.id?.trim();
    const display = u.name?.trim();
    if (id && display && !byLinearId.has(id)) {
      byLinearId.set(id, display);
    }
    const kn = display ? norm(display) : "";
    if (kn && !byLinearName.has(kn)) {
      byLinearName.set(kn, display);
    }
  }

  function resolve(raw: string, opts?: { linearUserId?: string | null }): string {
    const id = opts?.linearUserId?.trim();
    if (id && byLinearId.has(id)) {
      return byLinearId.get(id)!;
    }
    const r = raw.trim();
    if (!r || r === "Unassigned") return r || "Unassigned";
    const nk = norm(r);
    if (byGithub.has(nk)) return byGithub.get(nk)!;
    if (byLinearName.has(nk)) return byLinearName.get(nk)!;
    return r;
  }

  return { resolve };
}
