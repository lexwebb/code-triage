# Web Push Notifications — Design Spec

**Date:** 2026-04-14
**Status:** Draft

## Overview

Move all notification logic from the frontend (`useNotifications.ts`) and CLI (`notifier.ts` / `node-notifier`) to a centralized backend module that sends Web Push notifications via the Push API. The browser `Notification` API calls and `node-notifier` desktop toasts are replaced by server-driven push messages that work even when the browser tab is closed. `node-notifier` is retained as a fallback only when zero push subscriptions exist.

## Goals

1. **Single source of truth** — all notification decisions happen server-side in `src/push.ts`.
2. **Works with tab closed** — Web Push via service worker delivers OS-level notifications regardless of tab state.
3. **Zero-config setup** — VAPID keys auto-generated on first run, stored in `~/.code-triage/`.
4. **`node-notifier` fallback** — if no browser has subscribed for push, fall back to CLI desktop toasts (existing behavior).
5. **Server-side muting** — muted PR list moves from `localStorage` to SQLite so the backend can respect it.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Backend (Node.js)                                  │
│                                                     │
│  cli.ts ──poll──▶ push.ts ──diff state──▶ send push │
│  eval-queue.ts ────▶ push.ts ──────────▶ send push  │
│  server.ts (fix jobs) ─▶ push.ts ──────▶ send push  │
│  setInterval (30m) ────▶ push.ts ──────▶ send push  │
│                          │                          │
│                          ▼                          │
│                   push_subscriptions (DB)            │
│                   muted_prs (DB)                    │
│                   vapid.json (~/.code-triage/)       │
│                          │                          │
│               ┌──────────┴──────────┐               │
│               ▼                     ▼               │
│         web-push lib          node-notifier         │
│        (if subs > 0)         (if subs == 0)         │
└───────────────┬─────────────────────────────────────┘
                │ Push API
                ▼
┌───────────────────────────┐
│  Browser                  │
│  sw.js (service worker)   │
│  ── push event ──▶ showNotification()               │
│  ── notificationclick ──▶ focus/open tab             │
└───────────────────────────┘
```

## 1. VAPID Key Management

- Auto-generated on first use via `webpush.generateVAPIDKeys()`.
- Stored at `~/.code-triage/vapid.json` as `{ publicKey: string, privateKey: string }`.
- Loaded lazily when `src/push.ts` initializes.
- `webpush.setVapidDetails('mailto:code-triage@localhost', publicKey, privateKey)` called once at startup.

## 2. Database Changes

### New table: `push_subscriptions`

```sql
push_subscriptions (
  endpoint   TEXT PRIMARY KEY,  -- push service URL (unique per browser)
  keys_json  TEXT NOT NULL,     -- JSON: { p256dh: string, auth: string }
  created_at TEXT NOT NULL      -- ISO 8601 timestamp
)
```

Deduplication is natural — same browser/service-worker scope produces the same endpoint. `INSERT OR REPLACE` handles re-subscriptions.

### New table: `muted_prs`

```sql
muted_prs (
  pr_key TEXT PRIMARY KEY  -- "owner/repo:number"
)
```

Replaces the `localStorage`-based muted set in the frontend.

### Drizzle schema additions (`src/db/schema.ts`)

```ts
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  keysJson: text("keys_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const mutedPrs = sqliteTable("muted_prs", {
  prKey: text("pr_key").primaryKey(),
});
```

## 3. New API Endpoints

| Method | Path | Body / Params | Response | Purpose |
|--------|------|---------------|----------|---------|
| `GET` | `/api/push/vapid-public-key` | — | `{ publicKey: string }` | Frontend needs this to subscribe |
| `POST` | `/api/push/subscribe` | `{ endpoint, keys: { p256dh, auth } }` | `200 OK` | Store push subscription |
| `DELETE` | `/api/push/unsubscribe` | `{ endpoint }` | `200 OK` | Remove push subscription |
| `POST` | `/api/push/mute` | `{ repo, number }` | `200 OK` | Mute a PR |
| `DELETE` | `/api/push/mute` | `{ repo, number }` | `200 OK` | Unmute a PR |
| `GET` | `/api/push/muted` | — | `{ muted: string[] }` | List muted PR keys |

## 4. Backend Push Module (`src/push.ts`)

### State Tracked (in-memory, mirrors what `useNotifications.ts` tracked)

```ts
interface PushState {
  reviewPRKeys: Set<string>;           // PRs where review is requested
  prChecksStatus: Map<string, string>; // PR key → checksStatus
  prOpenComments: Map<string, number>; // PR key → open comment count
  pendingCommentKeys: Set<string>;     // analyzed comments needing action
  lastReviewReminder: number;          // timestamp of last 30-min reminder
  initialized: boolean;
}
```

### Trigger Points

| When | Called from | Notification type |
|------|------------|-------------------|
| After poll cycle | `cli.ts` (after `fetchNewComments` completes) — passes current authored pull list and review-requested pull list to `push.ts` | New review requests, CI status changes, new comments on your PRs |
| After eval completes | `eval-queue.ts` (after `markCommentWithEvaluation`) | "Needs fix / reply / resolve" with summary |
| Fix job status change | `server.ts` `setFixJobStatus()` | "Fix ready" or "Fix failed" (terminal states only) |
| Every 30 minutes | `setInterval` in `push.ts` | "N PRs waiting for your review" reminder |
| Test notification | `triggerTestNotification()` in `server.ts` | "Notifications are working!" |

### Event Detection Logic

Mirrors the current `useNotifications.ts` diffing:

1. **New review requests:** diff `reviewPRKeys` — any key in current but not previous (and not muted) triggers a push.
2. **CI status changes:** diff `prChecksStatus` — transition to `success` or `failure` (and not muted) triggers a push.
3. **New comments on your PRs:** diff `prOpenComments` — increase in count (and not muted) triggers a push.
4. **Newly analyzed comments:** after eval, if the comment's evaluation action is `fix`, `reply`, or `resolve`, push immediately.
5. **Fix job terminal states:** when `setFixJobStatus` is called with `status: "complete"` or `status: "error"`, push.
6. **Review reminders:** 30-min interval checks for unmuted review-requested PRs.

### Dispatch

```ts
async function sendPush(title: string, body: string, data?: { url?: string }): Promise<void> {
  const subs = getAllSubscriptions(); // from DB
  if (subs.length === 0) {
    // Fallback to node-notifier
    sendNotification(title, body);
    return;
  }
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body, icon: "/logo.png", data }));
    } catch (err) {
      if ((err as WebPushError).statusCode === 410) {
        deleteSubscription(sub.endpoint); // expired
      }
    }
  }
}
```

### Initialization

`initPush()` called from `cli.ts` at startup:
- Loads or generates VAPID keys.
- Calls `webpush.setVapidDetails()`.
- Starts the 30-minute review reminder interval.
- State is initialized as empty; the first poll cycle populates the baseline (no notifications fired on first diff, same as current frontend behavior).

## 5. Service Worker (`web/public/sw.js`)

Minimal — no caching, no fetch interception:

```js
self.addEventListener("push", (event) => {
  const payload = event.data?.json() ?? {};
  const { title = "Code Triage", body = "", icon = "/logo.png", data = {} } = payload;
  event.waitUntil(self.registration.showNotification(title, { body, icon, data }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
```

## 6. Frontend Changes

### `useNotifications.ts` → `usePushSubscription.ts`

**Removed:** All state-diffing logic, `notify()` calls, review reminder interval, comment baseline tracking, inline `new Notification()` calls.

**Retained/rewritten:**
- Service worker registration and push subscription management.
- `mutePR()` / `unmutePR()` / `isPRMuted()` — rewritten to call backend API instead of `localStorage`.
- Exports a `usePushSubscription()` hook that:
  1. Registers the service worker on mount.
  2. Fetches the VAPID public key from the backend.
  3. Subscribes to push via `pushManager.subscribe()`.
  4. POSTs the subscription to `/api/push/subscribe`.
  5. Returns subscription status for the UI to display.

### `App.tsx`

- Remove inline fix-job notification logic (~lines 390-410).
- Remove `testNotification` consumption from poll status.
- Replace `useNotifications()` call with `usePushSubscription()`.
- Keep notification permission banner — reworded for push notifications. Flow: request permission → register SW → subscribe to push → POST to backend.
- Test notification button calls `POST /api/push/test` (or reuses `triggerTestNotification()`) instead of inline `new Notification()`.

### `web/src/api.ts`

- Add: `getVapidPublicKey()`, `subscribePush()`, `unsubscribePush()`, `mutePR()`, `unmutePR()`, `getMutedPRs()`.
- Remove: `testNotification` field from poll status type.

## 7. `node-notifier` Fallback

`sendNotification()` in `src/notifier.ts` is retained but only called from `src/push.ts` when `getAllSubscriptions()` returns an empty array. The `notifyNewComments()` function is removed — its logic is absorbed by `push.ts`.

The console.log summary output in `notifyNewComments()` (the `=== CodeRabbit: N new comments ===` block) is also removed since the web UI and push notifications replace it.

## 8. Dependencies

- **New:** `web-push` npm package (backend only).
- **Retained:** `node-notifier` (fallback).
- **No new frontend dependencies** — Push API and Service Worker API are browser-native.

## 9. Migration

- Existing `localStorage` muted PRs are not migrated automatically. Users re-mute from the web UI (minor inconvenience, one-time).
- No breaking API changes — new endpoints only.
- The `testNotification` field on poll status becomes unused but can be removed without breaking anything (frontend just stops reading it).
