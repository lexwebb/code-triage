import { createHash } from "node:crypto";
import { runPrCompanionPrompt } from "../actioner.js";
import { log } from "../logger.js";
import type { TicketIssue } from "../tickets/types.js";
import type { LinearUserRef, TeamMemberLink } from "./member-identity.js";
import { autoMemberLinkDisplayLabel, normalizeTeamIdentityKey, regenerateMemberLinks } from "./member-identity.js";

const MAX_GITHUB_IN_PROMPT = 64;
const MAX_LINEAR_IN_PROMPT = 160;

function sidebarAuthorLogin(row: Record<string, unknown>): string | undefined {
  const a = row.author;
  return typeof a === "string" && a.trim() ? a.trim() : undefined;
}

/** Unique GitHub logins appearing as PR authors in snapshot inputs. */
export function collectGithubLoginsForMemberLinking(
  authored: Array<Record<string, unknown>>,
  reviewRequested: Array<Record<string, unknown>>,
  recentlyMerged: Array<{ authorLogin?: string }>,
): string[] {
  const out = new Set<string>();
  for (const row of [...authored, ...reviewRequested]) {
    const a = sidebarAuthorLogin(row);
    if (a) out.add(a);
  }
  for (const m of recentlyMerged) {
    const a = m.authorLogin?.trim();
    if (a) out.add(a);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function isGithubLoginCoveredByMemberLinks(login: string, links: TeamMemberLink[]): boolean {
  const k = normalizeTeamIdentityKey(login);
  if (!k) return false;
  return links.some((row) => (row.githubLogins ?? []).some((g) => normalizeTeamIdentityKey(g) === k));
}

export function isLinearAssigneeCoveredByMemberLinks(
  assignee: { id?: string; name?: string } | undefined,
  links: TeamMemberLink[],
): boolean {
  if (!assignee) return true;
  const id = assignee.id?.trim();
  if (id && links.some((row) => (row.linearUserIds ?? []).includes(id))) {
    return true;
  }
  const name = assignee.name?.trim();
  if (!name) return true;
  const nk = normalizeTeamIdentityKey(name);
  return links.some((row) => (row.linearNames ?? []).some((n) => normalizeTeamIdentityKey(n) === nk));
}

export function listUnrecognisedGithubLogins(githubLogins: string[], links: TeamMemberLink[]): string[] {
  return githubLogins.filter((g) => !isGithubLoginCoveredByMemberLinks(g, links));
}

export function hasUncoveredLinearAssigneeOnTickets(tickets: TicketIssue[], links: TeamMemberLink[]): boolean {
  const seen = new Set<string>();
  for (const t of tickets) {
    if (seen.has(t.identifier)) continue;
    seen.add(t.identifier);
    if (!isLinearAssigneeCoveredByMemberLinks(t.assignee, links)) return true;
  }
  return false;
}

/** Stable keys for assignees that still need a link (for Claude job fingerprinting). */
export function collectUncoveredAssigneeKeys(tickets: TicketIssue[], links: TeamMemberLink[]): string[] {
  const keys = new Set<string>();
  const seen = new Set<string>();
  for (const t of tickets) {
    if (seen.has(t.identifier)) continue;
    seen.add(t.identifier);
    if (isLinearAssigneeCoveredByMemberLinks(t.assignee, links)) continue;
    const a = t.assignee;
    if (!a) continue;
    const id = a.id?.trim();
    if (id) keys.add(`id:${id}`);
    else if (a.name?.trim()) keys.add(`name:${normalizeTeamIdentityKey(a.name)}`);
  }
  return [...keys].sort();
}

/**
 * Fingerprint for "do we need a Claude member-link call and is cache still valid".
 * Changes when manual links change, or the set of unrecognised GitHub logins / uncovered assignees changes.
 */
export function memberLinkClaudeJobFingerprint(
  manual: TeamMemberLink[] | undefined,
  unrecognisedGithub: string[],
  uncoveredAssigneeKeys: string[],
): string {
  const manualNorm = JSON.stringify(manual ?? []);
  const g = [...new Set(unrecognisedGithub.map((s) => normalizeTeamIdentityKey(s)))].filter(Boolean).sort();
  const u = [...uncoveredAssigneeKeys];
  return createHash("sha256").update(JSON.stringify({ m: manualNorm, g, u })).digest("hex").slice(0, 32);
}

/**
 * Manual `memberLinks` win. Claude rows are appended only when they introduce no identifier
 * that already maps to a different label.
 */
export function mergeManualAndClaudeMemberLinks(
  manual: TeamMemberLink[] | undefined,
  claude: TeamMemberLink[],
): TeamMemberLink[] {
  const out: TeamMemberLink[] = (manual ?? []).map((r) => ({
    ...r,
    label: autoMemberLinkDisplayLabel(r),
  }));
  const byGh = new Map<string, string>();
  const byLid = new Map<string, string>();
  const byLname = new Map<string, string>();

  const register = (row: TeamMemberLink) => {
    const L = row.label.trim();
    if (!L) return;
    for (const g of row.githubLogins ?? []) {
      const k = normalizeTeamIdentityKey(g);
      if (k) byGh.set(k, L);
    }
    for (const id of row.linearUserIds ?? []) {
      if (id) byLid.set(id.trim(), L);
    }
    for (const n of row.linearNames ?? []) {
      const k = normalizeTeamIdentityKey(n);
      if (k) byLname.set(k, L);
    }
  };

  for (const row of out) register(row);

  for (const row of claude) {
    const normalized: TeamMemberLink = { ...row, label: autoMemberLinkDisplayLabel(row) };
    const L = normalized.label.trim();
    if (!L) continue;
    let conflict = false;
    for (const g of normalized.githubLogins ?? []) {
      const k = normalizeTeamIdentityKey(g);
      const ex = k ? byGh.get(k) : undefined;
      if (ex && ex !== L) conflict = true;
    }
    for (const id of normalized.linearUserIds ?? []) {
      const ex = byLid.get(id.trim());
      if (ex && ex !== L) conflict = true;
    }
    for (const n of normalized.linearNames ?? []) {
      const k = normalizeTeamIdentityKey(n);
      const ex = k ? byLname.get(k) : undefined;
      if (ex && ex !== L) conflict = true;
    }
    if (conflict) continue;

    let skipDuplicate = true;
    let anyIdentifier = false;
    for (const g of normalized.githubLogins ?? []) {
      const k = normalizeTeamIdentityKey(g);
      if (!k) continue;
      anyIdentifier = true;
      if (byGh.get(k) !== L) skipDuplicate = false;
    }
    for (const id of normalized.linearUserIds ?? []) {
      anyIdentifier = true;
      if (byLid.get(id.trim()) !== L) skipDuplicate = false;
    }
    for (const n of normalized.linearNames ?? []) {
      const k = normalizeTeamIdentityKey(n);
      if (!k) continue;
      anyIdentifier = true;
      if (byLname.get(k) !== L) skipDuplicate = false;
    }
    if (anyIdentifier && skipDuplicate) continue;

    out.push(normalized);
    register(normalized);
  }

  return regenerateMemberLinks(out);
}

function parseJsonLenient(raw: string): unknown {
  const t = raw.trim();
  try {
    const o = JSON.parse(t) as { result?: unknown };
    if (o && typeof o === "object" && typeof o.result === "string") {
      try {
        return JSON.parse(o.result.trim());
      } catch {
        /* fall through */
      }
    }
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*"links"[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]!);
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function validateClaudeMemberLinkRows(
  parsed: unknown,
  allowedGithub: string[],
  linearUsers: LinearUserRef[],
): TeamMemberLink[] {
  if (!parsed || typeof parsed !== "object") return [];
  const links = (parsed as Record<string, unknown>).links;
  if (!Array.isArray(links)) return [];

  const ghSet = new Set(allowedGithub.map((g) => normalizeTeamIdentityKey(g)));
  const idSet = new Set(linearUsers.map((u) => u.id));
  const nameByNorm = new Map<string, string>();
  for (const u of linearUsers) {
    nameByNorm.set(normalizeTeamIdentityKey(u.name), u.name.trim());
  }

  const out: TeamMemberLink[] = [];
  for (const row of links) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;

    const pick = (k: string): string[] => {
      if (!Array.isArray(r[k])) return [];
      return (r[k] as unknown[])
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean);
    };

    const githubLogins = pick("githubLogins").filter((g) => ghSet.has(normalizeTeamIdentityKey(g)));
    const linearUserIds = pick("linearUserIds").filter((id) => idSet.has(id));
    const linearNamesRaw = pick("linearNames");
    const linearNames = linearNamesRaw
      .map((n) => nameByNorm.get(normalizeTeamIdentityKey(n)))
      .filter((n): n is string => Boolean(n));

    if (githubLogins.length === 0 && linearUserIds.length === 0 && linearNames.length === 0) continue;

    const built: TeamMemberLink = {
      label: "",
      ...(githubLogins.length ? { githubLogins } : {}),
      ...(linearUserIds.length ? { linearUserIds } : {}),
      ...(linearNames.length ? { linearNames } : {}),
    };
    built.label = autoMemberLinkDisplayLabel(built);
    out.push(built);
  }
  return out;
}

export async function suggestMemberLinksWithClaude(
  githubLogins: string[],
  linearUsers: LinearUserRef[],
): Promise<TeamMemberLink[]> {
  if (githubLogins.length === 0 || linearUsers.length === 0) return [];

  const ghList = [...githubLogins].slice(0, MAX_GITHUB_IN_PROMPT);
  const linList = [...linearUsers].slice(0, MAX_LINEAR_IN_PROMPT);

  const ghBlock = ghList.map((g) => `- ${g}`).join("\n");
  const linBlock = linList.map((u) => `- ${u.id} — ${u.name}`).join("\n");

  const prompt = `You are helping match GitHub users to Linear workspace users for a team dashboard. The same human may use a short GitHub login and a full name in Linear.

GitHub logins seen as PR authors (use EXACTLY these strings in githubLogins):
${ghBlock}

Linear users (use EXACT ids and names from this list):
${linBlock}

Task: propose high-confidence matches only — same person (name variations, initials, obvious nicknames). Each matched person should appear in at most one object.

Output ONLY valid JSON (no markdown) with this exact shape:
{"links":[{"label":"Display Name","githubLogins":["login1"],"linearUserIds":["linear-id"],"linearNames":["Name from list"]}]}

Rules:
- "label" is optional and ignored; display names are derived from Linear names, then GitHub logins, then Linear ids.
- Include at least one of githubLogins / linearUserIds / linearNames per link; prefer including both GitHub and Linear ids when confident.
- linearUserIds must be copied exactly from the Linear list above.
- githubLogins must be copied exactly from the GitHub list above.
- linearNames must match a name from the Linear list (same spelling as shown after the em dash).
- If unsure, omit the pair entirely. Fewer links is better than wrong links.
- If there are no confident matches, return {"links":[]}.`;

  try {
    const raw = await runPrCompanionPrompt(prompt);
    const parsed = parseJsonLenient(raw);
    if (parsed == null) {
      log.warn("[team] Claude member-link response was not JSON; skipping auto links.");
      return [];
    }
    return validateClaudeMemberLinkRows(parsed, ghList, linList);
  } catch (e) {
    log.warn(`[team] Claude member-link failed: ${(e as Error).message}`);
    return [];
  }
}
