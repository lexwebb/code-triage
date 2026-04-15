# Attention Dual-Column + Team Snapshot + Linear Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the attention page as a two-column layout (personal feed + aggregate team snapshot), backed by `GET /api/team/overview` with SQLite cache and slow refresh, manual refresh with a 30s client cooldown, SSE invalidation, and reduce Linear N+1 calls by consolidating list GraphQL.

**Architecture:** Extend `Config` with a `team` block; persist a JSON snapshot row in SQLite; CLI refreshes snapshot on a wall-clock interval when `team.enabled`; HTTP serves cache immediately and triggers background refresh only via explicit `POST`; web uses TanStack Query + Zustand mirror like attention; Linear list paths use one GraphQL `issues` query shape with embedded `labels` and `attachments` (no per-issue `labels()` / `attachments()` calls).

**Tech Stack:** Node 20+, TypeScript, better-sqlite3, Drizzle (schema mirror), `@linear/sdk` + raw `fetch` to Linear GraphQL where needed, Octokit `graphql` via `ghGraphQL`, React 19, TanStack Query, Zustand, Vitest.

---

## File map

| Path | Role |
|------|------|
| `docs/superpowers/specs/2026-04-15-attention-dual-column-design.md` | UX + API budget spec (source of truth) |
| `src/config.ts` | Add `team?: { enabled?: boolean; pollIntervalMinutes?: number }` with defaults |
| `src/api.ts` | `serializeConfigForClient`, `mergeConfigFromBody`; routes `GET/POST /api/team/overview` |
| `src/db/client.ts` | `CREATE TABLE IF NOT EXISTS team_overview_cache (...)` |
| `src/db/schema.ts` | Optional Drizzle table `teamOverviewCache` mirroring the SQL |
| `src/team/overview.ts` | Build snapshot DTO, read/write cache, orchestrate GitHub + ticket data |
| `src/team/overview.test.ts` | Cache round-trip + DTO shape tests |
| `src/tickets/linear-gql.ts` | `linearGraphQL<T>(apiKey, query, variables)`, `recordLinearRequest` |
| `src/tickets/linear.ts` | Use fat query for `fetchMyIssues` / `fetchIssuesByIdentifiers`; keep `getIssueDetail` on-demand |
| `src/tickets/linear.test.ts` | Update mocks / expectations for batch behavior |
| `src/cli.ts` | Interval refresh of team snapshot + `sseBroadcast("team-overview", ...)` |
| `web/src/api.ts` | `TeamOverviewSnapshot` type, `getTeamOverview`, `refreshTeamOverview` |
| `web/src/lib/query-keys.ts` | `qk.team.overview` |
| `web/src/lib/team-manual-refresh-cooldown.ts` | Pure 30s cooldown helper |
| `web/src/lib/team-manual-refresh-cooldown.test.ts` | Cooldown unit tests |
| `web/src/store/types.ts` | `TeamSnapshotSlice` |
| `web/src/store/team-snapshot-slice.ts` | Mirror query into Zustand (optional thin) |
| `web/src/store/index.ts` | Merge `createTeamSnapshotSlice` |
| `web/src/components/server-query-sync.tsx` | `useQuery` for team overview when `config.team?.enabled` |
| `web/src/store/poll-status-slice.ts` | SSE listener `team-overview` → invalidate `qk.team.root` |
| `web/src/components/attention-page-layout.tsx` | Two-column desktop; mobile stack + collapsible team |
| `web/src/components/team-snapshot-panel.tsx` | Sections + refresh button + error/retry |
| `web/src/routes/attention.tsx` | Render layout instead of bare `AttentionFeed` |
| `web/src/components/settings-view.tsx` | Team section (enabled + poll interval) |
| `web/src/store/settings-form.ts`, `web/src/store/ui-slice.ts` | Form fields + submit payload |
| `vitest.config.ts` | Vitest `projects` for `node` + `jsdom` (web unit tests) |

---

### Task 1: Team config (server)

**Files:**
- Modify: `src/config.ts`
- Modify: `src/api.ts` (`serializeConfigForClient`, `mergeConfigFromBody` return object)
- Test: `src/config.test.ts` (create if missing) or extend existing config merge tests

- [ ] **Step 1: Extend `Config` and defaults**

Modify `src/config.ts`:

```ts
// Inside export interface Config { ... }
  team?: {
    enabled?: boolean;
    /** Minutes between CLI-driven team snapshot refreshes. Default 5. */
    pollIntervalMinutes?: number;
  };

// Inside DEFAULTS (merge with existing object — do not replace the whole DEFAULTS):
  team: {
    enabled: false,
    pollIntervalMinutes: 5,
  },
```

- [ ] **Step 2: Serialize and merge team fields**

In `src/api.ts`, extend `serializeConfigForClient`:

```ts
    team: {
      enabled: c.team?.enabled === true,
      pollIntervalMinutes: c.team?.pollIntervalMinutes ?? 5,
    },
```

In `mergeConfigFromBody`, after the `coherence` block, before `return {`:

```ts
  const teamBody =
    typeof body.team === "object" && body.team !== null ? (body.team as Record<string, unknown>) : undefined;
  const previousTeam = previous.team ?? {};
  const team = {
    enabled:
      typeof teamBody?.enabled === "boolean" ? teamBody.enabled : (previousTeam.enabled === true),
    pollIntervalMinutes: Math.max(
      1,
      toInt(teamBody?.pollIntervalMinutes, previousTeam.pollIntervalMinutes ?? 5),
    ),
  };
```

In `serializeConfigForClient`, add a `team` property next to `coherence` (same object that is returned today).

In `mergeConfigFromBody`, add `team` next to `coherence` in the returned `Config` object:

```ts
    coherence,
    team,
```

- [ ] **Step 3: Run tests**

Run: `yarn test`

Expected: PASS (fix any compile errors in `src/api.ts` if `Config` import needs updating)

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/api.ts
git commit -m "feat(config): add team snapshot settings"
```

---

### Task 2: `team_overview_cache` table

**Files:**
- Modify: `src/db/client.ts` (`ensureSchema`)
- Modify: `src/db/schema.ts` (optional drizzle table)
- Test: `src/team/overview.test.ts` (Task 4 can create this file; minimal schema smoke via `getRawSqlite()`)

- [ ] **Step 1: Add SQL DDL**

In `ensureSchema` inside `src/db/client.ts`, append:

```sql
    CREATE TABLE IF NOT EXISTS team_overview_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      refresh_error TEXT
    );
```

- [ ] **Step 2: Commit**

```bash
git add src/db/client.ts
git commit -m "feat(db): add team_overview_cache table"
```

---

### Task 3: Linear GraphQL helper + fat `issues` query

**Files:**
- Create: `src/tickets/linear-gql.ts`
- Modify: `src/tickets/linear.ts`
- Modify: `src/tickets/linear.test.ts`

- [ ] **Step 1: Add `linearGraphQL`**

Create `src/tickets/linear-gql.ts`:

```ts
import { recordLinearRequest } from "./stats.js";

const LINEAR_GQL_URL = "https://api.linear.app/graphql";

export async function linearGraphQL<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  recordLinearRequest("graphql");
  const res = await fetch(LINEAR_GQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!res.ok) {
    throw new Error(`Linear GraphQL HTTP ${res.status}`);
  }
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) {
    throw new Error("Linear GraphQL returned no data");
  }
  return json.data;
}
```

- [ ] **Step 2: Define shared query string for list fetch**

In `src/tickets/linear.ts` (top-level constant):

```ts
const ISSUES_LIST_GQL = `
  query IssuesForCodeTriage($filter: IssueFilter!, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        priority
        updatedAt
        completedAt
        canceledAt
        url
        description
        state { name color type }
        assignee { name avatarUrl }
        labels { nodes { name color } }
        attachments { nodes { url title } }
      }
    }
  }
`;
```

- [ ] **Step 3: Map a GraphQL node to `TicketIssue` without extra fetches**

Add a function in `src/tickets/linear.ts`:

```ts
import { linearGraphQL } from "./linear-gql.js";
import { parseGithubPullRequestUrl, type LinkedPRRef } from "./linker.js";

type GqlIssueNode = {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  updatedAt: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  url: string;
  description?: string | null;
  state?: { name: string; color: string; type: string } | null;
  assignee?: { name: string; avatarUrl?: string | null } | null;
  labels?: { nodes: Array<{ name: string; color: string }> };
  attachments?: { nodes: Array<{ url: string; title?: string | null }> };
};

function ticketIssueFromGqlNode(node: GqlIssueNode): TicketIssue {
  const labelNodes = node.labels?.nodes ?? [];
  const attachmentRefs: LinkedPRRef[] = [];
  for (const a of node.attachments?.nodes ?? []) {
    const p = parseGithubPullRequestUrl(a.url);
    if (p) attachmentRefs.push({ repo: p.repo, number: p.number, title: a.title ?? "" });
  }
  const state = node.state;
  const stateName = state?.name ?? "";
  const terminalByWorkflowName =
    /\b(merged|done|complete|completed|closed|shipped|released|deployed)\b/i.test(stateName)
 || /\b(wont fix|won't fix|cancelled|canceled)\b/i.test(stateName);

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    state: state
      ? { name: state.name, color: state.color, type: state.type }
      : { name: "Unknown", color: "#888888", type: "unstarted" },
    priority: node.priority,
    isDone: Boolean(
      node.completedAt
        || node.canceledAt
        || state?.type === "completed"
        || state?.type === "canceled"
        || terminalByWorkflowName,
    ),
    providerLinkedPulls: attachmentRefs.length > 0 ? dedupeLinkedPrRefs(attachmentRefs) : undefined,
    assignee: node.assignee ? { name: node.assignee.name, avatarUrl: node.assignee.avatarUrl ?? undefined } : undefined,
    labels: labelNodes.map((l) => ({ name: l.name, color: l.color })),
    updatedAt: node.updatedAt,
    providerUrl: node.url,
  };
}
```

- [ ] **Step 4: Replace `fetchMyIssues` body to use pagination loop with one HTTP request per page**

**Important:** Add `private readonly linearApiKey: string` to `LinearProvider`, and assign `this.linearApiKey = apiKey` in the existing constructor (the first parameter is already the API key).

Then implement pagination:

```ts
    const filter = { /* existing filter object */ };
    const all: TicketIssue[] = [];
    let after: string | undefined;
    for (;;) {
      type GqlData = {
        issues: {
          pageInfo: { hasNextPage: boolean; endCursor?: string | null };
          nodes: GqlIssueNode[];
        };
      };
      const data = await linearGraphQL<GqlData>(this.linearApiKey, ISSUES_LIST_GQL, {
        filter,
        first: 50,
        after: after ?? null,
      });
      for (const n of data.issues.nodes) {
        all.push(ticketIssueFromGqlNode(n));
      }
      if (!data.issues.pageInfo.hasNextPage) break;
      after = data.issues.pageInfo.endCursor ?? undefined;
      if (!after) break;
    }
    this.primeIdentifierCache(all);
    return all;
```

Remove the old `recordLinearRequest("issues")` + SDK `issues` call for this method (keep `recordLinearRequest` inside `linearGraphQL`).

- [ ] **Step 5: Replace `fetchIssuesByIdentifiers` per-team bucket with the same GQL query**

For each `teamKey` bucket, call `linearGraphQL` with:

```ts
        filter: {
          team: { key: { eq: teamKey } },
          number: { in: numbers },
        },
```

Map nodes with `ticketIssueFromGqlNode`.

- [ ] **Step 6: Keep `getIssueDetail` using SDK (comments are intentionally expensive)**

Leave `getIssueDetail` as-is.

- [ ] **Step 7: Remove N+1 from `mapIssue` for SDK-backed paths**

If `mapIssue` is still used by `getIssueDetail`, keep label/attachment fetching there **only** for that path. List paths must not call `mapIssue` anymore.

- [ ] **Step 8: Run tests**

Run: `yarn test`

Expected: PASS; update `src/tickets/linear.test.ts` mocks if they assumed SDK `issues()` — switch tests to stub `globalThis.fetch` for Linear GraphQL or inject a test double.

- [ ] **Step 9: Commit**

```bash
git add src/tickets/linear-gql.ts src/tickets/linear.ts src/tickets/linear.test.ts
git commit -m "perf(linear): batch issue list fields in one GraphQL query"
```

---

### Task 4: Team overview DTO + cache accessors

**Files:**
- Create: `src/team/overview.ts`
- Create: `src/team/overview.test.ts`

- [ ] **Step 1: Define DTO**

Create `src/team/overview.ts`:

```ts
import { getRawSqlite } from "../db/client.js";

export interface TeamOverviewSnapshot {
  generatedAt: string;
  summaryCounts: {
    stuck: number;
    awaitingReview: number;
    recentlyMerged: number;
    unlinkedPrs: number;
    unlinkedTickets: number;
  };
  stuck: Array<{ entityKind: "pr" | "ticket"; entityIdentifier: string; title: string }>;
  awaitingReview: Array<{ repo: string; number: number; title: string; waitHours: number }>;
  recentlyMerged: Array<{ repo: string; number: number; title: string; mergedAt: string }>;
  unlinkedPrs: Array<{ repo: string; number: number; title: string }>;
  unlinkedTickets: Array<{ identifier: string; title: string }>;
}

export function readTeamOverviewCache():
  | { snapshot: TeamOverviewSnapshot; updatedAtMs: number; refreshError: string | null }
  | null {
  const db = getRawSqlite();
  const row = db.prepare(
    "SELECT payload_json, updated_at_ms, refresh_error FROM team_overview_cache WHERE id = 1",
  ).get() as { payload_json: string; updated_at_ms: number; refresh_error: string | null } | undefined;
  if (!row) return null;
  return {
    snapshot: JSON.parse(row.payload_json) as TeamOverviewSnapshot,
    updatedAtMs: row.updated_at_ms,
    refreshError: row.refresh_error,
  };
}

export function writeTeamOverviewCache(snapshot: TeamOverviewSnapshot, errorMessage: string | null): void {
  const db = getRawSqlite();
  const now = Date.now();
  db.prepare(
    `INSERT INTO team_overview_cache (id, payload_json, updated_at_ms, refresh_error)
     VALUES (1, @payload_json, @updated_at_ms, @refresh_error)
     ON CONFLICT(id) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at_ms = excluded.updated_at_ms,
       refresh_error = excluded.refresh_error`,
  ).run({
    payload_json: JSON.stringify(snapshot),
    updated_at_ms: now,
    refresh_error: errorMessage,
  });
}
```

- [ ] **Step 2: Add a stub builder used in later tasks**

In the same file, add:

```ts
export async function rebuildTeamOverviewSnapshot(): Promise<{ snapshot: TeamOverviewSnapshot; error: string | null }> {
  const snapshot: TeamOverviewSnapshot = {
    generatedAt: new Date().toISOString(),
    summaryCounts: { stuck: 0, awaitingReview: 0, recentlyMerged: 0, unlinkedPrs: 0, unlinkedTickets: 0 },
    stuck: [],
    awaitingReview: [],
    recentlyMerged: [],
    unlinkedPrs: [],
    unlinkedTickets: [],
  };
  return { snapshot, error: null };
}
```

(Task 5 replaces this stub with real aggregation.)

- [ ] **Step 3: Write a cache test**

Create `src/team/overview.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDatabase, openStateDatabase } from "../db/client.js";
import { readTeamOverviewCache, writeTeamOverviewCache, type TeamOverviewSnapshot } from "./overview.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "team-overview-test-"));
  process.env.CODE_TRIAGE_STATE_DIR = tmpDir;
  openStateDatabase();
});

afterEach(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("team overview cache", () => {
  it("round-trips snapshot", () => {
    const snap: TeamOverviewSnapshot = {
      generatedAt: "2026-04-15T00:00:00.000Z",
      summaryCounts: { stuck: 1, awaitingReview: 2, recentlyMerged: 3, unlinkedPrs: 4, unlinkedTickets: 5 },
      stuck: [],
      awaitingReview: [],
      recentlyMerged: [],
      unlinkedPrs: [],
      unlinkedTickets: [],
    };
    writeTeamOverviewCache(snap, null);
    const read = readTeamOverviewCache();
    expect(read?.snapshot.summaryCounts.stuck).toBe(1);
    expect(read?.refreshError).toBeNull();
  });
});
```

**Note:** This test requires Task 2 DDL in `ensureSchema` so `team_overview_cache` exists before `writeTeamOverviewCache` runs.

- [ ] **Step 4: Run tests**

Run: `yarn test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/team/overview.ts src/team/overview.test.ts
git commit -m "feat(team): add overview snapshot cache helpers"
```

---

### Task 5: HTTP routes for overview + refresh

**Files:**
- Modify: `src/api.ts`
- Modify: `src/team/overview.ts` (wire real rebuild when ready)

- [ ] **Step 1: Add routes**

In `registerRoutes()`:

```ts
  addRoute("GET", "/api/team/overview", async (_req, res) => {
    const c = loadConfig();
    if (!c.team?.enabled) {
      res.writeHead(404);
      json(res, { error: "Team features disabled" });
      return;
    }
    const { readTeamOverviewCache } = await import("./team/overview.js");
    const row = readTeamOverviewCache();
    if (!row) {
      json(res, {
        snapshot: null,
        updatedAtMs: null,
        refreshError: null,
        stale: true,
      });
      return;
    }
    json(res, {
      snapshot: row.snapshot,
      updatedAtMs: row.updatedAtMs,
      refreshError: row.refreshError,
      stale: false,
    });
  });

  addRoute("POST", "/api/team/overview/refresh", async (_req, res) => {
    const c = loadConfig();
    if (!c.team?.enabled) {
      res.writeHead(404);
      json(res, { error: "Team features disabled" });
      return;
    }
    const { rebuildTeamOverviewSnapshot, writeTeamOverviewCache } = await import("./team/overview.js");
    try {
      const { snapshot, error } = await rebuildTeamOverviewSnapshot();
      writeTeamOverviewCache(snapshot, error);
      json(res, { ok: true, snapshot, error });
    } catch (e) {
      const msg = (e as Error).message;
      json(res, { ok: false, error: msg }, 500);
    }
  });
```

- [ ] **Step 2: Replace `rebuildTeamOverviewSnapshot` stub with real aggregation**

Implement using existing primitives:

- GitHub: reuse `buildPullSidebarLists` from `src/api.ts` (export it if needed) + `fetchMergedAuthoredLinkablePRs` patterns from `src/cli.ts` (move shared pieces into `src/github/sidebar.ts` if circular imports appear).
- Tickets: reuse `getTicketState()` maps (`myIssues`, `repoLinkedIssues`, `linkMap`).
- Coherence: import `evaluateCoherence` from `src/coherence.js` and build `CoherenceInput` **for team scope** per Team Radar spec (this is the largest piece; keep functions pure and covered by `src/team/overview.test.ts` with fixture inputs).

**Acceptance:** `rebuildTeamOverviewSnapshot` performs no per-issue Linear N+1 (lists come from already-fetched ticket state + one GraphQL list pass in ticket poll).

- [ ] **Step 3: Run tests**

Run: `yarn test`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/api.ts src/team/overview.ts
git commit -m "feat(api): team overview cache endpoints"
```

---

### Task 6: CLI interval refresh + SSE

**Files:**
- Modify: `src/cli.ts`
- Grep + modify: `src/cli.ts` or `src/server.ts` for `sseBroadcast` import path

- [ ] **Step 1: Add timer-driven refresh**

Near other poll bookkeeping, track `lastTeamOverviewRefreshMs`. After a successful poll cycle (or on its own slower cadence), if `config.team?.enabled`:

```ts
      const intervalMs = (config.team?.pollIntervalMinutes ?? 5) * 60_000;
      if (Date.now() - lastTeamOverviewRefreshMs >= intervalMs) {
        lastTeamOverviewRefreshMs = Date.now();
        const { rebuildTeamOverviewSnapshot, writeTeamOverviewCache } = await import("./team/overview.js");
        const { snapshot, error } = await rebuildTeamOverviewSnapshot();
        writeTeamOverviewCache(snapshot, error);
        sseBroadcast("team-overview", { updated: true });
      }
```

- [ ] **Step 2: Run smoke**

Run: `yarn build:all`

Expected: clean compile

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): refresh team overview on interval"
```

---

### Task 7: Web types + API client + query keys + SSE invalidate

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/lib/query-keys.ts`
- Modify: `web/src/store/poll-status-slice.ts`
- Modify: `web/src/store/types.ts`, `web/src/store/settings-form.ts`, `web/src/store/ui-slice.ts`, `web/src/components/settings-view.tsx`

- [ ] **Step 1: Add client types + API methods**

In `web/src/api.ts` extend `AppConfigPayload`:

```ts
  team: {
    enabled: boolean;
    pollIntervalMinutes: number;
  };
```

Add:

```ts
export interface TeamOverviewSnapshot {
  generatedAt: string;
  summaryCounts: {
    stuck: number;
    awaitingReview: number;
    recentlyMerged: number;
    unlinkedPrs: number;
    unlinkedTickets: number;
  };
  stuck: Array<{ entityKind: "pr" | "ticket"; entityIdentifier: string; title: string }>;
  awaitingReview: Array<{ repo: string; number: number; title: string; waitHours: number }>;
  recentlyMerged: Array<{ repo: string; number: number; title: string; mergedAt: string }>;
  unlinkedPrs: Array<{ repo: string; number: number; title: string }>;
  unlinkedTickets: Array<{ identifier: string; title: string }>;
}

export interface TeamOverviewResponse {
  snapshot: TeamOverviewSnapshot | null;
  updatedAtMs: number | null;
  refreshError: string | null;
  stale: boolean;
}
```

Add API methods:

```ts
  getTeamOverview: () => fetchJSON<TeamOverviewResponse>("/api/team/overview"),
  refreshTeamOverview: () =>
    postJSON<{ ok: boolean; snapshot?: TeamOverviewSnapshot; error?: string | null }>(
      "/api/team/overview/refresh",
      {},
    ),
```

Ensure `serializeConfigForClient` on the server includes `team` (Task 1) so the web gate works.

- [ ] **Step 2: Query keys**

In `web/src/lib/query-keys.ts`:

```ts
  team: {
    root: ["team"] as const,
    overview: ["team", "overview"] as const,
  },
```

- [ ] **Step 3: SSE**

In `web/src/store/poll-status-slice.ts`:

```ts
    es.addEventListener("team-overview", () => {
      void getQueryClient().invalidateQueries({ queryKey: qk.team.root });
    });
```

- [ ] **Step 4: Settings UI**

Mirror the coherence section: toggles for `team.enabled` and numeric `team.pollIntervalMinutes`, wired through existing settings save plumbing.

- [ ] **Step 5: Build web**

Run: `yarn workspace code-triage-web build`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/lib/query-keys.ts web/src/store/poll-status-slice.ts web/src/components/settings-view.tsx web/src/store/settings-form.ts web/src/store/ui-slice.ts web/src/store/types.ts
git commit -m "feat(web): team overview client + settings + SSE"
```

---

### Task 8: Manual refresh cooldown helper + Vitest jsdom project

**Files:**
- Create: `web/src/lib/team-manual-refresh-cooldown.ts`
- Create: `web/src/lib/team-manual-refresh-cooldown.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Cooldown helper**

Create `web/src/lib/team-manual-refresh-cooldown.ts`:

```ts
export const TEAM_MANUAL_REFRESH_COOLDOWN_MS = 30_000;

export function teamManualRefreshAllowed(lastTriggerMs: number | null, nowMs: number): boolean {
  if (lastTriggerMs == null) return true;
  return nowMs - lastTriggerMs >= TEAM_MANUAL_REFRESH_COOLDOWN_MS;
}
```

- [ ] **Step 2: Tests**

Create `web/src/lib/team-manual-refresh-cooldown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { teamManualRefreshAllowed, TEAM_MANUAL_REFRESH_COOLDOWN_MS } from "./team-manual-refresh-cooldown.js";

describe("teamManualRefreshAllowed", () => {
  it("allows first trigger", () => {
    expect(teamManualRefreshAllowed(null, 1_000)).toBe(true);
  });

  it("blocks within cooldown window", () => {
    const t0 = 1_000_000;
    expect(teamManualRefreshAllowed(t0, t0 + TEAM_MANUAL_REFRESH_COOLDOWN_MS - 1)).toBe(false);
  });

  it("allows after cooldown window", () => {
    const t0 = 1_000_000;
    expect(teamManualRefreshAllowed(t0, t0 + TEAM_MANUAL_REFRESH_COOLDOWN_MS)).toBe(true);
  });
});
```

- [ ] **Step 3: Vitest projects**

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          include: ["web/src/**/*.test.ts"],
        },
      },
    ],
  },
});
```

- [ ] **Step 4: Run tests**

Run: `yarn test`

Expected: PASS (install `jsdom` if Vitest prompts; add `jsdom` to root `devDependencies` if needed)

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts web/src/lib/team-manual-refresh-cooldown.ts web/src/lib/team-manual-refresh-cooldown.test.ts package.json yarn.lock
git commit -m "test(web): team manual refresh cooldown helper"
```

---

### Task 9: Attention layout + team panel + query sync

**Files:**
- Create: `web/src/components/attention-page-layout.tsx`
- Create: `web/src/components/team-snapshot-panel.tsx`
- Modify: `web/src/routes/attention.tsx`
- Modify: `web/src/components/server-query-sync.tsx`

- [ ] **Step 1: `TeamSnapshotPanel`**

Implement sections (`Stuck`, `Awaiting review`, `Recently merged`, `Unlinked work`) with `Link` to `/team`.

Refresh button:

```ts
import { teamManualRefreshAllowed, TEAM_MANUAL_REFRESH_COOLDOWN_MS } from "../lib/team-manual-refresh-cooldown";
```

Use component state `lastManualRefreshMs` and disable button when `!teamManualRefreshAllowed(lastManualRefreshMs, Date.now())`.

On click:

```ts
await api.refreshTeamOverview();
void qc.invalidateQueries({ queryKey: qk.team.overview });
setLastManualRefreshMs(Date.now());
```

- [ ] **Step 2: `AttentionPageLayout`**

- `md+`: `grid grid-cols-[minmax(0,1fr)_320px]` or `flex` with `min-w-0`
- `<AttentionFeed />` left; `<TeamSnapshotPanel />` right when `config.team.enabled`
- `< md`: feed first; team in collapsible (`details/summary` or Radix Collapsible if already in repo)

- [ ] **Step 3: Wire route**

`web/src/routes/attention.tsx` returns `<AttentionPageLayout />`.

- [ ] **Step 4: Query sync**

In `useServerQuerySync`, add:

```ts
  const teamEnabled = useAppStore((s) => s.config?.team?.enabled === true);
  const teamOverviewQuery = useQuery({
    queryKey: qk.team.overview,
    queryFn: () => api.getTeamOverview(),
    staleTime: 60_000,
    enabled: appGate === "ready" && teamEnabled,
  });
```

Mirror into Zustand only if you already mirror other queries; otherwise consume `useQuery` directly in `TeamSnapshotPanel` to stay simpler.

- [ ] **Step 5: Build**

Run: `yarn build:all`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/attention-page-layout.tsx web/src/components/team-snapshot-panel.tsx web/src/routes/attention.tsx web/src/components/server-query-sync.tsx
git commit -m "feat(web): attention dual-column team snapshot"
```

---

## Spec coverage checklist

| Spec section | Tasks |
|--------------|-------|
| Two-column desktop + mobile collapsible | Task 9 |
| `GET /api/team/overview` | Tasks 2, 4, 5 |
| Gating on `team.enabled` | Tasks 1, 5, 7, 9 |
| Independent error handling | Tasks 5, 9 |
| Interval + manual refresh + 30s cooldown | Tasks 6, 8, 9 |
| Linear batching / no list N+1 | Task 3 |
| GitHub batching reuse | Task 5 implementation details (use `github-batching.ts`) |
| SSE | Tasks 6, 7 |

## Plan self-review notes

- **Task 3 constructor change** must pass the raw API key into `LinearProvider` — update `src/tickets/index.ts` instantiation accordingly.
- **Task 4 test** may need to align with your actual `db/client` exports; follow existing `attention.test.ts` / DB test patterns if this snippet differs.
- **Task 5 aggregation** is intentionally the largest coding chunk; keep `rebuildTeamOverviewSnapshot` pure where possible for unit tests.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-15-attention-dual-column-team-snapshot.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
