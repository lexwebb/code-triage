import { getRawSqlite, openStateDatabase } from "./db/client.js";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function savePushSubscription(sub: PushSubscriptionRecord): void {
  openStateDatabase();
  const db = getRawSqlite();
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, keys_json, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json, created_at = excluded.created_at`,
  ).run(sub.endpoint, JSON.stringify(sub.keys), new Date().toISOString());
}

export function deletePushSubscription(endpoint: string): void {
  openStateDatabase();
  getRawSqlite().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function getAllPushSubscriptions(): PushSubscriptionRecord[] {
  openStateDatabase();
  const rows = getRawSqlite()
    .prepare("SELECT endpoint, keys_json FROM push_subscriptions")
    .all() as Array<{ endpoint: string; keys_json: string }>;
  return rows.map((r) => ({
    endpoint: r.endpoint,
    keys: JSON.parse(r.keys_json) as { p256dh: string; auth: string },
  }));
}

export function mutePR(repo: string, number: number): void {
  openStateDatabase();
  getRawSqlite()
    .prepare("INSERT OR IGNORE INTO muted_prs (pr_key) VALUES (?)")
    .run(`${repo}:${number}`);
}

export function unmutePR(repo: string, number: number): void {
  openStateDatabase();
  getRawSqlite()
    .prepare("DELETE FROM muted_prs WHERE pr_key = ?")
    .run(`${repo}:${number}`);
}

export function getMutedPRs(): string[] {
  openStateDatabase();
  const rows = getRawSqlite()
    .prepare("SELECT pr_key FROM muted_prs")
    .all() as Array<{ pr_key: string }>;
  return rows.map((r) => r.pr_key);
}

export function isPRMuted(repo: string, number: number): boolean {
  openStateDatabase();
  const row = getRawSqlite()
    .prepare("SELECT 1 FROM muted_prs WHERE pr_key = ?")
    .get(`${repo}:${number}`);
  return !!row;
}
