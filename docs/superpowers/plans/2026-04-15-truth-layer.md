# Truth Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified "Attention" feed with a coherence engine that cross-references GitHub PR state, Linear ticket state, and branch activity to surface what actually needs action.

**Architecture:** New `src/coherence.ts` evaluates deterministic rules after each poll cycle. `src/attention.ts` merges coherence alerts with other attention signals (pending reviews, CI failures) and persists to a new SQLite table. A new `/attention` route becomes the default landing page, showing a prioritized feed with lifecycle progress bars reused across views.

**Tech Stack:** TypeScript, Drizzle ORM (SQLite), React 19, TanStack Router, Zustand, Tailwind CSS, Vitest

---

### Task 1: Attention Items SQLite Table

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/client.ts`

- [ ] **Step 1: Add `attentionItems` table to Drizzle schema**

In `src/db/schema.ts`, add after the `fixQueue` table:

```typescript
export const attentionItems = sqliteTable("attention_items", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  entityKind: text("entity_kind").notNull(),
  entityIdentifier: text("entity_identifier").notNull(),
  priority: text("priority").notNull(),
  title: text("title").notNull(),
  stage: text("stage"),
  stuckSince: text("stuck_since"),
  firstSeenAt: text("first_seen_at").notNull(),
  snoozedUntil: text("snoozed_until"),
  dismissedAt: text("dismissed_at"),
  pinned: integer("pinned").notNull().default(0),
});
```

- [ ] **Step 2: Add CREATE TABLE to `ensureSchema()` in client.ts**

In `src/db/client.ts`, inside `ensureSchema()`, add after the `fix_queue` CREATE TABLE:

```sql
CREATE TABLE IF NOT EXISTS attention_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_identifier TEXT NOT NULL,
  priority TEXT NOT NULL,
  title TEXT NOT NULL,
  stage TEXT,
  stuck_since TEXT,
  first_seen_at TEXT NOT NULL,
  snoozed_until TEXT,
  dismissed_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 3: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/client.ts
git commit -m "feat: add attention_items SQLite table schema"
```

---

### Task 2: Config — Coherence Thresholds

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Write failing test for coherence config defaults**

In `src/config.test.ts`, add:

```typescript
describe("coherence config", () => {
  it("provides default coherence thresholds", () => {
    const config = loadConfig();
    expect(config.coherence).toEqual({
      branchStalenessDays: 3,
      approvedUnmergedHours: 24,
      reviewWaitHours: 24,
      ticketInactivityDays: 5,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/config.test.ts`
Expected: FAIL — `coherence` property does not exist on config.

- [ ] **Step 3: Add coherence config to Config interface and defaults**

In `src/config.ts`, add to the `Config` interface:

```typescript
/** Coherence engine thresholds for the attention feed. */
coherence?: {
  branchStalenessDays?: number;
  approvedUnmergedHours?: number;
  reviewWaitHours?: number;
  ticketInactivityDays?: number;
};
```

In `DEFAULTS`, add:

```typescript
coherence: {
  branchStalenessDays: 3,
  approvedUnmergedHours: 24,
  reviewWaitHours: 24,
  ticketInactivityDays: 5,
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add coherence threshold config with defaults"
```

---

### Task 3: Coherence Engine — Core Rule Evaluation

**Files:**
- Create: `src/coherence.ts`
- Create: `src/coherence.test.ts`

- [ ] **Step 1: Define types and write test for `stale-in-progress` rule**

Create `src/coherence.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { evaluateCoherence, type CoherenceInput, type CoherenceAlert } from "./coherence.js";

function makeInput(overrides: Partial<CoherenceInput> = {}): CoherenceInput {
  return {
    myTickets: [],
    repoLinkedTickets: [],
    authoredPRs: [],
    reviewRequestedPRs: [],
    ticketToPRs: {},
    prToTickets: {},
    thresholds: {
      branchStalenessDays: 3,
      approvedUnmergedHours: 24,
      reviewWaitHours: 24,
      ticketInactivityDays: 5,
    },
    now: Date.now(),
    ...overrides,
  };
}

describe("evaluateCoherence", () => {
  it("detects stale in-progress ticket (ticket active, no recent PR activity)", () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-42",
        title: "Fix auth",
        state: { name: "In Progress", color: "#f00", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: fourDaysAgo,
        providerUrl: "https://linear.app/eng/issue/ENG-42",
      }],
      ticketToPRs: {
        "ENG-42": [{ number: 18, repo: "org/repo", title: "fix auth" }],
      },
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "lex/ENG-42-fix-auth",
        updatedAt: fourDaysAgo,
        checksStatus: "success",
        hasHumanApproval: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    const stale = alerts.find((a) => a.type === "stale-in-progress");
    expect(stale).toBeDefined();
    expect(stale!.entityIdentifier).toBe("ENG-42");
    expect(stale!.priority).toBe("medium");
  });

  it("does not flag in-progress ticket with recent activity", () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-42",
        title: "Fix auth",
        state: { name: "In Progress", color: "#f00", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: oneHourAgo,
        providerUrl: "https://linear.app/eng/issue/ENG-42",
      }],
      ticketToPRs: {
        "ENG-42": [{ number: 18, repo: "org/repo", title: "fix auth" }],
      },
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "lex/ENG-42-fix-auth",
        updatedAt: oneHourAgo,
        checksStatus: "success",
        hasHumanApproval: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "stale-in-progress")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/coherence.test.ts`
Expected: FAIL — module `./coherence.js` does not exist.

- [ ] **Step 3: Create `src/coherence.ts` with types and stale-in-progress rule**

```typescript
export interface CoherenceThresholds {
  branchStalenessDays: number;
  approvedUnmergedHours: number;
  reviewWaitHours: number;
  ticketInactivityDays: number;
}

export interface CoherencePR {
  number: number;
  repo: string;
  title: string;
  branch: string;
  updatedAt: string;
  checksStatus: string;
  hasHumanApproval: boolean;
  merged: boolean;
  reviewers: Array<{ login: string; state: string }>;
  pendingTriage?: number;
}

export interface CoherenceTicket {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; color: string; type: string };
  priority: number;
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  providerUrl: string;
}

export interface CoherenceInput {
  myTickets: CoherenceTicket[];
  repoLinkedTickets: CoherenceTicket[];
  authoredPRs: CoherencePR[];
  reviewRequestedPRs: CoherencePR[];
  ticketToPRs: Record<string, Array<{ number: number; repo: string; title: string }>>;
  prToTickets: Record<string, string[]>;
  thresholds: CoherenceThresholds;
  now: number;
}

export interface CoherenceAlert {
  id: string;
  type: string;
  entityKind: "pr" | "ticket";
  entityIdentifier: string;
  priority: "high" | "medium" | "low";
  title: string;
  stage?: string;
  stuckSince?: string;
}

function msToHours(ms: number): number {
  return ms / (1000 * 60 * 60);
}

function msToDays(ms: number): number {
  return msToHours(ms) / 24;
}

export function evaluateCoherence(input: CoherenceInput): CoherenceAlert[] {
  const alerts: CoherenceAlert[] = [];
  const { thresholds, now } = input;

  // Build PR lookup by "repo#number"
  const prByKey = new Map<string, CoherencePR>();
  for (const pr of [...input.authoredPRs, ...input.reviewRequestedPRs]) {
    prByKey.set(`${pr.repo}#${pr.number}`, pr);
  }

  const allTickets = [...input.myTickets, ...input.repoLinkedTickets];
  const seenTickets = new Set<string>();

  for (const ticket of allTickets) {
    if (seenTickets.has(ticket.identifier)) continue;
    seenTickets.add(ticket.identifier);

    const linkedPRs = input.ticketToPRs[ticket.identifier] ?? [];
    const linkedPRData = linkedPRs
      .map((ref) => prByKey.get(`${ref.repo}#${ref.number}`))
      .filter((pr): pr is CoherencePR => pr != null);

    // Rule: Stale "In Progress"
    if (ticket.state.type === "started" && linkedPRData.length > 0) {
      const mostRecentPRActivity = Math.max(
        ...linkedPRData.map((pr) => new Date(pr.updatedAt).getTime()),
      );
      const daysSinceActivity = msToDays(now - mostRecentPRActivity);
      if (daysSinceActivity >= thresholds.branchStalenessDays) {
        alerts.push({
          id: `stale-in-progress:${ticket.identifier}`,
          type: "stale-in-progress",
          entityKind: "ticket",
          entityIdentifier: ticket.identifier,
          priority: "medium",
          title: `${ticket.identifier} says in progress but branch is idle`,
          stage: "pr-open",
          stuckSince: new Date(mostRecentPRActivity).toISOString(),
        });
      }
    }

    // Rule: Done but unmerged
    if (
      (ticket.state.type === "completed" || ticket.state.type === "canceled") &&
      linkedPRData.some((pr) => !pr.merged)
    ) {
      const openPRs = linkedPRData.filter((pr) => !pr.merged);
      if (openPRs.length > 0) {
        const firstPR = openPRs[0]!;
        alerts.push({
          id: `done-but-unmerged:${ticket.identifier}`,
          type: "done-but-unmerged",
          entityKind: "ticket",
          entityIdentifier: ticket.identifier,
          priority: "medium",
          title: `${ticket.identifier} marked done but PR #${firstPR.number} isn't merged`,
        });
      }
    }

    // Rule: Ticket inactivity
    if (ticket.state.type === "started" || ticket.state.type === "unstarted") {
      const daysSinceUpdate = msToDays(now - new Date(ticket.updatedAt).getTime());
      if (daysSinceUpdate >= thresholds.ticketInactivityDays && linkedPRData.length === 0) {
        alerts.push({
          id: `ticket-inactive:${ticket.identifier}`,
          type: "ticket-inactive",
          entityKind: "ticket",
          entityIdentifier: ticket.identifier,
          priority: "low",
          title: `${ticket.identifier} has no activity for ${Math.floor(daysSinceUpdate)} days`,
        });
      }
    }
  }

  // PR-based rules (authored PRs only)
  for (const pr of input.authoredPRs) {
    const prKey = `${pr.repo}#${pr.number}`;

    // Rule: Approved but lingering
    if (pr.hasHumanApproval) {
      const hoursSinceUpdate = msToHours(now - new Date(pr.updatedAt).getTime());
      if (hoursSinceUpdate >= thresholds.approvedUnmergedHours) {
        const days = Math.floor(hoursSinceUpdate / 24);
        const label = days >= 1 ? `${days} day${days > 1 ? "s" : ""} ago` : `${Math.floor(hoursSinceUpdate)} hours ago`;
        alerts.push({
          id: `approved-but-lingering:${prKey}`,
          type: "approved-but-lingering",
          entityKind: "pr",
          entityIdentifier: prKey,
          priority: "medium",
          title: `PR #${pr.number} approved ${label} — merge or update?`,
          stage: "approved",
        });
      }
    }

    // Rule: PR without ticket
    const tickets = input.prToTickets[prKey];
    if (!tickets || tickets.length === 0) {
      alerts.push({
        id: `pr-without-ticket:${prKey}`,
        type: "pr-without-ticket",
        entityKind: "pr",
        entityIdentifier: prKey,
        priority: "low",
        title: `PR #${pr.number} has no linked ticket`,
      });
    }
  }

  // Rule: Review bottleneck (PRs requesting your review that have been waiting)
  for (const pr of input.reviewRequestedPRs) {
    const prKey = `${pr.repo}#${pr.number}`;
    const hoursSinceUpdate = msToHours(now - new Date(pr.updatedAt).getTime());
    if (hoursSinceUpdate >= thresholds.reviewWaitHours) {
      alerts.push({
        id: `review-bottleneck:${prKey}`,
        type: "review-bottleneck",
        entityKind: "pr",
        entityIdentifier: prKey,
        priority: "high",
        title: `PR #${pr.number} waiting on review for ${Math.floor(hoursSinceUpdate)} hours`,
      });
    }
  }

  return alerts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test src/coherence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/coherence.ts src/coherence.test.ts
git commit -m "feat: coherence engine with deterministic rule evaluation"
```

---

### Task 4: Coherence Engine — Remaining Rule Tests

**Files:**
- Modify: `src/coherence.test.ts`

- [ ] **Step 1: Add tests for remaining rules**

Append to `src/coherence.test.ts`:

```typescript
it("detects approved-but-lingering PR", () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const input = makeInput({
    authoredPRs: [{
      number: 18,
      repo: "org/repo",
      title: "fix auth",
      branch: "fix-auth",
      updatedAt: twoDaysAgo,
      checksStatus: "success",
      hasHumanApproval: true,
      merged: false,
      reviewers: [{ login: "alice", state: "APPROVED" }],
    }],
  });

  const alerts = evaluateCoherence(input);
  const alert = alerts.find((a) => a.type === "approved-but-lingering");
  expect(alert).toBeDefined();
  expect(alert!.entityIdentifier).toBe("org/repo#18");
  expect(alert!.priority).toBe("medium");
});

it("does not flag recently approved PR", () => {
  const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
  const input = makeInput({
    authoredPRs: [{
      number: 18,
      repo: "org/repo",
      title: "fix auth",
      branch: "fix-auth",
      updatedAt: oneHourAgo,
      checksStatus: "success",
      hasHumanApproval: true,
      merged: false,
      reviewers: [{ login: "alice", state: "APPROVED" }],
    }],
  });

  const alerts = evaluateCoherence(input);
  expect(alerts.find((a) => a.type === "approved-but-lingering")).toBeUndefined();
});

it("detects PR without linked ticket", () => {
  const input = makeInput({
    authoredPRs: [{
      number: 18,
      repo: "org/repo",
      title: "fix auth",
      branch: "fix-auth",
      updatedAt: new Date().toISOString(),
      checksStatus: "success",
      hasHumanApproval: false,
      merged: false,
      reviewers: [],
    }],
    prToTickets: {},
  });

  const alerts = evaluateCoherence(input);
  expect(alerts.find((a) => a.type === "pr-without-ticket")).toBeDefined();
});

it("detects review bottleneck on review-requested PR", () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const input = makeInput({
    reviewRequestedPRs: [{
      number: 42,
      repo: "org/repo",
      title: "add feature",
      branch: "add-feature",
      updatedAt: twoDaysAgo,
      checksStatus: "success",
      hasHumanApproval: false,
      merged: false,
      reviewers: [],
    }],
  });

  const alerts = evaluateCoherence(input);
  const alert = alerts.find((a) => a.type === "review-bottleneck");
  expect(alert).toBeDefined();
  expect(alert!.priority).toBe("high");
});

it("detects inactive ticket with no PR", () => {
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const input = makeInput({
    myTickets: [{
      id: "t1",
      identifier: "ENG-99",
      title: "Refactor logging",
      state: { name: "Todo", color: "#ccc", type: "unstarted" },
      priority: 3,
      labels: [],
      updatedAt: tenDaysAgo,
      providerUrl: "https://linear.app/eng/issue/ENG-99",
    }],
  });

  const alerts = evaluateCoherence(input);
  const alert = alerts.find((a) => a.type === "ticket-inactive");
  expect(alert).toBeDefined();
  expect(alert!.priority).toBe("low");
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `yarn test src/coherence.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/coherence.test.ts
git commit -m "test: add remaining coherence rule tests"
```

---

### Task 5: Attention Feed — Persistence and Merge Logic

**Files:**
- Create: `src/attention.ts`
- Create: `src/attention.test.ts`

- [ ] **Step 1: Write failing test for attention feed merge**

Create `src/attention.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { refreshAttentionFeed, getAttentionItems, snoozeItem, dismissItem, pinItem } from "./attention.js";
import type { CoherenceAlert } from "./coherence.js";
import { openStateDatabase, closeStateDatabase } from "./db/client.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "attention-test-"));
  process.env.CODE_TRIAGE_STATE_DIR = tmpDir;
  openStateDatabase();
});

afterEach(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("refreshAttentionFeed", () => {
  it("inserts new coherence alerts", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "ENG-42 says in progress but branch is idle",
      stage: "pr-open",
      stuckSince: "2026-04-10T00:00:00.000Z",
    }];

    const { added } = refreshAttentionFeed(alerts);
    expect(added).toBe(1);

    const items = getAttentionItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("stale-in-progress:ENG-42");
    expect(items[0]!.pinned).toBe(false);
  });

  it("preserves snooze/dismiss/pin state across refreshes", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "ENG-42 says in progress but branch is idle",
    }];

    refreshAttentionFeed(alerts);
    pinItem("stale-in-progress:ENG-42");

    // Refresh again with same alerts — pin should survive
    refreshAttentionFeed(alerts);
    const items = getAttentionItems({ includeAll: true });
    const item = items.find((i) => i.id === "stale-in-progress:ENG-42");
    expect(item!.pinned).toBe(true);
  });

  it("removes alerts that are no longer active", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "ENG-42 says in progress but branch is idle",
    }];

    refreshAttentionFeed(alerts);
    expect(getAttentionItems()).toHaveLength(1);

    // Refresh with empty alerts — item should be removed
    refreshAttentionFeed([]);
    expect(getAttentionItems()).toHaveLength(0);
  });
});

describe("snoozeItem", () => {
  it("snoozes an item until a given time", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "test",
    }];
    refreshAttentionFeed(alerts);

    const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    snoozeItem("stale-in-progress:ENG-42", until);

    // Default query excludes snoozed
    expect(getAttentionItems()).toHaveLength(0);
    // includeAll shows snoozed
    expect(getAttentionItems({ includeAll: true })).toHaveLength(1);
  });
});

describe("dismissItem", () => {
  it("dismisses an item", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "test",
    }];
    refreshAttentionFeed(alerts);
    dismissItem("stale-in-progress:ENG-42");

    expect(getAttentionItems()).toHaveLength(0);
  });

  it("re-fires if condition resolves and recurs", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "test",
    }];
    refreshAttentionFeed(alerts);
    dismissItem("stale-in-progress:ENG-42");

    // Condition resolves — item removed
    refreshAttentionFeed([]);
    expect(getAttentionItems({ includeAll: true })).toHaveLength(0);

    // Condition recurs — item should be re-created (not dismissed)
    refreshAttentionFeed(alerts);
    const items = getAttentionItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.dismissedAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/attention.test.ts`
Expected: FAIL — module `./attention.js` does not exist.

- [ ] **Step 3: Create `src/attention.ts`**

```typescript
import { getRawSqlite } from "./db/client.js";
import type { CoherenceAlert } from "./coherence.js";

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

  // Get existing items
  const existing = db.prepare("SELECT id, dismissed_at FROM attention_items").all() as Array<{ id: string; dismissed_at: string | null }>;
  const existingIds = new Set(existing.map((e) => e.id));

  let added = 0;
  let removed = 0;

  const run = db.transaction(() => {
    // Remove items whose condition is no longer active
    for (const row of existing) {
      if (!activeIds.has(row.id)) {
        db.prepare("DELETE FROM attention_items WHERE id = ?").run(row.id);
        removed++;
      }
    }

    // Upsert active alerts — preserve user actions (snooze/dismiss/pin)
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
        added++;
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
  return { added, removed };
}

export function getAttentionItems(opts?: { includeAll?: boolean }): AttentionItem[] {
  const db = getRawSqlite();
  const now = new Date().toISOString();

  let sql = "SELECT * FROM attention_items";
  if (!opts?.includeAll) {
    sql += " WHERE (dismissed_at IS NULL) AND (snoozed_until IS NULL OR snoozed_until <= ?)";
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
    stage: row.stage as string | undefined,
    stuckSince: row.stuck_since as string | undefined,
    firstSeenAt: row.first_seen_at as string,
    snoozedUntil: row.snoozed_until as string | undefined,
    dismissedAt: row.dismissed_at as string | undefined,
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
  // Toggle pin
  const current = db.prepare("SELECT pinned FROM attention_items WHERE id = ?").get(id) as { pinned: number } | undefined;
  if (!current) return;
  db.prepare("UPDATE attention_items SET pinned = ? WHERE id = ?").run(current.pinned ? 0 : 1, id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/attention.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/attention.ts src/attention.test.ts
git commit -m "feat: attention feed persistence with snooze/dismiss/pin"
```

---

### Task 6: Backend API — Attention Endpoints

**Files:**
- Modify: `src/api.ts`
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add attention routes to `registerRoutes()` in `src/api.ts`**

Add at the end of `registerRoutes()`:

```typescript
// ── Attention feed ──
addRoute("GET", "/api/attention", async (_req, _res, _params, query) => {
  const { getAttentionItems } = await import("./attention.js");
  const includeAll = query.get("all") === "true";
  const items = getAttentionItems({ includeAll });
  json(res, items);
});

addRoute("POST", "/api/attention/:id/snooze", async (req, res) => {
  const { until } = await getBody<{ until: string }>(req);
  const { snoozeItem } = await import("./attention.js");
  const id = decodeURIComponent(req.url!.split("/api/attention/")[1]!.split("/snooze")[0]!);
  snoozeItem(id, until);
  json(res, { ok: true });
});

addRoute("POST", "/api/attention/:id/dismiss", async (req, res) => {
  const { dismissItem } = await import("./attention.js");
  const id = decodeURIComponent(req.url!.split("/api/attention/")[1]!.split("/dismiss")[0]!);
  dismissItem(id);
  json(res, { ok: true });
});

addRoute("POST", "/api/attention/:id/pin", async (req, res) => {
  const { pinItem } = await import("./attention.js");
  const id = decodeURIComponent(req.url!.split("/api/attention/")[1]!.split("/pin")[0]!);
  pinItem(id);
  json(res, { ok: true });
});
```

Note: The route param extraction above uses URL parsing because the attention item IDs contain colons (e.g. `stale-in-progress:ENG-42`). Check how existing routes handle this pattern — if `params.id` works with the URL-encoded colon, use `params.id` instead. If not, the URL splitting approach is safer.

- [ ] **Step 2: Add attention API methods to `web/src/api.ts`**

Add to the `api` object:

```typescript
// Attention
getAttentionItems: (all?: boolean) =>
  fetchJSON<AttentionItem[]>(`/api/attention${all ? "?all=true" : ""}`),
snoozeAttentionItem: (id: string, until: string) =>
  postJSON<{ ok: boolean }>(`/api/attention/${encodeURIComponent(id)}/snooze`, { until }),
dismissAttentionItem: (id: string) =>
  postJSON<{ ok: boolean }>(`/api/attention/${encodeURIComponent(id)}/dismiss`, {}),
pinAttentionItem: (id: string) =>
  postJSON<{ ok: boolean }>(`/api/attention/${encodeURIComponent(id)}/pin`, {}),
```

Also add the `AttentionItem` type import at the top of `web/src/api.ts` or define it inline:

```typescript
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
```

- [ ] **Step 3: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add src/api.ts web/src/api.ts
git commit -m "feat: add attention feed API endpoints"
```

---

### Task 7: CLI Poll Loop — Coherence Integration

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Import coherence and attention modules at top of cli.ts**

Add imports:

```typescript
import { evaluateCoherence, type CoherenceInput, type CoherencePR } from "./coherence.js";
import { refreshAttentionFeed } from "./attention.js";
```

- [ ] **Step 2: Add coherence evaluation after ticket polling**

In `src/cli.ts`, after the ticket polling block (after the `updateTicketState({ myIssues, repoLinkedIssues, linkMap })` call, around line 517), and before the push notification block, add:

```typescript
// ── Coherence evaluation ──
try {
  const lists = await buildPullSidebarLists(repos);
  const tState = getTicketState();

  const toPRsRecord: Record<string, Array<{ number: number; repo: string; title: string }>> = {};
  if (tState?.linkMap) {
    for (const [k, v] of tState.linkMap.ticketToPRs) {
      toPRsRecord[k] = v;
    }
  }
  const toTicketsRecord: Record<string, string[]> = {};
  if (tState?.linkMap) {
    for (const [k, v] of tState.linkMap.prToTickets) {
      toTicketsRecord[k] = v;
    }
  }

  const mapPR = (p: Record<string, unknown>): CoherencePR => ({
    number: p.number as number,
    repo: p.repo as string,
    title: p.title as string,
    branch: p.branch as string,
    updatedAt: p.updatedAt as string,
    checksStatus: p.checksStatus as string,
    hasHumanApproval: p.hasHumanApproval as boolean,
    merged: false, // these are open PRs from sidebar lists
    reviewers: [],
    pendingTriage: p.pendingTriage as number | undefined,
  });

  const coherenceInput: CoherenceInput = {
    myTickets: tState?.myIssues ?? [],
    repoLinkedTickets: tState?.repoLinkedIssues ?? [],
    authoredPRs: lists.authored.map(mapPR),
    reviewRequestedPRs: lists.reviewRequested.map(mapPR),
    ticketToPRs: toPRsRecord,
    prToTickets: toTicketsRecord,
    thresholds: {
      branchStalenessDays: config.coherence?.branchStalenessDays ?? 3,
      approvedUnmergedHours: config.coherence?.approvedUnmergedHours ?? 24,
      reviewWaitHours: config.coherence?.reviewWaitHours ?? 24,
      ticketInactivityDays: config.coherence?.ticketInactivityDays ?? 5,
    },
    now: Date.now(),
  };

  const alerts = evaluateCoherence(coherenceInput);
  const { added } = refreshAttentionFeed(alerts);
  if (added > 0) {
    sseBroadcast("attention", { updated: true, newAlerts: added });
  }
} catch (err) {
  console.error(`\n  Coherence evaluation error: ${(err as Error).message}`);
}
```

Note: Check how `getTicketState()` is available — you may need to import it from wherever `updateTicketState` is defined. Look at the import for `updateTicketState` in cli.ts to find the source module.

- [ ] **Step 3: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: integrate coherence engine into poll loop"
```

---

### Task 8: Lifecycle Bar Component

**Files:**
- Create: `web/src/components/lifecycle-bar.tsx`

- [ ] **Step 1: Create the lifecycle bar component**

Create `web/src/components/lifecycle-bar.tsx`:

```tsx
import { cn } from "../lib/utils";

export type LifecycleStage =
  | "created"
  | "branch"
  | "pr-open"
  | "review-requested"
  | "approved"
  | "merged"
  | "closed";

const STAGES: { key: LifecycleStage; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "branch", label: "Branch" },
  { key: "pr-open", label: "PR" },
  { key: "review-requested", label: "Review" },
  { key: "approved", label: "Approved" },
  { key: "merged", label: "Merged" },
  { key: "closed", label: "Closed" },
];

interface LifecycleBarProps {
  /** Current stage, or undefined if lifecycle can't be determined */
  currentStage?: LifecycleStage;
  /** Whether the current stage is "stuck" (exceeds threshold) */
  stuck?: boolean;
  /** Compact mode for list views (no labels) */
  compact?: boolean;
  className?: string;
}

function stageIndex(stage: LifecycleStage): number {
  return STAGES.findIndex((s) => s.key === stage);
}

export function LifecycleBar({ currentStage, stuck, compact = true, className }: LifecycleBarProps) {
  if (!currentStage) return null;

  const currentIdx = stageIndex(currentStage);

  return (
    <div className={cn("flex items-center gap-0.5", className)} title={`Stage: ${STAGES[currentIdx]?.label}`}>
      {STAGES.map((stage, i) => {
        const isCurrent = i === currentIdx;
        const isCompleted = i < currentIdx;
        const isFuture = i > currentIdx;

        return (
          <div
            key={stage.key}
            className={cn(
              "w-1.5 h-1.5 rounded-full transition-colors",
              isCompleted && "bg-green-500",
              isCurrent && !stuck && "bg-blue-400",
              isCurrent && stuck && "bg-amber-400",
              isFuture && "bg-zinc-700",
            )}
            title={stage.label}
          />
        );
      })}
      {!compact && (
        <span className={cn(
          "ml-1 text-[10px]",
          stuck ? "text-amber-400" : "text-zinc-500",
        )}>
          {STAGES[currentIdx]?.label}
        </span>
      )}
    </div>
  );
}

/** Derive lifecycle stage from PR + ticket data */
export function deriveLifecycleStage(opts: {
  ticketState?: string; // ticket state type: "started" | "completed" | "canceled" | "unstarted"
  hasBranch?: boolean;
  prOpen?: boolean;
  hasReviewers?: boolean;
  approved?: boolean;
  merged?: boolean;
  ticketClosed?: boolean;
}): LifecycleStage {
  if (opts.ticketClosed || opts.ticketState === "completed" || opts.ticketState === "canceled") return "closed";
  if (opts.merged) return "merged";
  if (opts.approved) return "approved";
  if (opts.hasReviewers) return "review-requested";
  if (opts.prOpen) return "pr-open";
  if (opts.hasBranch) return "branch";
  return "created";
}
```

- [ ] **Step 2: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/lifecycle-bar.tsx
git commit -m "feat: lifecycle bar component with stage derivation"
```

---

### Task 9: Attention Zustand Slice

**Files:**
- Create: `web/src/store/attention-slice.ts`
- Modify: `web/src/store/types.ts`
- Modify: `web/src/store/index.ts`

- [ ] **Step 1: Add AttentionSlice interface to types.ts**

In `web/src/store/types.ts`, add before the `// ── Combined Store ──` section:

```typescript
// ── Attention Slice ──

export interface AttentionSlice {
  attentionItems: import("../api").AttentionItem[];
  attentionLoading: boolean;
  attentionError: string | null;

  fetchAttention: () => Promise<void>;
  snoozeAttention: (id: string, until: string) => Promise<void>;
  dismissAttention: (id: string) => Promise<void>;
  pinAttention: (id: string) => Promise<void>;
}
```

Update the `AppStore` type to include `AttentionSlice`:

```typescript
export type AppStore = AppSlice &
  PullsSlice &
  PrDetailSlice &
  PollStatusSlice &
  FixJobsSlice &
  NotificationsSlice &
  UiSlice &
  TicketsSlice &
  AttentionSlice;
```

- [ ] **Step 2: Create the attention slice**

Create `web/src/store/attention-slice.ts`:

```typescript
import type { SliceCreator, AttentionSlice } from "./types";
import { api } from "../api";

export const createAttentionSlice: SliceCreator<AttentionSlice> = (set) => ({
  attentionItems: [],
  attentionLoading: false,
  attentionError: null,

  fetchAttention: async () => {
    set({ attentionLoading: true, attentionError: null });
    try {
      const items = await api.getAttentionItems();
      set({ attentionItems: items, attentionLoading: false });
    } catch (err) {
      set({ attentionError: (err as Error).message, attentionLoading: false });
    }
  },

  snoozeAttention: async (id: string, until: string) => {
    await api.snoozeAttentionItem(id, until);
    set((s) => ({
      attentionItems: s.attentionItems.filter((i) => i.id !== id),
    }));
  },

  dismissAttention: async (id: string) => {
    await api.dismissAttentionItem(id);
    set((s) => ({
      attentionItems: s.attentionItems.filter((i) => i.id !== id),
    }));
  },

  pinAttention: async (id: string) => {
    await api.pinAttentionItem(id);
    set((s) => ({
      attentionItems: s.attentionItems.map((i) =>
        i.id === id ? { ...i, pinned: !i.pinned } : i,
      ),
    }));
  },
});
```

- [ ] **Step 3: Wire slice into store index.ts**

In `web/src/store/index.ts`, add the import and spread:

```typescript
import { createAttentionSlice } from "./attention-slice";
```

Add `...createAttentionSlice(...a),` in the `create()` call.

- [ ] **Step 4: Handle SSE attention events**

In the SSE connection handler (in `poll-status-slice.ts` or wherever `connectSSE` is), add a handler for the `attention` event type:

```typescript
if (event === "attention") {
  get().fetchAttention();
}
```

- [ ] **Step 5: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add web/src/store/attention-slice.ts web/src/store/types.ts web/src/store/index.ts
git commit -m "feat: attention Zustand slice with SSE integration"
```

---

### Task 10: Attention Feed Page

**Files:**
- Create: `web/src/routes/attention.tsx`
- Create: `web/src/components/attention-feed.tsx`
- Modify: `web/src/tanstack-router.ts`

- [ ] **Step 1: Create the attention feed component**

Create `web/src/components/attention-feed.tsx`:

```tsx
import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAppStore } from "../store";
import type { AttentionItem } from "../api";
import { LifecycleBar, type LifecycleStage } from "./lifecycle-bar";
import { cn } from "../lib/utils";
import { Clock, Pin, X, ExternalLink } from "lucide-react";
import { IconButton } from "./ui/icon-button";

function priorityColor(priority: string): string {
  switch (priority) {
    case "high": return "text-red-400";
    case "medium": return "text-amber-400";
    case "low": return "text-zinc-500";
    default: return "text-zinc-500";
  }
}

function priorityDot(priority: string): string {
  switch (priority) {
    case "high": return "bg-red-400";
    case "medium": return "bg-amber-400";
    case "low": return "bg-zinc-600";
    default: return "bg-zinc-600";
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SnoozeMenu({ onSnooze }: { onSnooze: (hours: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 4, 24, 72].map((h) => (
        <button
          key={h}
          onClick={() => onSnooze(h)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {h < 24 ? `${h}h` : `${h / 24}d`}
        </button>
      ))}
    </div>
  );
}

function AttentionItemRow({ item }: { item: AttentionItem }) {
  const navigate = useNavigate();
  const snooze = useAppStore((s) => s.snoozeAttention);
  const dismiss = useAppStore((s) => s.dismissAttention);
  const pin = useAppStore((s) => s.pinAttention);

  const handleJump = () => {
    if (item.entityKind === "pr") {
      // entityIdentifier is "owner/repo#42"
      const match = item.entityIdentifier.match(/^(.+?)\/(.+?)#(\d+)$/);
      if (match) {
        void navigate({ to: "/reviews/$owner/$repo/pull/$number", params: { owner: match[1]!, repo: match[2]!, number: match[3]! } });
      }
    } else {
      void navigate({ to: "/tickets/$ticketId", params: { ticketId: item.entityIdentifier } });
    }
  };

  const handleSnooze = (hours: number) => {
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    void snooze(item.id, until);
  };

  return (
    <div className={cn(
      "flex items-start gap-3 px-4 py-3 border-b border-zinc-800 hover:bg-zinc-900/50 transition-colors",
      item.pinned && "bg-zinc-900/30 border-l-2 border-l-blue-500",
    )}>
      {/* Priority dot */}
      <div className={cn("w-2 h-2 rounded-full mt-1.5 shrink-0", priorityDot(item.priority))} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <button
          onClick={handleJump}
          className="text-sm text-zinc-200 hover:text-white text-left transition-colors"
        >
          {item.title}
        </button>
        <div className="flex items-center gap-2 mt-1">
          <span className={cn("text-[10px] font-mono", priorityColor(item.priority))}>
            {item.entityIdentifier}
          </span>
          <span className="text-[10px] text-zinc-600">
            {timeAgo(item.firstSeenAt)}
          </span>
          {item.stage && (
            <LifecycleBar
              currentStage={item.stage as LifecycleStage}
              stuck={!!item.stuckSince}
              compact
            />
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <SnoozeMenu onSnooze={handleSnooze} />
        <IconButton
          description={item.pinned ? "Unpin" : "Pin"}
          icon={<Pin size={12} className={item.pinned ? "fill-blue-400 text-blue-400" : ""} />}
          onClick={() => void pin(item.id)}
          size="sm"
        />
        <IconButton
          description="Dismiss"
          icon={<X size={12} />}
          onClick={() => void dismiss(item.id)}
          size="sm"
        />
        <IconButton
          description="Jump to detail"
          icon={<ExternalLink size={12} />}
          onClick={handleJump}
          size="sm"
        />
      </div>
    </div>
  );
}

export function AttentionFeed() {
  const items = useAppStore((s) => s.attentionItems);
  const loading = useAppStore((s) => s.attentionLoading);
  const error = useAppStore((s) => s.attentionError);
  const fetchAttention = useAppStore((s) => s.fetchAttention);

  useEffect(() => {
    void fetchAttention();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading attention feed...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm">
        Error: {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-2">
        <Clock size={32} className="text-zinc-700" />
        <span className="text-sm">Nothing needs your attention right now</span>
      </div>
    );
  }

  const pinned = items.filter((i) => i.pinned);
  const unpinned = items.filter((i) => !i.pinned);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-zinc-800 shrink-0">
        <h2 className="text-sm font-semibold text-zinc-200">Needs Your Attention</h2>
        <span className="text-[10px] text-zinc-600">{items.length} item{items.length !== 1 ? "s" : ""}</span>
      </div>
      {pinned.length > 0 && (
        <>
          <div className="px-4 py-1 text-[10px] uppercase tracking-wide text-zinc-600 bg-zinc-900/50 border-b border-zinc-800">
            Pinned
          </div>
          {pinned.map((item) => (
            <AttentionItemRow key={item.id} item={item} />
          ))}
        </>
      )}
      {unpinned.map((item) => (
        <AttentionItemRow key={item.id} item={item} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create the attention route**

Create `web/src/routes/attention.tsx`:

```tsx
import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { AttentionFeed } from "../components/attention-feed";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "attention",
  component: function AttentionPage() {
    return <AttentionFeed />;
  },
});
```

- [ ] **Step 3: Register the route in tanstack-router.ts**

In `web/src/tanstack-router.ts`, add the import and route:

```typescript
import { Route as attentionRoute } from "./routes/attention";
```

Add `attentionRoute` as a child of `rootRoute` in the route tree:

```typescript
const routeTree = rootRoute.addChildren([
  attentionRoute,
  sidebarRoute.addChildren([
    indexRedirectRoute,
    reviewsIndexRoute,
    codeReviewRepoRoute,
    codeReviewPRRoute,
    ticketsIndexRoute,
    ticketsDetailRoute,
  ]),
  settingsRoute,
]);
```

- [ ] **Step 4: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/attention.tsx web/src/components/attention-feed.tsx web/src/tanstack-router.ts
git commit -m "feat: attention feed page with prioritized items"
```

---

### Task 11: Icon Rail — Attention Icon with Badge

**Files:**
- Modify: `web/src/components/icon-rail.tsx`

- [ ] **Step 1: Add attention icon to icon rail**

In `web/src/components/icon-rail.tsx`:

Add an `InboxIcon` SVG component (or use `Inbox` from `lucide-react`). Add a new `Link` to `/attention` as the first item in the rail, above Code Review. Include a badge count from the store.

```tsx
import { Inbox } from "lucide-react";
```

In the `IconRail` component, add store selector:

```tsx
const attentionCount = useAppStore((s) => s.attentionItems.length);
const isAttention = !!matchRoute({ to: "/attention" });
```

Add the attention link as the first item in the icon rail div, before the Code Review link:

```tsx
<Link
  to="/attention"
  className={cn("relative flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
    isAttention
      ? "bg-zinc-700 text-white"
      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
  )}
  title="Attention"
>
  <Inbox size={20} />
  {attentionCount > 0 && (
    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-medium text-white px-1">
      {attentionCount > 99 ? "99+" : attentionCount}
    </span>
  )}
</Link>
```

- [ ] **Step 2: Update default redirect**

In `web/src/routes/_sidebar/index.tsx`, change the redirect from `/reviews` to `/attention`:

```typescript
beforeLoad: () => {
  throw redirect({ to: "/attention" });
},
```

- [ ] **Step 3: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/icon-rail.tsx web/src/routes/_sidebar/index.tsx
git commit -m "feat: attention icon in icon rail with badge count"
```

---

### Task 12: Lifecycle Bar in PR List and Tickets Sidebar

**Files:**
- Modify: `web/src/components/pr-list.tsx`
- Modify: `web/src/components/tickets-sidebar.tsx`

- [ ] **Step 1: Add lifecycle bar to PR list items**

In `web/src/components/pr-list.tsx`, import the lifecycle bar:

```typescript
import { LifecycleBar, deriveLifecycleStage } from "./lifecycle-bar";
```

Add the store selector for ticket linkage:

```typescript
const prToTickets = useAppStore((s) => s.prToTickets);
const myTickets = useAppStore((s) => s.myTickets);
const repoLinkedTickets = useAppStore((s) => s.repoLinkedTickets);
```

For each PR in the list, if it has a linked ticket, derive the lifecycle stage and render the bar. Add the `<LifecycleBar>` in the PR row's metadata area (after the branch/repo info):

```tsx
{(() => {
  const prKey = `${pr.repo}#${pr.number}`;
  const ticketIds = prToTickets[prKey];
  if (!ticketIds || ticketIds.length === 0) return null;
  const ticket = [...myTickets, ...repoLinkedTickets].find((t) => ticketIds.includes(t.identifier));
  const stage = deriveLifecycleStage({
    ticketState: ticket?.state.type,
    hasBranch: true,
    prOpen: true,
    hasReviewers: false, // would need reviewer data
    approved: pr.hasHumanApproval,
    merged: false, // these are open PRs
    ticketClosed: ticket?.state.type === "completed" || ticket?.state.type === "canceled",
  });
  return <LifecycleBar currentStage={stage} compact />;
})()}
```

- [ ] **Step 2: Add lifecycle bar to tickets sidebar**

In `web/src/components/tickets-sidebar.tsx`, import:

```typescript
import { LifecycleBar, deriveLifecycleStage } from "./lifecycle-bar";
```

In the `TicketCard` component, add a store selector for PR linkage and render the lifecycle bar:

```typescript
const prToTickets = useAppStore((s) => s.prToTickets);
```

After the assignee/label area in each ticket card, add:

```tsx
{(() => {
  const linkedPRKeys = Object.entries(prToTickets)
    .filter(([, ids]) => ids.includes(issue.identifier))
    .map(([k]) => k);
  const hasPR = linkedPRKeys.length > 0;
  const stage = deriveLifecycleStage({
    ticketState: issue.state.type,
    hasBranch: hasPR,
    prOpen: hasPR,
  });
  return <LifecycleBar currentStage={stage} compact className="mt-1" />;
})()}
```

- [ ] **Step 3: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/pr-list.tsx web/src/components/tickets-sidebar.tsx
git commit -m "feat: lifecycle bars in PR list and tickets sidebar"
```

---

### Task 13: Coherence Config in Settings Page

**Files:**
- Modify: `web/src/store/types.ts` (SettingsFormState)
- Modify: `web/src/components/settings-view.tsx`
- Modify: `web/src/api.ts` (AppConfigPayload)

- [ ] **Step 1: Add coherence fields to AppConfigPayload**

In `web/src/api.ts`, add to `AppConfigPayload`:

```typescript
coherence: {
  branchStalenessDays: number;
  approvedUnmergedHours: number;
  reviewWaitHours: number;
  ticketInactivityDays: number;
};
```

- [ ] **Step 2: Add coherence fields to SettingsFormState**

In `web/src/store/types.ts`, add to `SettingsFormState`:

```typescript
coherenceBranchStalenessDays: number;
coherenceApprovedUnmergedHours: number;
coherenceReviewWaitHours: number;
coherenceTicketInactivityDays: number;
```

- [ ] **Step 3: Add coherence section to settings view**

In `web/src/components/settings-view.tsx`, add a "Coherence Thresholds" section with number inputs for each threshold. Follow the existing pattern of other numeric fields in the settings form.

Initialize the form fields from config:

```typescript
coherenceBranchStalenessDays: config.coherence?.branchStalenessDays ?? 3,
coherenceApprovedUnmergedHours: config.coherence?.approvedUnmergedHours ?? 24,
coherenceReviewWaitHours: config.coherence?.reviewWaitHours ?? 24,
coherenceTicketInactivityDays: config.coherence?.ticketInactivityDays ?? 5,
```

On save, map back to config shape:

```typescript
coherence: {
  branchStalenessDays: form.coherenceBranchStalenessDays,
  approvedUnmergedHours: form.coherenceApprovedUnmergedHours,
  reviewWaitHours: form.coherenceReviewWaitHours,
  ticketInactivityDays: form.coherenceTicketInactivityDays,
},
```

- [ ] **Step 4: Update backend GET /api/config to include coherence**

In `src/api.ts`, in the `GET /api/config` handler, add coherence to the response payload:

```typescript
coherence: {
  branchStalenessDays: config.coherence?.branchStalenessDays ?? 3,
  approvedUnmergedHours: config.coherence?.approvedUnmergedHours ?? 24,
  reviewWaitHours: config.coherence?.reviewWaitHours ?? 24,
  ticketInactivityDays: config.coherence?.ticketInactivityDays ?? 5,
},
```

- [ ] **Step 5: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/store/types.ts web/src/components/settings-view.tsx src/api.ts
git commit -m "feat: coherence threshold settings in web UI"
```

---

### Task 14: Initial Data Loading and SSE Wiring

**Files:**
- Modify: `web/src/routes/__root.tsx`
- Modify: `web/src/store/poll-status-slice.ts`

- [ ] **Step 1: Fetch attention items on app ready**

In `web/src/routes/__root.tsx`, in the `useEffect` that runs when `appGate === "ready"` (around line 61), add:

```typescript
void s.fetchAttention();
```

This ensures attention items are loaded when the app starts.

- [ ] **Step 2: Add attention event handler in SSE connection**

In the SSE handler (in `poll-status-slice.ts`), find where events are dispatched by type. Add handling for the `"attention"` event:

```typescript
case "attention":
  get().fetchAttention();
  break;
```

Also handle it on `"poll"` events — after a poll completes, refresh the attention feed:

```typescript
case "poll":
  // existing poll handling...
  get().fetchAttention();
  break;
```

- [ ] **Step 3: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/__root.tsx web/src/store/poll-status-slice.ts
git commit -m "feat: load attention items on startup and refresh via SSE"
```

---

### Task 15: CI Failure and Pending Review Attention Events

**Files:**
- Modify: `src/coherence.ts`
- Modify: `src/coherence.test.ts`

The spec lists several attention event types beyond coherence mismatches. Add rules for CI failures and pending review PRs.

- [ ] **Step 1: Add tests for CI failure and pending-review rules**

In `src/coherence.test.ts`, add:

```typescript
it("detects CI failure on authored PR", () => {
  const input = makeInput({
    authoredPRs: [{
      number: 18,
      repo: "org/repo",
      title: "fix auth",
      branch: "fix-auth",
      updatedAt: new Date().toISOString(),
      checksStatus: "failure",
      hasHumanApproval: false,
      merged: false,
      reviewers: [],
    }],
  });

  const alerts = evaluateCoherence(input);
  const alert = alerts.find((a) => a.type === "ci-failure");
  expect(alert).toBeDefined();
  expect(alert!.priority).toBe("medium");
});

it("detects ticket assigned with no PR", () => {
  const input = makeInput({
    myTickets: [{
      id: "t1",
      identifier: "ENG-50",
      title: "Build feature",
      state: { name: "In Progress", color: "#f00", type: "started" },
      priority: 1,
      labels: [],
      updatedAt: new Date().toISOString(),
      providerUrl: "https://linear.app/eng/issue/ENG-50",
    }],
    ticketToPRs: {},
  });

  const alerts = evaluateCoherence(input);
  const alert = alerts.find((a) => a.type === "ticket-no-pr");
  expect(alert).toBeDefined();
  expect(alert!.priority).toBe("medium");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/coherence.test.ts`
Expected: FAIL — no `ci-failure` or `ticket-no-pr` alerts generated.

- [ ] **Step 3: Add CI failure rule to coherence engine**

In `src/coherence.ts`, in the authored PR loop, add:

```typescript
// Rule: CI failure
if (pr.checksStatus === "failure") {
  alerts.push({
    id: `ci-failure:${prKey}`,
    type: "ci-failure",
    entityKind: "pr",
    entityIdentifier: prKey,
    priority: "medium",
    title: `PR #${pr.number} CI is failing`,
    stage: pr.hasHumanApproval ? "approved" : "review-requested",
  });
}
```

Add a ticket-no-PR rule in the ticket loop (when ticket is "started" and has no linked PRs):

```typescript
// Rule: Ticket assigned with no PR
if ((ticket.state.type === "started") && linkedPRData.length === 0) {
  alerts.push({
    id: `ticket-no-pr:${ticket.identifier}`,
    type: "ticket-no-pr",
    entityKind: "ticket",
    entityIdentifier: ticket.identifier,
    priority: "medium",
    title: `${ticket.identifier} is in progress but has no PR`,
    stage: "created",
  });
}
```

Note: The `ticket-no-pr` rule should not overlap with the `ticket-inactive` rule. `ticket-no-pr` fires for active "started" tickets with no PR regardless of time. `ticket-inactive` fires for tickets with no activity over N days and no PR. Add a guard so `ticket-inactive` only fires for `unstarted` tickets, and `ticket-no-pr` fires for `started` tickets.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/coherence.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/coherence.ts src/coherence.test.ts
git commit -m "feat: CI failure and ticket-no-PR attention events"
```

---

### Task 16: Notification Integration for Coherence Alerts

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Wire new attention alerts into desktop notifications**

In `src/cli.ts`, in the coherence evaluation block (added in Task 7), after `refreshAttentionFeed(alerts)`, add notification dispatch for new alerts:

```typescript
if (added > 0) {
  sseBroadcast("attention", { updated: true, newAlerts: added });
  // Desktop notification for new coherence alerts
  try {
    const { getAttentionItems } = await import("./attention.js");
    const items = getAttentionItems();
    const highPriority = items.filter((i) => i.priority === "high");
    if (highPriority.length > 0) {
      const notifier = await import("node-notifier");
      notifier.default.notify({
        title: "Code Triage — Needs Attention",
        message: highPriority.length === 1
          ? highPriority[0]!.title
          : `${highPriority.length} high-priority items need your attention`,
      });
    }
  } catch { /* notification failure is non-fatal */ }
}
```

- [ ] **Step 2: Verify build compiles**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: desktop notifications for high-priority attention alerts"
```

---

### Task 17: End-to-End Verification

**Files:** None — testing and cleanup only.

- [ ] **Step 1: Run full test suite**

Run: `yarn test`
Expected: All tests pass.

- [ ] **Step 2: Run full build**

Run: `yarn build:all`
Expected: Clean compilation.

- [ ] **Step 3: Smoke test**

Run: `yarn start`
Expected:
- Server starts and serves web UI
- `/attention` route loads and shows empty state ("Nothing needs your attention right now")
- Icon rail shows attention icon at top
- Default redirect goes to `/attention`
- Reviews and tickets routes still work
- Settings page shows coherence thresholds section

- [ ] **Step 4: Commit any final fixes**

If any issues were found during smoke testing, fix them and commit.

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
