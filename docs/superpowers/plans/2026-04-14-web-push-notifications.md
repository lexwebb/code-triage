# Web Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all notification logic from the frontend zustand `notificationsSlice` to a centralized backend `src/push.ts` module that sends Web Push notifications via a service worker, with `node-notifier` as a fallback when no push subscriptions exist.

**Architecture:** Backend `src/push.ts` tracks in-memory state diffs (review PRs, CI status, comment counts, analyzed comments). After each poll cycle, eval completion, and fix job transition, it sends push notifications via the `web-push` library. A minimal service worker (`web/public/sw.js`) receives and displays them. The frontend `notificationsSlice` is gutted to only manage push subscription lifecycle and mute state (persisted to SQLite).

**Tech Stack:** `web-push` (npm), Service Worker Push API, SQLite (Drizzle ORM), existing SSE infrastructure for trigger signals.

**Spec:** `docs/superpowers/specs/2026-04-14-web-push-notifications-design.md`

---

### Task 1: Install `web-push` and add VAPID key management

**Files:**
- Modify: `package.json` (add `web-push` dependency)
- Create: `src/vapid.ts`
- Create: `src/vapid.test.ts`

- [ ] **Step 1: Install web-push**

```bash
yarn add web-push
yarn add -D @types/web-push
```

If `@types/web-push` doesn't exist (web-push ships its own types), skip the `@types` install.

- [ ] **Step 2: Write failing test for VAPID key management**

Create `src/vapid.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("VAPID key management", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `vapid-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("generates and persists VAPID keys on first call", async () => {
    const { getVapidKeys } = await import("./vapid.js");
    const keys = getVapidKeys();
    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();
    expect(existsSync(join(testDir, "vapid.json"))).toBe(true);
  });

  it("returns same keys on subsequent calls", async () => {
    const { getVapidKeys } = await import("./vapid.js");
    const first = getVapidKeys();
    const second = getVapidKeys();
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);
  });

  it("loads existing keys from disk", async () => {
    const { getVapidKeys } = await import("./vapid.js");
    const original = getVapidKeys();

    // Re-import to simulate restart — clear module cache
    // Instead, just read from disk and verify
    const stored = JSON.parse(readFileSync(join(testDir, "vapid.json"), "utf-8"));
    expect(stored.publicKey).toBe(original.publicKey);
    expect(stored.privateKey).toBe(original.privateKey);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
yarn test src/vapid.test.ts
```

Expected: FAIL — `./vapid.js` does not exist.

- [ ] **Step 4: Implement VAPID key management**

Create `src/vapid.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import webpush from "web-push";
import { getStateDir } from "./db/client.js";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;

function vapidPath(): string {
  return join(getStateDir(), "vapid.json");
}

export function getVapidKeys(): VapidKeys {
  if (cached) return cached;

  const path = vapidPath();
  if (existsSync(path)) {
    cached = JSON.parse(readFileSync(path, "utf-8")) as VapidKeys;
    return cached;
  }

  const keys = webpush.generateVAPIDKeys();
  cached = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  writeFileSync(path, JSON.stringify(cached, null, 2));
  return cached;
}

export function initVapid(): void {
  const keys = getVapidKeys();
  webpush.setVapidDetails("mailto:code-triage@localhost", keys.publicKey, keys.privateKey);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
yarn test src/vapid.test.ts
```

Expected: PASS

- [ ] **Step 6: Verify TypeScript compiles**

```bash
yarn build
```

- [ ] **Step 7: Commit**

```bash
git add package.json yarn.lock src/vapid.ts src/vapid.test.ts
git commit -m "feat(push): add web-push dependency and VAPID key management"
```

---

### Task 2: Add push subscription and muted PR database tables

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts` (add tables to `ensureSchema`)
- Create: `src/push-db.ts` (CRUD helpers)
- Create: `src/push-db.test.ts`

- [ ] **Step 1: Write failing tests for push subscription CRUD**

Create `src/push-db.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { closeStateDatabase, openStateDatabase } from "./db/client.js";

describe("push subscription DB", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `push-db-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
    openStateDatabase();
  });

  afterEach(() => {
    closeStateDatabase();
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("stores and retrieves a push subscription", async () => {
    const { savePushSubscription, getAllPushSubscriptions } = await import("./push-db.js");
    savePushSubscription({
      endpoint: "https://push.example.com/send/abc",
      keys: { p256dh: "key1", auth: "key2" },
    });
    const subs = getAllPushSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe("https://push.example.com/send/abc");
    expect(subs[0].keys.p256dh).toBe("key1");
  });

  it("upserts on same endpoint", async () => {
    const { savePushSubscription, getAllPushSubscriptions } = await import("./push-db.js");
    savePushSubscription({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: "a", auth: "b" } });
    savePushSubscription({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: "c", auth: "d" } });
    const subs = getAllPushSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].keys.p256dh).toBe("c");
  });

  it("deletes a push subscription by endpoint", async () => {
    const { savePushSubscription, deletePushSubscription, getAllPushSubscriptions } = await import("./push-db.js");
    savePushSubscription({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: "a", auth: "b" } });
    deletePushSubscription("https://push.example.com/send/abc");
    expect(getAllPushSubscriptions()).toHaveLength(0);
  });
});

describe("muted PRs DB", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `muted-db-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
    openStateDatabase();
  });

  afterEach(() => {
    closeStateDatabase();
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("mutes and lists PRs", async () => {
    const { mutePR, getMutedPRs } = await import("./push-db.js");
    mutePR("owner/repo", 42);
    expect(getMutedPRs()).toEqual(["owner/repo:42"]);
  });

  it("unmutes a PR", async () => {
    const { mutePR, unmutePR, getMutedPRs } = await import("./push-db.js");
    mutePR("owner/repo", 42);
    unmutePR("owner/repo", 42);
    expect(getMutedPRs()).toEqual([]);
  });

  it("isPRMuted returns correct status", async () => {
    const { mutePR, isPRMuted } = await import("./push-db.js");
    expect(isPRMuted("owner/repo", 42)).toBe(false);
    mutePR("owner/repo", 42);
    expect(isPRMuted("owner/repo", 42)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
yarn test src/push-db.test.ts
```

Expected: FAIL — `./push-db.js` does not exist.

- [ ] **Step 3: Add tables to Drizzle schema**

In `src/db/schema.ts`, add at the end:

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

- [ ] **Step 4: Add CREATE TABLE statements to ensureSchema**

In `src/db/client.ts`, inside `ensureSchema()`, add after the existing `CREATE TABLE` statements (before the `INSERT OR IGNORE INTO meta` line):

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS muted_prs (
  pr_key TEXT PRIMARY KEY
);
```

- [ ] **Step 5: Implement push-db CRUD helpers**

Create `src/push-db.ts`:

```ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
yarn test src/push-db.test.ts
```

Expected: PASS

- [ ] **Step 7: Verify build**

```bash
yarn build
```

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/client.ts src/push-db.ts src/push-db.test.ts
git commit -m "feat(push): add push_subscriptions and muted_prs DB tables with CRUD helpers"
```

---

### Task 3: Add push-related API endpoints

**Files:**
- Modify: `src/api.ts` (add routes inside `registerRoutes`)
- Modify: `web/src/api.ts` (add frontend API methods)

- [ ] **Step 1: Add backend API routes**

In `src/api.ts`, add import at top:

```ts
import { getVapidKeys } from "./vapid.js";
import { savePushSubscription, deletePushSubscription, mutePR as dbMutePR, unmutePR as dbUnmutePR, getMutedPRs as dbGetMutedPRs } from "./push-db.js";
```

Add routes inside `registerRoutes()` (find the end of the function and add before the closing brace). Look for the last `addRoute` call and add after it:

```ts
  // ── Push notification endpoints ──

  addRoute("GET", "/api/push/vapid-public-key", (_req, res) => {
    const keys = getVapidKeys();
    json(res, { publicKey: keys.publicKey });
  });

  addRoute("POST", "/api/push/subscribe", async (req, res) => {
    const body = await getBody(req) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      res.writeHead(400);
      json(res, { error: "Missing endpoint or keys" });
      return;
    }
    savePushSubscription({
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    });
    json(res, { ok: true });
  });

  addRoute("DELETE", "/api/push/unsubscribe", async (req, res) => {
    const body = await getBody(req) as { endpoint?: string };
    if (!body.endpoint) {
      res.writeHead(400);
      json(res, { error: "Missing endpoint" });
      return;
    }
    deletePushSubscription(body.endpoint);
    json(res, { ok: true });
  });

  addRoute("POST", "/api/push/mute", async (req, res) => {
    const body = await getBody(req) as { repo?: string; number?: number };
    if (!body.repo || typeof body.number !== "number") {
      res.writeHead(400);
      json(res, { error: "Missing repo or number" });
      return;
    }
    dbMutePR(body.repo, body.number);
    json(res, { ok: true });
  });

  addRoute("DELETE", "/api/push/mute", async (req, res) => {
    const body = await getBody(req) as { repo?: string; number?: number };
    if (!body.repo || typeof body.number !== "number") {
      res.writeHead(400);
      json(res, { error: "Missing repo or number" });
      return;
    }
    dbUnmutePR(body.repo, body.number);
    json(res, { ok: true });
  });

  addRoute("GET", "/api/push/muted", (_req, res) => {
    json(res, { muted: dbGetMutedPRs() });
  });
```

- [ ] **Step 2: Add frontend API methods**

In `web/src/api.ts`, add a `deleteJSON` helper near the existing `postJSON`:

```ts
async function deleteJSON<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `API error: ${res.status}`);
  }
  return data as T;
}
```

Then add methods inside the `api` object:

```ts
  getVapidPublicKey: () => fetchJSON<{ publicKey: string }>("/api/push/vapid-public-key"),
  subscribePush: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    postJSON<{ ok: boolean }>("/api/push/subscribe", sub),
  unsubscribePush: (endpoint: string) =>
    deleteJSON<{ ok: boolean }>("/api/push/unsubscribe", { endpoint }),
  mutePR: (repo: string, number: number) =>
    postJSON<{ ok: boolean }>("/api/push/mute", { repo, number }),
  unmutePR: (repo: string, number: number) =>
    deleteJSON<{ ok: boolean }>("/api/push/mute", { repo, number }),
  getMutedPRs: () => fetchJSON<{ muted: string[] }>("/api/push/muted"),
```

- [ ] **Step 3: Verify build**

```bash
yarn build && yarn build:web
```

- [ ] **Step 4: Commit**

```bash
git add src/api.ts web/src/api.ts
git commit -m "feat(push): add push subscription, mute, and VAPID API endpoints"
```

---

### Task 4: Create the service worker

**Files:**
- Create: `web/public/sw.js`

- [ ] **Step 1: Create service worker**

Create `web/public/sw.js`:

```js
/* eslint-disable no-restricted-globals */
self.addEventListener("push", (event) => {
  const payload = event.data?.json() ?? {};
  const { title = "Code Triage", body = "", icon = "/logo.png", data = {} } = payload;
  event.waitUntil(self.registration.showNotification(title, { body, icon, data }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});
```

- [ ] **Step 2: Verify Vite serves it (static file in public/)**

Vite automatically serves files from `public/` at the root. No config change needed. Verify:

```bash
ls web/public/sw.js
```

- [ ] **Step 3: Commit**

```bash
git add web/public/sw.js
git commit -m "feat(push): add minimal service worker for push notification display"
```

---

### Task 5: Build the backend push notification module (`src/push.ts`)

**Files:**
- Create: `src/push.ts`
- Create: `src/push.test.ts`

This is the core module — it tracks state diffs and dispatches push notifications.

- [ ] **Step 1: Write failing test for push state diffing**

Create `src/push.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { closeStateDatabase, openStateDatabase } from "./db/client.js";

// Mock web-push to avoid actual push sends
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "fake-pub", privateKey: "fake-priv" }),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue({}),
  },
}));

// Mock node-notifier
vi.mock("node-notifier", () => ({
  default: { notify: vi.fn() },
}));

describe("push notification module", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `push-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
    openStateDatabase();
  });

  afterEach(() => {
    closeStateDatabase();
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("does not send notifications on first poll (baseline)", async () => {
    const webpush = await import("web-push");
    const { processPolledData, initPush } = await import("./push.js");
    initPush();

    processPolledData({
      authored: [
        { repo: "owner/repo", number: 1, title: "PR 1", checksStatus: "pending", openComments: 0 },
      ],
      reviewRequested: [],
    });

    expect(webpush.default.sendNotification).not.toHaveBeenCalled();
  });

  it("sends push for new review request on second poll", async () => {
    const { savePushSubscription } = await import("./push-db.js");
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    const webpush = await import("web-push");
    const { processPolledData, initPush } = await import("./push.js");
    initPush();

    // First poll — baseline
    processPolledData({ authored: [], reviewRequested: [] });

    // Second poll — new review request
    processPolledData({
      authored: [],
      reviewRequested: [{ repo: "owner/repo", number: 5, title: "New PR", checksStatus: "pending", openComments: 0 }],
    });

    expect(webpush.default.sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((webpush.default.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("Review requested");
  });

  it("sends push for CI status change", async () => {
    const { savePushSubscription } = await import("./push-db.js");
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    const webpush = await import("web-push");
    const { processPolledData, initPush } = await import("./push.js");
    initPush();

    // Baseline
    processPolledData({
      authored: [{ repo: "owner/repo", number: 1, title: "My PR", checksStatus: "pending", openComments: 0 }],
      reviewRequested: [],
    });

    // CI passes
    processPolledData({
      authored: [{ repo: "owner/repo", number: 1, title: "My PR", checksStatus: "success", openComments: 0 }],
      reviewRequested: [],
    });

    expect(webpush.default.sendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((webpush.default.sendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("Checks passed");
  });

  it("falls back to node-notifier when no subscriptions exist", async () => {
    const notifier = await import("node-notifier");
    const webpush = await import("web-push");
    const { processPolledData, initPush } = await import("./push.js");
    initPush();

    // Baseline
    processPolledData({ authored: [], reviewRequested: [] });

    // New review request, no subscriptions
    processPolledData({
      authored: [],
      reviewRequested: [{ repo: "owner/repo", number: 5, title: "New PR", checksStatus: "pending", openComments: 0 }],
    });

    expect(webpush.default.sendNotification).not.toHaveBeenCalled();
    expect(notifier.default.notify).toHaveBeenCalled();
  });

  it("respects muted PRs", async () => {
    const { savePushSubscription } = await import("./push-db.js");
    const { mutePR } = await import("./push-db.js");
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });
    mutePR("owner/repo", 5);

    const webpush = await import("web-push");
    const { processPolledData, initPush } = await import("./push.js");
    initPush();

    processPolledData({ authored: [], reviewRequested: [] });
    processPolledData({
      authored: [],
      reviewRequested: [{ repo: "owner/repo", number: 5, title: "Muted PR", checksStatus: "pending", openComments: 0 }],
    });

    expect(webpush.default.sendNotification).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
yarn test src/push.test.ts
```

Expected: FAIL — `./push.js` does not exist.

- [ ] **Step 3: Implement src/push.ts**

Create `src/push.ts`:

```ts
import webpush from "web-push";
import notifier from "node-notifier";
import { getVapidKeys } from "./vapid.js";
import { getAllPushSubscriptions, deletePushSubscription, getMutedPRs } from "./push-db.js";

// ── Types ──

interface PullInfo {
  repo: string;
  number: number;
  title: string;
  checksStatus: string;
  openComments: number;
}

export interface PolledData {
  authored: PullInfo[];
  reviewRequested: PullInfo[];
}

export interface EvalCompleteData {
  repo: string;
  prNumber: number;
  commentId: number;
  path: string;
  line: number;
  action: string;
  summary: string;
}

export interface FixJobCompleteData {
  repo: string;
  prNumber: number;
  commentId: number;
  path: string;
  status: "completed" | "failed";
  error?: string;
}

// ── State ──

interface PushState {
  reviewPRKeys: Set<string>;
  prChecksStatus: Map<string, string>;
  prOpenComments: Map<string, number>;
  initialized: boolean;
  lastReviewReminder: number;
}

const state: PushState = {
  reviewPRKeys: new Set(),
  prChecksStatus: new Map(),
  prOpenComments: new Map(),
  initialized: false,
  lastReviewReminder: Date.now(),
};

let reminderInterval: ReturnType<typeof setInterval> | null = null;
let reviewPullsCache: PullInfo[] = [];

// ── Init ──

export function initPush(): void {
  const keys = getVapidKeys();
  webpush.setVapidDetails("mailto:code-triage@localhost", keys.publicKey, keys.privateKey);
}

// ── Helpers ──

function prKey(pr: PullInfo): string {
  return `${pr.repo}:${pr.number}`;
}

function getMutedSet(): Set<string> {
  return new Set(getMutedPRs());
}

async function sendPush(title: string, body: string, data?: { url?: string }): Promise<void> {
  const subs = getAllPushSubscriptions();
  if (subs.length === 0) {
    notifier.notify({ title, message: body }, (err) => {
      if (err) console.error("Desktop notification failed:", err.message);
    });
    return;
  }
  const payload = JSON.stringify({ title, body, icon: "/logo.png", data: data ?? {} });
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 410 || statusCode === 404) {
        deletePushSubscription(sub.endpoint);
      }
    }
  }
}

// ── Poll-driven diff ──

export function processPolledData(data: PolledData): void {
  const muted = getMutedSet();

  if (!state.initialized) {
    // Baseline — seed state, don't notify
    state.reviewPRKeys = new Set(data.reviewRequested.map(prKey));
    for (const pr of data.authored) {
      state.prChecksStatus.set(prKey(pr), pr.checksStatus);
      state.prOpenComments.set(prKey(pr), pr.openComments);
    }
    state.initialized = true;
    reviewPullsCache = data.reviewRequested;
    return;
  }

  // New review requests
  const currentReviewKeys = new Set(data.reviewRequested.map(prKey));
  for (const pr of data.reviewRequested) {
    const key = prKey(pr);
    if (!state.reviewPRKeys.has(key) && !muted.has(key)) {
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      void sendPush(
        `Review requested: ${repoShort}#${pr.number}`,
        pr.title,
        { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
      );
    }
  }
  state.reviewPRKeys = currentReviewKeys;

  // CI status changes
  for (const pr of data.authored) {
    const key = prKey(pr);
    const prev = state.prChecksStatus.get(key);
    if (prev && prev !== pr.checksStatus && !muted.has(key)) {
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      if (pr.checksStatus === "success") {
        void sendPush(
          `Checks passed: ${repoShort}#${pr.number}`,
          pr.title,
          { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
        );
      } else if (pr.checksStatus === "failure") {
        void sendPush(
          `Checks failed: ${repoShort}#${pr.number}`,
          pr.title,
          { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
        );
      }
    }
    state.prChecksStatus.set(key, pr.checksStatus);
  }

  // Open comment count changes
  for (const pr of data.authored) {
    const key = prKey(pr);
    const prev = state.prOpenComments.get(key) ?? 0;
    if (pr.openComments > prev && !muted.has(key)) {
      const newCount = pr.openComments - prev;
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      void sendPush(
        `${newCount} new comment${newCount > 1 ? "s" : ""}: ${repoShort}#${pr.number}`,
        pr.title,
        { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
      );
    }
    state.prOpenComments.set(key, pr.openComments);
  }

  reviewPullsCache = data.reviewRequested;
}

// ── Event-driven notifications ──

export function notifyEvalComplete(data: EvalCompleteData): void {
  const muted = getMutedSet();
  const prk = `${data.repo}:${data.prNumber}`;
  if (muted.has(prk)) return;

  const repoShort = data.repo.split("/")[1] ?? data.repo;
  const actionLabel = data.action === "fix" ? "Needs fix"
    : data.action === "reply" ? "Needs reply" : "Can resolve";

  void sendPush(
    `${actionLabel}: ${repoShort}#${data.prNumber}`,
    `${data.path}:${data.line} — ${data.summary}`,
    { url: `/?pr=${data.prNumber}&repo=${encodeURIComponent(data.repo)}` },
  );
}

export function notifyFixJobComplete(data: FixJobCompleteData): void {
  const muted = getMutedSet();
  const prk = `${data.repo}:${data.prNumber}`;
  if (muted.has(prk)) return;

  const repoShort = data.repo.split("/")[1] ?? data.repo;
  if (data.status === "completed") {
    void sendPush(
      `Fix ready: ${repoShort}#${data.prNumber}`,
      data.path,
      { url: `/?pr=${data.prNumber}&repo=${encodeURIComponent(data.repo)}` },
    );
  } else {
    void sendPush(
      `Fix failed: ${repoShort}#${data.prNumber}`,
      `${data.path}: ${data.error ?? "unknown error"}`,
      { url: `/?pr=${data.prNumber}&repo=${encodeURIComponent(data.repo)}` },
    );
  }
}

export function sendTestPush(): void {
  void sendPush("Code Triage — Test Notification", "Push notifications are working!");
}

// ── Review reminder ──

export function startReviewReminder(): () => void {
  if (reminderInterval) clearInterval(reminderInterval);

  reminderInterval = setInterval(() => {
    const now = Date.now();
    if (now - state.lastReviewReminder < 30 * 60_000) return;
    state.lastReviewReminder = now;

    const muted = getMutedSet();
    const unmuted = reviewPullsCache.filter((pr) => !muted.has(prKey(pr)));
    if (unmuted.length === 0) return;

    if (unmuted.length === 1) {
      const pr = unmuted[0];
      const repoShort = pr.repo.split("/")[1] ?? pr.repo;
      void sendPush(
        `Waiting for your review: ${repoShort}#${pr.number}`,
        pr.title,
        { url: `/?pr=${pr.number}&repo=${encodeURIComponent(pr.repo)}` },
      );
    } else {
      void sendPush(
        `${unmuted.length} PRs waiting for your review`,
        unmuted.map((pr) => `${pr.repo.split("/")[1]}#${pr.number}: ${pr.title}`).join("\n"),
      );
    }
  }, 60_000);

  return () => {
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }
  };
}

/** Reset state — for testing. */
export function resetPushState(): void {
  state.reviewPRKeys.clear();
  state.prChecksStatus.clear();
  state.prOpenComments.clear();
  state.initialized = false;
  state.lastReviewReminder = Date.now();
  reviewPullsCache = [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
yarn test src/push.test.ts
```

Expected: PASS

- [ ] **Step 5: Verify build**

```bash
yarn build
```

- [ ] **Step 6: Commit**

```bash
git add src/push.ts src/push.test.ts
git commit -m "feat(push): add backend push notification module with state diffing"
```

---

### Task 6: Wire push module into CLI poll loop, eval-queue, and fix jobs

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/eval-queue.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Wire initPush and processPolledData into cli.ts**

In `src/cli.ts`, add import:

```ts
import { initPush, processPolledData, startReviewReminder, sendTestPush } from "./push.js";
```

Call `initPush()` early in startup — after `openStateDatabase()` is called but before the poll loop. Find the line where the server starts (look for `startServer` call) and add after it:

```ts
initPush();
const stopReminder = startReviewReminder();
```

Add `stopReminder()` to the `shutdown` function.

In the `poll()` function, after `recordPollOutcomes(pollOutcomes, Date.now())` (around line 468), the poll function has access to the batch data. We need to pass aggregated pull data to `processPolledData`. Add after `recordPollOutcomes`:

```ts
    // Push notifications — diff state and notify
    try {
      const pullsBundle = await (await import("./api.js")).fetchPullsBundleData();
      if (pullsBundle) {
        processPolledData({
          authored: pullsBundle.authored.map((p: { repo: string; number: number; title: string; checksStatus: string; openComments: number }) => ({
            repo: p.repo, number: p.number, title: p.title, checksStatus: p.checksStatus, openComments: p.openComments,
          })),
          reviewRequested: pullsBundle.reviewRequested.map((p: { repo: string; number: number; title: string; checksStatus: string; openComments: number }) => ({
            repo: p.repo, number: p.number, title: p.title, checksStatus: p.checksStatus, openComments: p.openComments,
          })),
        });
      }
    } catch { /* push notification failure should not break poll */ }
```

**Note:** The above approach requires the API's pull-fetching logic to be callable internally. The simpler approach is to check if there's already a `fetchPullsBundleData` or similar function exported from `api.ts`. If not, we can extract it. Alternatively, we can call the existing pull bundle endpoint internally. Let the implementer check `api.ts` for a `GET /api/pulls-bundle` handler and see if the data-fetching logic can be extracted into a reusable function, or just use the existing poller data.

A simpler approach: the poll loop already has `batch` which contains per-repo data. But we need authored vs review-requested split which comes from the API's `/api/pulls-bundle` handler. The cleanest integration point is to call the same function the API uses. Check how `/api/pulls-bundle` works and extract its data-fetching into a shared function if it isn't already.

Replace the `notifyNewComments(comments, pullsByNumber)` calls (lines 438 and 459) with nothing — remove them. The `processPolledData` call replaces this.

Remove the import of `notifyNewComments` from `./notifier.js` in `cli.ts`.

Update the test notification hotkey (line 589) to also call `sendTestPush()`:

```ts
{ key: "n", label: "Test notif", handler: () => { triggerTestNotification(); sendTestPush(); console.log("\n  Test notification triggered.\n"); } },
```

- [ ] **Step 2: Wire notifyEvalComplete into eval-queue.ts**

In `src/eval-queue.ts`, add import:

```ts
import { notifyEvalComplete } from "./push.js";
```

After the `sseBroadcast("eval-complete", ...)` call (around line 184), add:

```ts
        if (evaluation) {
          const comment = item.comment;
          notifyEvalComplete({
            repo: item.repo,
            prNumber: item.prNumber,
            commentId: item.commentId,
            path: comment.path,
            line: comment.line,
            action: evaluation.action,
            summary: evaluation.summary,
          });
        }
```

- [ ] **Step 3: Wire notifyFixJobComplete into server.ts**

In `src/server.ts`, add import:

```ts
import { notifyFixJobComplete } from "./push.js";
```

In the `setFixJobStatus` function (line 296), after the existing `sseBroadcast` call, add:

```ts
  if (job.status === "completed" || job.status === "failed") {
    notifyFixJobComplete({
      repo: job.repo,
      prNumber: job.prNumber,
      commentId: job.commentId,
      path: job.path,
      status: job.status,
      error: job.error,
    });
  }
```

- [ ] **Step 4: Verify build**

```bash
yarn build
```

- [ ] **Step 5: Run all tests**

```bash
yarn test
```

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/eval-queue.ts src/server.ts
git commit -m "feat(push): wire push notifications into poll loop, eval-queue, and fix jobs"
```

---

### Task 7: Rewrite frontend notificationsSlice for push subscription management

**Files:**
- Modify: `web/src/store/notificationsSlice.ts`
- Modify: `web/src/store/types.ts`
- Modify: `web/src/store/index.ts`
- Modify: `web/src/store/selectors.ts`

- [ ] **Step 1: Update NotificationsSlice type**

In `web/src/store/types.ts`, replace the `NotificationsSlice` interface (lines 203-226) with:

```ts
export interface NotificationsSlice {
  mutedPRs: Set<string>;
  permission: NotificationPermission;
  pushSubscribed: boolean;

  subscribePush: () => Promise<void>;
  unsubscribePush: () => Promise<void>;
  mutePR: (repo: string, number: number) => void;
  unmutePR: (repo: string, number: number) => void;
  isPRMuted: (repo: string, number: number) => boolean;
  requestPermission: () => Promise<void>;
  loadMutedPRs: () => Promise<void>;
  checkPermissionPeriodically: () => () => void;
}
```

Remove the old private state fields (`_previousReviewPRKeys`, `_previousCommentKeys`, etc.), `initialized`, `commentBaselineReady`, `_reminderInterval`, `_permissionInterval`, and the removed methods (`initializeBaseline`, `diffAndNotify`, `testNotification`, `startReminderInterval`).

- [ ] **Step 2: Rewrite notificationsSlice.ts**

Replace the entire contents of `web/src/store/notificationsSlice.ts` with:

```ts
import { api } from "../api";
import type { SliceCreator, NotificationsSlice } from "./types";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const createNotificationsSlice: SliceCreator<NotificationsSlice> = (set, get) => ({
  mutedPRs: new Set(),
  permission: "Notification" in window ? Notification.permission : "denied",
  pushSubscribed: false,

  subscribePush: async () => {
    try {
      // Request notification permission if needed
      if ("Notification" in window && Notification.permission === "default") {
        const result = await Notification.requestPermission();
        set({ permission: result });
        if (result !== "granted") return;
      }
      if ("Notification" in window && Notification.permission !== "granted") return;

      // Register service worker
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      // Get VAPID public key
      const { publicKey } = await api.getVapidPublicKey();

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // Send subscription to backend
      const raw = subscription.toJSON();
      await api.subscribePush({
        endpoint: raw.endpoint!,
        keys: {
          p256dh: raw.keys!.p256dh!,
          auth: raw.keys!.auth!,
        },
      });

      set({ pushSubscribed: true, permission: Notification.permission });
    } catch (err) {
      console.error("Push subscription failed:", err);
    }
  },

  unsubscribePush: async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await api.unsubscribePush(subscription.endpoint);
          await subscription.unsubscribe();
        }
      }
      set({ pushSubscribed: false });
    } catch (err) {
      console.error("Push unsubscribe failed:", err);
    }
  },

  mutePR: (repo, number) => {
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.add(`${repo}:${number}`);
      return { mutedPRs: next };
    });
    void api.mutePR(repo, number).catch(() => {});
  },

  unmutePR: (repo, number) => {
    set((s) => {
      const next = new Set(s.mutedPRs);
      next.delete(`${repo}:${number}`);
      return { mutedPRs: next };
    });
    void api.unmutePR(repo, number).catch(() => {});
  },

  isPRMuted: (repo, number) => get().mutedPRs.has(`${repo}:${number}`),

  requestPermission: async () => {
    if ("Notification" in window && Notification.permission === "default") {
      const result = await Notification.requestPermission();
      set({ permission: result });
    }
  },

  loadMutedPRs: async () => {
    try {
      const { muted } = await api.getMutedPRs();
      set({ mutedPRs: new Set(muted) });
    } catch { /* ignore */ }
  },

  checkPermissionPeriodically: () => {
    const id = setInterval(() => {
      if ("Notification" in window && Notification.permission !== get().permission) {
        set({ permission: Notification.permission });
      }
      // Check push subscription status
      void navigator.serviceWorker.getRegistration().then(async (reg) => {
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub && !get().pushSubscribed) set({ pushSubscribed: true });
          if (!sub && get().pushSubscribed) set({ pushSubscribed: false });
        }
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  },
});
```

- [ ] **Step 3: Update store/index.ts — remove diffAndNotify subscription**

In `web/src/store/index.ts`, remove the `pullFetchGeneration` subscription (lines 24-30):

```ts
// Remove this block:
useAppStore.subscribe(
  (s) => s.pullFetchGeneration,
  () => {
    void useAppStore.getState().diffAndNotify();
  },
);
```

- [ ] **Step 4: Update selectors.ts — update selectShowNotifBanner**

In `web/src/store/selectors.ts`, update `selectShowNotifBanner` to account for push subscription:

```ts
export function selectShowNotifBanner(s: AppStore) {
  return s.permission === "default" || (s.permission === "granted" && !s.pushSubscribed);
}
```

- [ ] **Step 5: Verify web build**

```bash
yarn build:all
```

- [ ] **Step 6: Commit**

```bash
git add web/src/store/notificationsSlice.ts web/src/store/types.ts web/src/store/index.ts web/src/store/selectors.ts
git commit -m "feat(push): rewrite notificationsSlice for push subscription management"
```

---

### Task 8: Update App.tsx for push notification flow

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Update App.tsx initialization and banners**

In `App.tsx`, the initialization effect (around line 96-117) currently calls:

```ts
s.startReminderInterval(),
s.checkPermissionPeriodically(),
// ...
void s.initializeBaseline();
```

Replace with:

```ts
s.checkPermissionPeriodically(),
// ...
void s.loadMutedPRs();
void s.subscribePush();
```

Remove `s.startReminderInterval()` and `void s.initializeBaseline()`.

- [ ] **Step 2: Update the notification banner**

The notification permission banner (around line 160-175) currently has a "Turn on notifications" button that calls `requestPermission()`. Update it to call `subscribePush()` instead:

```tsx
{showNotifBanner && (
  <div className="bg-blue-600/90 px-4 py-2 flex items-center justify-between shrink-0">
    <span className="text-sm text-white">
      Enable push notifications to get alerted when PRs need your attention.
    </span>
    <div className="flex items-center gap-2">
      <button
        onClick={() => void subscribePush()}
        className="text-sm px-3 py-1 bg-white/20 hover:bg-white/30 text-white rounded transition-colors"
      >
        Turn on notifications
      </button>
    </div>
  </div>
)}
```

Add `subscribePush` to the destructured store actions (around line 79-89):

```ts
const subscribePush = useAppStore((s) => s.subscribePush);
```

- [ ] **Step 3: Update test notification button**

Find the test notification button in the settings/debug area. It currently calls `testNotification()` from the store. Change it to call the backend directly:

```tsx
onClick={() => {
  void fetch("/api/push/test", { method: "POST" });
}}
```

(We'll add the `/api/push/test` route in step 4.)

- [ ] **Step 4: Add test push endpoint to backend**

In `src/api.ts`, add this route with the other push endpoints:

```ts
  addRoute("POST", "/api/push/test", (_req, res) => {
    const { sendTestPush } = await import("./push.js");
    sendTestPush();
    json(res, { ok: true });
  });
```

Actually, since route handlers need to be async for dynamic import, make it:

```ts
  addRoute("POST", "/api/push/test", async (_req, res) => {
    const { sendTestPush } = await import("./push.js");
    sendTestPush();
    json(res, { ok: true });
  });
```

Or better, add `sendTestPush` to the static import at the top of `api.ts`:

```ts
import { sendTestPush } from "./push.js";
```

Then:

```ts
  addRoute("POST", "/api/push/test", (_req, res) => {
    sendTestPush();
    json(res, { ok: true });
  });
```

- [ ] **Step 5: Verify full build**

```bash
yarn build:all
```

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx src/api.ts
git commit -m "feat(push): update App.tsx for push subscription flow and test endpoint"
```

---

### Task 9: Remove old notification code

**Files:**
- Modify: `src/notifier.ts` (remove `notifyNewComments`, keep `sendNotification`)
- Modify: `src/cli.ts` (remove `notifyNewComments` import and calls)
- Modify: `src/server.ts` (remove `testNotificationPending` machinery)
- Modify: `web/src/api.ts` (remove `testNotification` from `PollStatus`)

- [ ] **Step 1: Clean up notifier.ts**

In `src/notifier.ts`, remove the `notifyNewComments` function (lines 24-59) and the `CrComment`/`PrInfo` type imports. Keep only `sendNotification`:

```ts
import notifier from "node-notifier";

/**
 * Desktop toast via node-notifier — used as fallback when no web push subscriptions exist.
 */
export function sendNotification(title: string, message: string): void {
  notifier.notify(
    { title, message },
    (err) => {
      if (err) {
        console.error("Desktop notification failed:", err.message);
      }
    },
  );
}
```

- [ ] **Step 2: Remove notifyNewComments calls from cli.ts**

In `src/cli.ts`:
- Remove `import { notifyNewComments } from "./notifier.js";` (line 6)
- Remove the two `notifyNewComments(comments, pullsByNumber);` calls (lines 438 and 459)

- [ ] **Step 3: Clean up testNotification from PollStatus in frontend API**

In `web/src/api.ts`, remove `testNotification: boolean;` from the `PollStatus` interface (line 101).

- [ ] **Step 4: Clean up server.ts test notification state**

In `src/server.ts`, the `testNotificationPending` flag, `triggerTestNotification`, `consumeTestNotification`, and the related `peekTestNotification`/`consumeTestNotification` options in `broadcastPollStatus`/`getPollState` can be simplified. The `triggerTestNotification` function is still used by the CLI hotkey — update it to call `sendTestPush()` instead:

```ts
import { sendTestPush } from "./push.js";

export function triggerTestNotification(): void {
  sendTestPush();
}
```

Remove the `testNotificationPending`, `consumeTestNotification` variables and functions. Remove `testNotification` from `getPollState` return value. Clean up the `broadcastPollStatus` options that reference test notifications.

- [ ] **Step 5: Update server.test.ts**

Update `src/server.test.ts` to remove tests for `consumeTestNotification` behavior that no longer exists.

- [ ] **Step 6: Update notifier.test.ts**

Update `src/notifier.test.ts` — the tests for `notifyNewComments` should be removed since that function no longer exists. Keep the `sendNotification` test.

- [ ] **Step 7: Run all tests**

```bash
yarn test
```

- [ ] **Step 8: Verify full build**

```bash
yarn build:all
```

- [ ] **Step 9: Commit**

```bash
git add src/notifier.ts src/notifier.test.ts src/cli.ts src/server.ts src/server.test.ts web/src/api.ts
git commit -m "refactor(push): remove old notification code, clean up test notification machinery"
```

---

### Task 10: Integration smoke test

**Files:** None (manual verification)

- [ ] **Step 1: Run full test suite**

```bash
yarn test
```

All tests must pass.

- [ ] **Step 2: Verify full build**

```bash
yarn build:all
```

Must compile cleanly.

- [ ] **Step 3: Manual smoke test**

```bash
yarn start
```

1. Open the web UI in a browser.
2. Verify the "Enable push notifications" banner appears.
3. Click "Turn on notifications" — browser should prompt for notification permission.
4. After granting, verify the banner disappears.
5. Press `n` in the CLI terminal — verify a push notification appears in the browser (even if you switch to another tab).
6. Verify no console errors in browser DevTools.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(push): address integration test findings"
```
