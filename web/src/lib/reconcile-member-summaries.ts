import type {
  TeamMemberSummaryIdentityHint,
  TeamMemberSummaryItem,
  TeamOverviewSnapshot,
} from "../api";
import {
  createTeamMemberIdentityResolver,
  normalizeTeamIdentityKey,
  type TeamMemberLink,
} from "../../../src/team/member-identity.js";

type SummaryRow = NonNullable<TeamOverviewSnapshot["memberSummaries"]>[number];

function hintKey(h: TeamMemberSummaryIdentityHint): string {
  if (h.kind === "github") return `g:${normalizeTeamIdentityKey(h.login)}`;
  return `l:${h.userId ?? ""}:${normalizeTeamIdentityKey(h.name)}`;
}

function dedupeHints(
  hints: TeamMemberSummaryIdentityHint[] | undefined,
): TeamMemberSummaryIdentityHint[] | undefined {
  if (!hints?.length) return undefined;
  const m = new Map<string, TeamMemberSummaryIdentityHint>();
  for (const h of hints) m.set(hintKey(h), h);
  const out = [...m.values()];
  return out.length ? out : undefined;
}

function resolvedLabelForRow(
  row: SummaryRow,
  resolve: (raw: string, opts?: { linearUserId?: string | null }) => string,
): string {
  const hints = row.identityHints;
  if (!hints?.length) return row.memberLabel;
  const labels = new Set<string>();
  for (const h of hints) {
    if (h.kind === "github") labels.add(resolve(h.login));
    else labels.add(resolve(h.name, { linearUserId: h.userId }));
  }
  if (labels.size === 1) return [...labels][0]!;
  return row.memberLabel;
}

function dedupeSummaryItems<T extends TeamMemberSummaryItem | { title: string; ref: string; waitLabel?: string }>(
  items: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const id =
      "entityIdentifier" in it && typeof it.entityIdentifier === "string"
        ? `${"entityKind" in it ? String(it.entityKind) : "legacy"}\0${it.entityIdentifier}`
        : `legacy\0${(it as { ref: string }).ref}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

/**
 * Re-apply `team.memberLinks` to cached snapshot member rows so labels and merged accordions
 * update immediately after saving links, without rebuilding the team snapshot on the server.
 */
export function reconcileMemberSummariesForDisplay(
  rows: SummaryRow[] | undefined,
  memberLinks: TeamMemberLink[] | undefined,
): SummaryRow[] {
  if (!rows?.length) return [];
  const { resolve } = createTeamMemberIdentityResolver(memberLinks, undefined);

  const relabeled = rows.map((row) => ({
    ...row,
    memberLabel: resolvedLabelForRow(row, resolve),
  }));

  const byLabel = new Map<string, SummaryRow>();
  for (const row of relabeled) {
    const key = row.memberLabel.toLowerCase();
    const existing = byLabel.get(key);
    if (!existing) {
      byLabel.set(key, {
        ...row,
        workingOn: dedupeSummaryItems([...row.workingOn]) as SummaryRow["workingOn"],
        waiting: dedupeSummaryItems([...row.waiting]) as SummaryRow["waiting"],
        comingUp: dedupeSummaryItems([...row.comingUp]) as SummaryRow["comingUp"],
        identityHints: dedupeHints(row.identityHints),
      });
    } else {
      existing.aiDigest = undefined;
      existing.workingOn = dedupeSummaryItems([
        ...existing.workingOn,
        ...row.workingOn,
      ]) as SummaryRow["workingOn"];
      existing.waiting = dedupeSummaryItems([
        ...existing.waiting,
        ...row.waiting,
      ]) as SummaryRow["waiting"];
      existing.comingUp = dedupeSummaryItems([
        ...existing.comingUp,
        ...row.comingUp,
      ]) as SummaryRow["comingUp"];
      existing.identityHints = dedupeHints([
        ...(existing.identityHints ?? []),
        ...(row.identityHints ?? []),
      ]);
    }
  }

  return [...byLabel.values()].sort((a, b) => a.memberLabel.localeCompare(b.memberLabel));
}
