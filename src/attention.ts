import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import * as schema from "./db/schema.js";
import { openStateDatabase } from "./db/client.js";
import type { CoherenceAlert } from "./coherence.js";

/** Set `CODE_TRIAGE_LOG_ATTENTION=0` to silence `[attention]` / `[coherence]` poll logs. Skipped when `NODE_ENV=test`. Emits on stderr so lines stay visible under the Ink TUI (stdout). */
export function shouldLogAttentionPipeline(): boolean {
  return process.env.NODE_ENV !== "test" && process.env.CODE_TRIAGE_LOG_ATTENTION !== "0";
}

/** stderr so logs survive Ink (full-screen TUI on stdout). */
function attentionLog(...args: unknown[]): void {
  console.error(...args);
}

export interface AttentionItem {
  id: string;
  type: string;
  entityKind: "pr" | "ticket";
  entityIdentifier: string;
  priority: "high" | "medium" | "low";
  title: string;
  stage?: string;
  stuckSince?: string;
  firstSeenAt: string;
  snoozedUntil?: string;
  dismissedAt?: string;
  pinned: boolean;
}

export function refreshAttentionFeed(alerts: CoherenceAlert[]): { added: number; removed: number } {
  const database = openStateDatabase();
  const now = new Date().toISOString();
  const activeIds = new Set(alerts.map((a) => a.id));
  const existing = database.select({ id: schema.attentionItems.id }).from(schema.attentionItems).all();
  const existingIds = new Set(existing.map((e) => e.id));

  if (shouldLogAttentionPipeline()) {
    const incomingFingerprint = [...activeIds].sort().join("|");
    attentionLog(
      `[attention] sync start: db_rows=${existing.length} incoming_alerts=${alerts.length} fingerprint_len=${incomingFingerprint.length}`,
    );
    if (alerts.length > 0 && alerts.length <= 15) {
      attentionLog(
        `[attention]   incoming: ${alerts.map((a) => `${a.id}(${a.type}:${a.entityIdentifier})`).join("; ")}`,
      );
    }
  }

  let added = 0;
  let removed = 0;

  database.transaction((tx) => {
    for (const row of existing) {
      if (!activeIds.has(row.id)) {
        tx.delete(schema.attentionItems).where(eq(schema.attentionItems.id, row.id)).run();
        removed += 1;
      }
    }

    for (const alert of alerts) {
      if (!existingIds.has(alert.id)) {
        added += 1;
      }
      tx.insert(schema.attentionItems)
        .values({
          id: alert.id,
          type: alert.type,
          entityKind: alert.entityKind,
          entityIdentifier: alert.entityIdentifier,
          priority: alert.priority,
          title: alert.title,
          stage: alert.stage ?? null,
          stuckSince: alert.stuckSince ?? null,
          firstSeenAt: now,
          pinned: 0,
        })
        .onConflictDoUpdate({
          target: schema.attentionItems.id,
          set: {
            priority: alert.priority,
            title: alert.title,
            stage: alert.stage ?? null,
            stuckSince: alert.stuckSince ?? null,
          },
        })
        .run();
    }
  });

  if (shouldLogAttentionPipeline()) {
    const byType = new Map<string, number>();
    for (const a of alerts) {
      byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
    }
    const summary = [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    attentionLog(
      `[attention] SQLite sync: ${alerts.length} active row(s) [${summary || "none"}] +${added} inserted -${removed} deleted`,
    );
    const maxShow = 30;
    if (alerts.length > 0) {
      const ids = alerts.map((a) => a.id);
      if (ids.length <= maxShow) {
        attentionLog(`[attention]   alert ids: ${ids.join(", ")}`);
      } else {
        attentionLog(
          `[attention]   alert ids (first ${maxShow}): ${ids.slice(0, maxShow).join(", ")} …(+${ids.length - maxShow} more)`,
        );
      }
    }
  }

  return { added, removed };
}

export function getAttentionItems(opts?: { includeAll?: boolean }): AttentionItem[] {
  const database = openStateDatabase();
  const now = new Date().toISOString();

  const order = [
    sql`CASE ${schema.attentionItems.priority} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END`,
    desc(schema.attentionItems.pinned),
    asc(schema.attentionItems.firstSeenAt),
  ];

  const rows = opts?.includeAll
    ? database.select().from(schema.attentionItems).orderBy(...order).all()
    : database
        .select()
        .from(schema.attentionItems)
        .where(
          and(
            isNull(schema.attentionItems.dismissedAt),
            or(isNull(schema.attentionItems.snoozedUntil), lte(schema.attentionItems.snoozedUntil, now)),
          ),
        )
        .orderBy(...order)
        .all();

  return rows.map(
    (row): AttentionItem => ({
      id: row.id,
      type: row.type,
      entityKind: row.entityKind as "pr" | "ticket",
      entityIdentifier: row.entityIdentifier,
      priority: row.priority as "high" | "medium" | "low",
      title: row.title,
      stage: row.stage ?? undefined,
      stuckSince: row.stuckSince ?? undefined,
      firstSeenAt: row.firstSeenAt,
      snoozedUntil: row.snoozedUntil ?? undefined,
      dismissedAt: row.dismissedAt ?? undefined,
      pinned: row.pinned === 1,
    }),
  );
}

export function snoozeItem(id: string, until: string): void {
  openStateDatabase()
    .update(schema.attentionItems)
    .set({ snoozedUntil: until })
    .where(eq(schema.attentionItems.id, id))
    .run();
}

export function dismissItem(id: string): void {
  const now = new Date().toISOString();
  openStateDatabase()
    .update(schema.attentionItems)
    .set({ dismissedAt: now })
    .where(eq(schema.attentionItems.id, id))
    .run();
}

export function pinItem(id: string): void {
  const database = openStateDatabase();
  const current = database
    .select({ pinned: schema.attentionItems.pinned })
    .from(schema.attentionItems)
    .where(eq(schema.attentionItems.id, id))
    .get();
  if (!current) return;
  database
    .update(schema.attentionItems)
    .set({ pinned: current.pinned ? 0 : 1 })
    .where(eq(schema.attentionItems.id, id))
    .run();
}
