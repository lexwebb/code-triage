import type { AppConfigPayload, TeamMemberSummaryIdentityHint } from "../api";
import { mergeTeamMemberLinkIntoList } from "../../../src/team/member-identity";

type MemberLink = AppConfigPayload["team"]["memberLinks"][number];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function hintCoveredByMemberLinks(h: TeamMemberSummaryIdentityHint, links: MemberLink[]): boolean {
  if (h.kind === "github") {
    return links.some((l) => l.githubLogins?.some((g) => norm(g) === norm(h.login)));
  }
  const uid = h.userId;
  const idHit = Boolean(uid && links.some((l) => l.linearUserIds?.includes(uid)));
  const nameHit = links.some((l) => l.linearNames?.some((n) => norm(n) === norm(h.name)));
  return idHit || nameHit;
}

export function uncoveredIdentityHints(
  hints: TeamMemberSummaryIdentityHint[] | undefined,
  links: MemberLink[] | undefined,
): TeamMemberSummaryIdentityHint[] {
  if (!hints?.length) return [];
  const list = links ?? [];
  return hints.filter((h) => !hintCoveredByMemberLinks(h, list));
}

export function memberSummaryNeedsIdentityLink(
  hints: TeamMemberSummaryIdentityHint[] | undefined,
  links: MemberLink[] | undefined,
): boolean {
  return uncoveredIdentityHints(hints, links).length > 0;
}

export function mergeTeamMemberLink(existing: MemberLink[], entry: MemberLink): MemberLink[] {
  return mergeTeamMemberLinkIntoList(existing, entry) as MemberLink[];
}
