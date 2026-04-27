import { createHash } from "node:crypto";
import { log } from "../logger.js";
import { runPrCompanionPrompt } from "../actioner.js";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { openStateDatabase } from "../db/client.js";
import type { TeamMemberSummaryItem, TeamOverviewSnapshot } from "./overview.js";

type SummaryRow = NonNullable<TeamOverviewSnapshot["memberSummaries"]>[number];

type DigestRow = { work_fingerprint: string; summary_json: string; generated_at_ms: number };

/** Ignore PRs/tickets with last activity older than this vs snapshot time (30 days). */
export const MEMBER_DIGEST_MAX_ITEM_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function itemIncludedInMemberDigest(
  item: TeamMemberSummaryItem,
  referenceTimeMs: number,
  maxAgeMs: number = MEMBER_DIGEST_MAX_ITEM_AGE_MS,
): boolean {
  if (!item.activityAt) return true;
  const t = Date.parse(item.activityAt);
  if (!Number.isFinite(t)) return true;
  return referenceTimeMs - t <= maxAgeMs;
}

function digestViewOfRow(
  row: Pick<SummaryRow, "workingOn" | "waiting" | "comingUp">,
  referenceTimeMs: number,
): Pick<SummaryRow, "workingOn" | "waiting" | "comingUp"> {
  return {
    workingOn: row.workingOn.filter((i) => itemIncludedInMemberDigest(i, referenceTimeMs)),
    waiting: row.waiting.filter((i) => itemIncludedInMemberDigest(i, referenceTimeMs)),
    comingUp: row.comingUp.filter((i) => itemIncludedInMemberDigest(i, referenceTimeMs)),
  };
}

function digestKeyForItem(
  bucket: "workingOn" | "waiting" | "comingUp",
  item: TeamMemberSummaryItem,
): Record<string, unknown> {
  return {
    bucket,
    entityKind: item.entityKind,
    entityIdentifier: item.entityIdentifier,
    title: item.title.trim(),
    lifecycleStage: item.lifecycleStage ?? "",
    lifecycleStuck: Boolean(item.lifecycleStuck),
    waitLabel: item.waitLabel ?? "",
  };
}

/**
 * Stable fingerprint of a teammate's **recent** PR/ticket rows (same 30-day window as Claude);
 * only meaningful fields that reflect status.
 */
export function memberSummaryWorkFingerprint(
  row: Pick<SummaryRow, "workingOn" | "waiting" | "comingUp">,
  referenceTimeMs: number,
): string {
  const v = digestViewOfRow(row, referenceTimeMs);
  const parts: Record<string, unknown>[] = [];
  for (const item of v.workingOn) {
    parts.push(digestKeyForItem("workingOn", item));
  }
  for (const item of v.waiting) {
    parts.push(digestKeyForItem("waiting", item));
  }
  for (const item of v.comingUp) {
    parts.push(digestKeyForItem("comingUp", item));
  }
  parts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const canonical = JSON.stringify(parts);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** Fingerprint over all teammates' digest-eligible work sets. */
export function teamMemberWorkAggregateFingerprint(rows: SummaryRow[] | undefined, referenceTimeMs: number): string {
  if (!rows?.length) return createHash("sha256").update("").digest("hex").slice(0, 32);
  const pairs = rows
    .map((r) => `${r.memberLabel}\0${memberSummaryWorkFingerprint(r, referenceTimeMs)}`)
    .sort((a, b) => a.localeCompare(b));
  return createHash("sha256").update(pairs.join("\n")).digest("hex").slice(0, 32);
}

export function readMemberAiDigestFromDb(memberLabel: string): DigestRow | null {
  const row = openStateDatabase()
    .select({
      work_fingerprint: schema.teamMemberAiDigest.workFingerprint,
      summary_json: schema.teamMemberAiDigest.summaryJson,
      generated_at_ms: schema.teamMemberAiDigest.generatedAtMs,
    })
    .from(schema.teamMemberAiDigest)
    .where(eq(schema.teamMemberAiDigest.memberLabel, memberLabel))
    .get();
  return row ?? null;
}

export function writeMemberAiDigestToDb(memberLabel: string, workFingerprint: string, bullets: string[]): void {
  const now = Date.now();
  openStateDatabase()
    .insert(schema.teamMemberAiDigest)
    .values({
      memberLabel,
      workFingerprint,
      summaryJson: JSON.stringify(bullets),
      generatedAtMs: now,
    })
    .onConflictDoUpdate({
      target: schema.teamMemberAiDigest.memberLabel,
      set: {
        workFingerprint,
        summaryJson: JSON.stringify(bullets),
        generatedAtMs: now,
      },
    })
    .run();
}

export function deleteMemberAiDigestFromDb(memberLabel: string): void {
  openStateDatabase()
    .delete(schema.teamMemberAiDigest)
    .where(eq(schema.teamMemberAiDigest.memberLabel, memberLabel))
    .run();
}

function formatMemberBlock(row: SummaryRow, referenceTimeMs: number): string {
  const v = digestViewOfRow(row, referenceTimeMs);
  const lines: string[] = [];
  const pushBucket = (label: string, items: TeamMemberSummaryItem[]) => {
    if (!items.length) return;
    lines.push(`${label}:`);
    for (const it of items) {
      const stage = it.lifecycleStage ? ` [${it.lifecycleStage}]` : "";
      const stuck = it.lifecycleStuck ? " (stuck)" : "";
      const wait = it.waitLabel ? ` — ${it.waitLabel}` : "";
      lines.push(
        `  - ${it.entityKind.toUpperCase()} ${it.entityIdentifier}: ${it.title.trim()}${stage}${stuck}${wait}`,
      );
    }
  };
  pushBucket("Working on", v.workingOn);
  pushBucket("Waiting / blocked", v.waiting);
  pushBucket("Coming up", v.comingUp);
  return lines.join("\n");
}

function parseDigestResponse(raw: string): Record<string, string[]> {
  const t = raw.trim();
  let parsed: unknown;
  try {
    const o = JSON.parse(t) as { result?: unknown };
    if (o && typeof o === "object" && typeof o.result === "string") {
      try {
        parsed = JSON.parse(o.result.trim());
      } catch {
        parsed = JSON.parse(t);
      }
    } else {
      parsed = JSON.parse(t);
    }
  } catch {
    const m = t.match(/\{[\s\S]*"summaries"[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]!);
      } catch {
        return {};
      }
    } else {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object") return {};
  const summaries = (parsed as Record<string, unknown>).summaries;
  if (!Array.isArray(summaries)) return {};
  const out: Record<string, string[]> = {};
  for (const entry of summaries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const label = typeof e.memberLabel === "string" ? e.memberLabel.trim() : "";
    if (!label) continue;
    const bulletsRaw = e.bullets;
    if (!Array.isArray(bulletsRaw)) continue;
    const bullets = bulletsRaw
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (bullets.length) out[label] = bullets;
  }
  return out;
}

const MAX_MEMBERS_PER_PROMPT = 10;

/**
 * Fills `row.aiDigest` from SQLite when work fingerprint matches; otherwise batches Claude to refresh summaries.
 * Mutates `snapshot.memberSummaries` in place.
 */
export async function enrichMemberSummariesWithAiDigests(snapshot: TeamOverviewSnapshot): Promise<void> {
  const rows = snapshot.memberSummaries;
  if (!rows?.length) return;

  const parsedRef = Date.parse(snapshot.generatedAt);
  const referenceTimeMs = Number.isFinite(parsedRef) ? parsedRef : Date.now();

  snapshot.teamMemberAiDigestInputFingerprint = teamMemberWorkAggregateFingerprint(rows, referenceTimeMs);

  type Pending = { row: SummaryRow; fingerprint: string };
  const pending: Pending[] = [];

  for (const row of rows) {
    const fingerprint = memberSummaryWorkFingerprint(row, referenceTimeMs);
    const v = digestViewOfRow(row, referenceTimeMs);
    const total = v.workingOn.length + v.waiting.length + v.comingUp.length;
    if (total === 0) {
      deleteMemberAiDigestFromDb(row.memberLabel);
      row.aiDigest = undefined;
      continue;
    }

    const cached = readMemberAiDigestFromDb(row.memberLabel);
    if (cached && cached.work_fingerprint === fingerprint) {
      try {
        const bullets = JSON.parse(cached.summary_json) as unknown;
        row.aiDigest = {
          bullets: Array.isArray(bullets)
            ? bullets.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
            : [],
          workFingerprint: fingerprint,
          generatedAt: new Date(cached.generated_at_ms).toISOString(),
        };
      } catch {
        pending.push({ row, fingerprint });
      }
      continue;
    }
    pending.push({ row, fingerprint });
  }

  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += MAX_MEMBERS_PER_PROMPT) {
    const chunk = pending.slice(i, i + MAX_MEMBERS_PER_PROMPT);
    const blocks = chunk
      .map(
        (p) =>
          `## Teammate: ${p.row.memberLabel}\n` +
          `Use this exact memberLabel in your JSON output.\n\n${formatMemberBlock(p.row, referenceTimeMs)}`,
      )
      .join("\n\n---\n\n");

    const prompt = `You are summarizing engineering work for a team dashboard. For each teammate below, read their open PRs and Linear-style tickets (with lifecycle stage if shown) and write a short status summary.

${blocks}

Output ONLY valid JSON (no markdown fences) with this shape:
{"summaries":[{"memberLabel":"<exact label from header>","bullets":["2–4 concise bullet points","..."]}]}

Rules:
- One entry per teammate listed above; memberLabel must match exactly (case-sensitive).
- Bullets: what they are actively doing, what is blocked or waiting, and notable upcoming work. No more than 4 bullets per person.
- If a teammate only has "Coming up" items, say that clearly.
- Only discuss work listed above (already filtered to roughly the last 30 days of activity).
- Do not invent work not listed. Be professional and terse.`;

    try {
      const raw = await runPrCompanionPrompt(prompt);
      const byLabel = parseDigestResponse(raw);
      const nowIso = new Date().toISOString();
      for (const p of chunk) {
        const bullets = byLabel[p.row.memberLabel] ?? [];
        if (bullets.length === 0) {
          log.warn(`[team] Claude member summary empty for ${p.row.memberLabel}; skipping cache write.`);
          p.row.aiDigest = undefined;
          continue;
        }
        writeMemberAiDigestToDb(p.row.memberLabel, p.fingerprint, bullets);
        p.row.aiDigest = {
          bullets,
          workFingerprint: p.fingerprint,
          generatedAt: nowIso,
        };
      }
    } catch (e) {
      log.warn(`[team] Claude member summaries batch failed: ${(e as Error).message}`);
      for (const p of chunk) {
        p.row.aiDigest = undefined;
      }
    }
  }
}
