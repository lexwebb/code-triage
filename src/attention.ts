import { getRawSqlite } from "./db/client.js";
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
  const db = getRawSqlite();
  const now = new Date().toISOString();
  const activeIds = new Set(alerts.map((a) => a.id));
  const existing = db.prepare("SELECT id FROM attention_items").all() as Array<{ id: string }>;
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

  const run = db.transaction(() => {
    for (const row of existing) {
      if (!activeIds.has(row.id)) {
        db.prepare("DELETE FROM attention_items WHERE id = ?").run(row.id);
        removed += 1;
      }
    }

    const upsert = db.prepare(`
      INSERT INTO attention_items (id, type, entity_kind, entity_identifier, priority, title, stage, stuck_since, first_seen_at, pinned)
      VALUES (@id, @type, @entity_kind, @entity_identifier, @priority, @title, @stage, @stuck_since, @first_seen_at, 0)
      ON CONFLICT(id) DO UPDATE SET
        priority = @priority,
        title = @title,
        stage = @stage,
        stuck_since = @stuck_since
    `);

    for (const alert of alerts) {
      if (!existingIds.has(alert.id)) {
        added += 1;
      }
      upsert.run({
        id: alert.id,
        type: alert.type,
        entity_kind: alert.entityKind,
        entity_identifier: alert.entityIdentifier,
        priority: alert.priority,
        title: alert.title,
        stage: alert.stage ?? null,
        stuck_since: alert.stuckSince ?? null,
        first_seen_at: now,
      });
    }
  });

  run();

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
  const db = getRawSqlite();
  const now = new Date().toISOString();

  let sql = "SELECT * FROM attention_items";
  if (!opts?.includeAll) {
    sql += " WHERE dismissed_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)";
  }
  sql += " ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END, pinned DESC, first_seen_at ASC";

  const rows = opts?.includeAll
    ? db.prepare(sql).all()
    : db.prepare(sql).all(now);

  return (rows as Array<Record<string, unknown>>).map(rowToItem);
}

function rowToItem(row: Record<string, unknown>): AttentionItem {
  return {
    id: row.id as string,
    type: row.type as string,
    entityKind: row.entity_kind as "pr" | "ticket",
    entityIdentifier: row.entity_identifier as string,
    priority: row.priority as "high" | "medium" | "low",
    title: row.title as string,
    stage: (row.stage ?? undefined) as string | undefined,
    stuckSince: (row.stuck_since ?? undefined) as string | undefined,
    firstSeenAt: row.first_seen_at as string,
    snoozedUntil: (row.snoozed_until ?? undefined) as string | undefined,
    dismissedAt: (row.dismissed_at ?? undefined) as string | undefined,
    pinned: row.pinned === 1,
  };
}

export function snoozeItem(id: string, until: string): void {
  const db = getRawSqlite();
  db.prepare("UPDATE attention_items SET snoozed_until = ? WHERE id = ?").run(until, id);
}

export function dismissItem(id: string): void {
  const db = getRawSqlite();
  const now = new Date().toISOString();
  db.prepare("UPDATE attention_items SET dismissed_at = ? WHERE id = ?").run(now, id);
}

export function pinItem(id: string): void {
  const db = getRawSqlite();
  const current = db.prepare("SELECT pinned FROM attention_items WHERE id = ?").get(id) as { pinned: number } | undefined;
  if (!current) return;
  db.prepare("UPDATE attention_items SET pinned = ? WHERE id = ?").run(current.pinned ? 0 : 1, id);
}
