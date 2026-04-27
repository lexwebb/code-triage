import { eq } from "drizzle-orm";
import * as schema from "./db/schema.js";
import { openStateDatabase } from "./db/client.js";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function savePushSubscription(sub: PushSubscriptionRecord): void {
  const now = new Date().toISOString();
  openStateDatabase()
    .insert(schema.pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      keysJson: JSON.stringify(sub.keys),
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: { keysJson: JSON.stringify(sub.keys), createdAt: now },
    })
    .run();
}

export function deletePushSubscription(endpoint: string): void {
  openStateDatabase().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint)).run();
}

export function getAllPushSubscriptions(): PushSubscriptionRecord[] {
  const rows = openStateDatabase()
    .select({ endpoint: schema.pushSubscriptions.endpoint, keysJson: schema.pushSubscriptions.keysJson })
    .from(schema.pushSubscriptions)
    .all();
  return rows.map((r) => ({
    endpoint: r.endpoint,
    keys: JSON.parse(r.keysJson) as { p256dh: string; auth: string },
  }));
}

export function mutePR(repo: string, number: number): void {
  openStateDatabase()
    .insert(schema.mutedPrs)
    .values({ prKey: `${repo}:${number}` })
    .onConflictDoNothing()
    .run();
}

export function unmutePR(repo: string, number: number): void {
  openStateDatabase().delete(schema.mutedPrs).where(eq(schema.mutedPrs.prKey, `${repo}:${number}`)).run();
}

export function getMutedPRs(): string[] {
  const rows = openStateDatabase().select({ prKey: schema.mutedPrs.prKey }).from(schema.mutedPrs).all();
  return rows.map((r) => r.prKey);
}

export function isPRMuted(repo: string, number: number): boolean {
  const row = openStateDatabase()
    .select({ prKey: schema.mutedPrs.prKey })
    .from(schema.mutedPrs)
    .where(eq(schema.mutedPrs.prKey, `${repo}:${number}`))
    .get();
  return !!row;
}
