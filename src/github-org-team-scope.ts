import { ghAsync } from "./exec.js";

interface GhOrg {
  login: string;
}

interface GhMember {
  login: string;
}

/** Avoid unbounded org rosters blowing up PR fan-out. */
const MAX_ORG_MEMBER_LOGINS = 400;

async function collectOrgMemberLoginsForTrackedRepos(
  repoPaths: string[],
  opts: { excludeLoginLower?: string },
): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const rp of repoPaths) {
    const i = rp.indexOf("/");
    if (i > 0) owners.add(rp.slice(0, i).toLowerCase());
  }
  if (owners.size === 0) return new Set();

  let userOrgs: GhOrg[];
  try {
    userOrgs = await ghAsync<GhOrg[]>("/user/orgs");
  } catch {
    return new Set();
  }

  const orgLoginLower = new Set(userOrgs.map((o) => o.login.toLowerCase()));
  const relevantOrgs = [...owners].filter((o) => orgLoginLower.has(o));
  if (relevantOrgs.length === 0) return new Set();

  const logins = new Set<string>();
  const skip = opts.excludeLoginLower;

  for (const org of relevantOrgs) {
    try {
      const members = await ghAsync<GhMember[]>(`/orgs/${org}/members`);
      for (const m of members) {
        if (!m.login) continue;
        if (skip && m.login.toLowerCase() === skip) continue;
        logins.add(m.login);
        if (logins.size >= MAX_ORG_MEMBER_LOGINS) return logins;
      }
    } catch {
      /* missing scope or not a listed org */
    }
  }

  return logins;
}

/**
 * GitHub logins for org members in organizations that (1) you belong to and (2) own at least one tracked repo.
 * Excludes `viewerLogin`. Uses the default GitHub token (same as sidebar); org membership APIs must be permitted.
 */
export async function discoverTrackedOrgMemberLogins(
  repoPaths: string[],
  viewerLogin: string,
): Promise<Set<string>> {
  return collectOrgMemberLoginsForTrackedRepos(repoPaths, {
    excludeLoginLower: viewerLogin.toLowerCase(),
  });
}

/**
 * All org member logins for tracked-repo owners that intersect your orgs (including yourself), sorted.
 * For team identity UI; same API constraints as {@link discoverTrackedOrgMemberLogins}.
 */
export async function fetchTrackedOrgDirectoryLogins(repoPaths: string[]): Promise<string[]> {
  const logins = await collectOrgMemberLoginsForTrackedRepos(repoPaths, {});
  return [...logins].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
