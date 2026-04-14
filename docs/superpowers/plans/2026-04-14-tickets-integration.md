# Tickets Integration (Linear) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-agnostic tickets tab to Code Triage with an icon rail navigation, Linear as the first provider, and bidirectional PR ↔ ticket linking.

**Architecture:** Backend uses a `TicketProvider` interface with a `LinearProvider` implementation using `@linear/sdk`. Frontend adds a Zustand `ticketsSlice`, an `IconRail` component for top-level navigation, and ticket sidebar + detail views. Linking logic runs in-memory after each poll cycle, matching ticket identifiers found in PR branches/titles/bodies against fetched tickets.

**Tech Stack:** TypeScript, `@linear/sdk`, Zustand, React 19, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-04-14-tickets-integration-design.md`

---

### Task 1: Add `@linear/sdk` dependency and config fields

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts:8-49` (Config interface)
- Modify: `src/config.test.ts`

- [ ] **Step 1: Install `@linear/sdk`**

```bash
yarn add @linear/sdk
```

- [ ] **Step 2: Add config fields to `Config` interface**

In `src/config.ts`, add these fields to the `Config` interface after `fixConversationMaxTurns`:

```typescript
  /** Personal Linear API key for ticket integration. */
  linearApiKey?: string;
  /** Limit ticket queries to these Linear team keys (e.g. ["ENG", "PROD"]). If omitted, all teams. */
  linearTeamKeys?: string[];
  /** Active ticket provider. Defaults to "linear" when linearApiKey is present. */
  ticketProvider?: "linear";
```

No changes to `DEFAULTS` — all three fields are optional and undefined by default.

- [ ] **Step 3: Write test for new config fields**

Add to `src/config.test.ts` inside the `"loadConfig"` describe block:

```typescript
  it("reads linear config fields", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ root: "/x", port: 3100, interval: 1, linearApiKey: "lin_api_test", linearTeamKeys: ["ENG"], ticketProvider: "linear" }),
    );
    const c = loadConfig();
    expect(c.linearApiKey).toBe("lin_api_test");
    expect(c.linearTeamKeys).toEqual(["ENG"]);
    expect(c.ticketProvider).toBe("linear");
  });

  it("returns undefined for linear fields when not set", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ root: "/x", port: 3100, interval: 1 }));
    const c = loadConfig();
    expect(c.linearApiKey).toBeUndefined();
    expect(c.linearTeamKeys).toBeUndefined();
    expect(c.ticketProvider).toBeUndefined();
  });
```

- [ ] **Step 4: Run tests**

```bash
yarn test src/config.test.ts
```

Expected: All tests pass including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock src/config.ts src/config.test.ts
git commit -m "feat: add @linear/sdk dependency and ticket config fields"
```

---

### Task 2: Add config serialization for frontend

**Files:**
- Modify: `src/api.ts` (the `serializeConfigForClient` function)
- Modify: `web/src/api.ts` (`AppConfigPayload` interface)
- Modify: `web/src/store/types.ts` (`SettingsFormState` interface)
- Modify: `web/src/store/settingsForm.ts` (`payloadToForm` function)

- [ ] **Step 1: Add `hasLinearApiKey` to `serializeConfigForClient`**

In `src/api.ts`, find the `serializeConfigForClient` function and add after the `fixConversationMaxTurns` line:

```typescript
    hasLinearApiKey: Boolean(c.linearApiKey?.length),
    linearTeamKeys: c.linearTeamKeys ?? [],
    ticketProvider: c.ticketProvider ?? (c.linearApiKey ? "linear" : undefined),
```

- [ ] **Step 2: Add fields to `AppConfigPayload`**

In `web/src/api.ts`, add to the `AppConfigPayload` interface after `fixConversationMaxTurns`:

```typescript
  /** True when a Linear API key is stored in config (value not exposed). */
  hasLinearApiKey: boolean;
  /** Team keys to filter Linear queries. */
  linearTeamKeys: string[];
  /** Active ticket provider, if configured. */
  ticketProvider?: "linear";
```

- [ ] **Step 3: Add settings form fields**

In `web/src/store/types.ts`, add to `SettingsFormState` after `fixConversationMaxTurns`:

```typescript
  linearApiKey: string;
  hasLinearApiKey: boolean;
  linearTeamKeys: string;
```

In `web/src/store/settingsForm.ts`, update `payloadToForm` to include:

```typescript
  linearApiKey: "",
  hasLinearApiKey: Boolean(c.hasLinearApiKey),
  linearTeamKeys: (c.linearTeamKeys ?? []).join(", "),
```

- [ ] **Step 4: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts web/src/api.ts web/src/store/types.ts web/src/store/settingsForm.ts
git commit -m "feat: serialize linear config fields for frontend"
```

---

### Task 3: Backend ticket provider abstraction and types

**Files:**
- Create: `src/tickets/types.ts`
- Create: `src/tickets/index.ts`

- [ ] **Step 1: Create ticket types**

Create `src/tickets/types.ts`:

```typescript
export interface TicketIssue {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; color: string; type: string };
  priority: number;
  assignee?: { name: string; avatarUrl?: string };
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  providerUrl: string;
}

export interface TicketComment {
  id: string;
  body: string;
  author: { name: string; avatarUrl?: string };
  createdAt: string;
}

export interface TicketIssueDetail extends TicketIssue {
  description?: string;
  comments: TicketComment[];
}

export interface TicketTeam {
  id: string;
  key: string;
  name: string;
}

export interface TicketUser {
  id: string;
  name: string;
  email: string;
}

export interface TicketProvider {
  fetchMyIssues(): Promise<TicketIssue[]>;
  fetchIssuesByIdentifiers(identifiers: string[]): Promise<TicketIssue[]>;
  getIssueDetail(id: string): Promise<TicketIssueDetail>;
  getCurrentUser(): Promise<TicketUser>;
  getTeams(): Promise<TicketTeam[]>;
}
```

- [ ] **Step 2: Create provider resolver**

Create `src/tickets/index.ts`:

```typescript
import type { Config } from "../config.js";
import type { TicketProvider } from "./types.js";

let cachedProvider: TicketProvider | null = null;
let cachedKey: string | undefined;

export async function getTicketProvider(config: Config): Promise<TicketProvider | null> {
  const provider = config.ticketProvider ?? (config.linearApiKey ? "linear" : undefined);
  if (!provider || !config.linearApiKey) return null;

  // Return cached provider if API key hasn't changed
  if (cachedProvider && cachedKey === config.linearApiKey) return cachedProvider;

  // Lazy import to avoid loading @linear/sdk when not configured
  const { LinearProvider } = await import("./linear.js");
  cachedProvider = new LinearProvider(config.linearApiKey, config.linearTeamKeys);
  cachedKey = config.linearApiKey;
  return cachedProvider;
}

export function clearTicketProviderCache(): void {
  cachedProvider = null;
  cachedKey = undefined;
}

export type { TicketProvider, TicketIssue, TicketIssueDetail, TicketTeam, TicketUser, TicketComment } from "./types.js";
```

- [ ] **Step 3: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile. The `require("./linear.js")` will fail at runtime until Task 4 creates it, but TypeScript will compile.

- [ ] **Step 4: Commit**

```bash
git add src/tickets/types.ts src/tickets/index.ts
git commit -m "feat: add ticket provider abstraction and types"
```

---

### Task 4: Linear provider implementation

**Files:**
- Create: `src/tickets/linear.ts`
- Create: `src/tickets/linear.test.ts`

- [ ] **Step 1: Write tests for LinearProvider**

Create `src/tickets/linear.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @linear/sdk before importing
vi.mock("@linear/sdk", () => {
  const mockIssues = vi.fn();
  const mockIssue = vi.fn();
  const mockTeams = vi.fn();
  const mockViewer = vi.fn();
  return {
    LinearClient: vi.fn().mockImplementation(() => ({
      issues: mockIssues,
      issue: mockIssue,
      teams: mockTeams,
      viewer: mockViewer,
    })),
    __mockIssues: mockIssues,
    __mockIssue: mockIssue,
    __mockTeams: mockTeams,
    __mockViewer: mockViewer,
  };
});

import { LinearProvider } from "./linear.js";

const sdk = await import("@linear/sdk");
const mockIssues = (sdk as unknown as { __mockIssues: ReturnType<typeof vi.fn> }).__mockIssues;
const mockIssue = (sdk as unknown as { __mockIssue: ReturnType<typeof vi.fn> }).__mockIssue;
const mockTeams = (sdk as unknown as { __mockTeams: ReturnType<typeof vi.fn> }).__mockTeams;
const mockViewer = (sdk as unknown as { __mockViewer: ReturnType<typeof vi.fn> }).__mockViewer;

function makeIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Fix the bug",
    state: Promise.resolve({ name: "In Progress", color: "#f00", type: "started" }),
    priority: 2,
    assignee: Promise.resolve({ name: "Alice", avatarUrl: "https://example.com/a.png" }),
    labels: () => Promise.resolve({ nodes: [{ name: "bug", color: "#ff0000" }] }),
    updatedAt: new Date("2026-04-14T00:00:00Z"),
    url: "https://linear.app/team/issue/ENG-123",
    ...overrides,
  };
}

describe("LinearProvider", () => {
  let provider: LinearProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LinearProvider("lin_api_test");
  });

  describe("fetchMyIssues", () => {
    it("returns mapped issues assigned to viewer", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeIssueNode();
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchMyIssues();

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix the bug",
        priority: 2,
        providerUrl: "https://linear.app/team/issue/ENG-123",
      });
      expect(issues[0]!.state).toEqual({ name: "In Progress", color: "#f00", type: "started" });
      expect(issues[0]!.assignee).toEqual({ name: "Alice", avatarUrl: "https://example.com/a.png" });
      expect(issues[0]!.labels).toEqual([{ name: "bug", color: "#ff0000" }]);
    });
  });

  describe("fetchIssuesByIdentifiers", () => {
    it("returns issues matching identifiers", async () => {
      const node = makeIssueNode({ identifier: "ENG-123" });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchIssuesByIdentifiers(["ENG-123", "ENG-999"]);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.identifier).toBe("ENG-123");
    });

    it("returns empty array for empty input", async () => {
      const issues = await provider.fetchIssuesByIdentifiers([]);
      expect(issues).toEqual([]);
      expect(mockIssues).not.toHaveBeenCalled();
    });
  });

  describe("getIssueDetail", () => {
    it("returns issue with description and comments", async () => {
      const issueData = {
        ...makeIssueNode(),
        description: "Detailed description here",
        comments: () =>
          Promise.resolve({
            nodes: [
              {
                id: "comment-1",
                body: "Looks good",
                user: Promise.resolve({ name: "Bob", avatarUrl: null }),
                createdAt: new Date("2026-04-14T12:00:00Z"),
              },
            ],
          }),
      };
      mockIssue.mockResolvedValue(issueData);

      const detail = await provider.getIssueDetail("issue-1");

      expect(detail.description).toBe("Detailed description here");
      expect(detail.comments).toHaveLength(1);
      expect(detail.comments[0]).toMatchObject({
        id: "comment-1",
        body: "Looks good",
        author: { name: "Bob", avatarUrl: null },
      });
    });
  });

  describe("getTeams", () => {
    it("returns teams", async () => {
      mockTeams.mockResolvedValue({
        nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
      });

      const teams = await provider.getTeams();
      expect(teams).toEqual([{ id: "team-1", key: "ENG", name: "Engineering" }]);
    });
  });

  describe("getCurrentUser", () => {
    it("returns viewer info", async () => {
      mockViewer.mockResolvedValue({ id: "user-1", name: "Alice", email: "alice@example.com" });
      const user = await provider.getCurrentUser();
      expect(user).toEqual({ id: "user-1", name: "Alice", email: "alice@example.com" });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
yarn test src/tickets/linear.test.ts
```

Expected: FAIL — `./linear.js` module not found.

- [ ] **Step 3: Implement LinearProvider**

Create `src/tickets/linear.ts`:

```typescript
import { LinearClient } from "@linear/sdk";
import type { TicketProvider, TicketIssue, TicketIssueDetail, TicketTeam, TicketUser } from "./types.js";

export class LinearProvider implements TicketProvider {
  private client: LinearClient;
  private teamKeys?: string[];
  private viewerId: string | null = null;

  constructor(apiKey: string, teamKeys?: string[]) {
    this.client = new LinearClient({ apiKey });
    this.teamKeys = teamKeys;
  }

  async fetchMyIssues(): Promise<TicketIssue[]> {
    if (!this.viewerId) {
      const viewer = await this.client.viewer;
      this.viewerId = viewer.id;
    }

    const result = await this.client.issues({
      filter: {
        assignee: { id: { eq: this.viewerId } },
        state: { type: { nin: ["completed", "canceled"] } },
        ...(this.teamKeys?.length ? { team: { key: { in: this.teamKeys } } } : {}),
      },
      orderBy: "updatedAt" as never,
    });

    return Promise.all(result.nodes.map((n) => this.mapIssue(n)));
  }

  async fetchIssuesByIdentifiers(identifiers: string[]): Promise<TicketIssue[]> {
    if (identifiers.length === 0) return [];

    // Linear doesn't have a direct "by identifier" filter, so we use the number + team key
    // Parse identifiers like "ENG-123" into team key + number pairs
    const parsed = identifiers.map((id) => {
      const match = id.match(/^([A-Z]{2,10})-(\d+)$/);
      return match ? { teamKey: match[1]!, number: parseInt(match[2]!, 10) } : null;
    }).filter((p): p is { teamKey: string; number: number } => p !== null);

    if (parsed.length === 0) return [];

    // Group by team key for efficient querying
    const byTeam = new Map<string, number[]>();
    for (const { teamKey, number } of parsed) {
      const nums = byTeam.get(teamKey) ?? [];
      nums.push(number);
      byTeam.set(teamKey, nums);
    }

    const allIssues: TicketIssue[] = [];
    for (const [teamKey, numbers] of byTeam) {
      const result = await this.client.issues({
        filter: {
          team: { key: { eq: teamKey } },
          number: { in: numbers },
        },
      });
      const mapped = await Promise.all(result.nodes.map((n) => this.mapIssue(n)));
      allIssues.push(...mapped);
    }

    return allIssues;
  }

  async getIssueDetail(id: string): Promise<TicketIssueDetail> {
    const issue = await this.client.issue(id);
    const base = await this.mapIssue(issue);
    const commentsResult = await issue.comments();
    const comments = await Promise.all(
      commentsResult.nodes.map(async (c) => {
        const user = await c.user;
        return {
          id: c.id,
          body: c.body,
          author: { name: user?.name ?? "Unknown", avatarUrl: user?.avatarUrl ?? undefined },
          createdAt: c.createdAt.toISOString(),
        };
      }),
    );

    return {
      ...base,
      description: issue.description ?? undefined,
      comments,
    };
  }

  async getCurrentUser(): Promise<TicketUser> {
    const viewer = await this.client.viewer;
    this.viewerId = viewer.id;
    return { id: viewer.id, name: viewer.name, email: viewer.email ?? "" };
  }

  async getTeams(): Promise<TicketTeam[]> {
    const result = await this.client.teams();
    return result.nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
  }

  private async mapIssue(node: {
    id: string;
    identifier: string;
    title: string;
    state: Promise<{ name: string; color: string; type: string }> | { name: string; color: string; type: string };
    priority: number;
    assignee: Promise<{ name: string; avatarUrl?: string | null } | null | undefined> | { name: string; avatarUrl?: string | null } | null | undefined;
    labels: () => Promise<{ nodes: Array<{ name: string; color: string }> }>;
    updatedAt: Date;
    url: string;
  }): Promise<TicketIssue> {
    const [state, assignee, labelsResult] = await Promise.all([
      Promise.resolve(node.state),
      Promise.resolve(node.assignee),
      node.labels(),
    ]);

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      state: { name: state.name, color: state.color, type: state.type },
      priority: node.priority,
      assignee: assignee ? { name: assignee.name, avatarUrl: assignee.avatarUrl ?? undefined } : undefined,
      labels: labelsResult.nodes.map((l) => ({ name: l.name, color: l.color })),
      updatedAt: node.updatedAt.toISOString(),
      providerUrl: node.url,
    };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
yarn test src/tickets/linear.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 6: Commit**

```bash
git add src/tickets/linear.ts src/tickets/linear.test.ts
git commit -m "feat: implement LinearProvider for ticket integration"
```

---

### Task 5: Ticket ↔ PR linking logic

**Files:**
- Create: `src/tickets/linker.ts`
- Create: `src/tickets/linker.test.ts`

- [ ] **Step 1: Write tests for linker**

Create `src/tickets/linker.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractTicketIdentifiers, buildLinkMap, type LinkablePR } from "./linker.js";

describe("extractTicketIdentifiers", () => {
  it("extracts identifiers from branch name", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "lex/ENG-123-fix-bug", title: "Fix bug", body: "" };
    expect(extractTicketIdentifiers(pr)).toEqual(["ENG-123"]);
  });

  it("extracts from PR title when branch has no match", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "fix-bug", title: "Fixes ENG-456", body: "" };
    expect(extractTicketIdentifiers(pr)).toEqual(["ENG-456"]);
  });

  it("extracts from PR body as fallback", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "fix-bug", title: "Fix bug", body: "Resolves PROD-789" };
    expect(extractTicketIdentifiers(pr)).toEqual(["PROD-789"]);
  });

  it("returns first match only per source", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "ENG-1-and-ENG-2", title: "", body: "" };
    // Branch has multiple matches — we take the first
    expect(extractTicketIdentifiers(pr)).toEqual(["ENG-1"]);
  });

  it("returns empty array when no match", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "fix-bug", title: "Fix bug", body: "No ticket" };
    expect(extractTicketIdentifiers(pr)).toEqual([]);
  });

  it("handles identifiers with various team key lengths", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "FE-42-styles", title: "", body: "" };
    expect(extractTicketIdentifiers(pr)).toEqual(["FE-42"]);
  });
});

describe("buildLinkMap", () => {
  it("builds bidirectional maps", () => {
    const prs: LinkablePR[] = [
      { number: 10, repo: "org/repo", branch: "ENG-123-fix", title: "", body: "" },
      { number: 20, repo: "org/repo", branch: "ENG-123-more", title: "", body: "" },
      { number: 30, repo: "org/other", branch: "main", title: "Fixes PROD-5", body: "" },
    ];
    const validIdentifiers = new Set(["ENG-123", "PROD-5"]);

    const { ticketToPRs, prToTickets } = buildLinkMap(prs, validIdentifiers);

    expect(ticketToPRs.get("ENG-123")).toEqual([
      { number: 10, repo: "org/repo", title: "" },
      { number: 20, repo: "org/repo", title: "" },
    ]);
    expect(ticketToPRs.get("PROD-5")).toEqual([{ number: 30, repo: "org/other", title: "Fixes PROD-5" }]);
    expect(prToTickets.get("org/repo#10")).toEqual(["ENG-123"]);
    expect(prToTickets.get("org/other#30")).toEqual(["PROD-5"]);
  });

  it("discards identifiers not in valid set", () => {
    const prs: LinkablePR[] = [
      { number: 1, repo: "org/repo", branch: "ABC-999-fake", title: "", body: "" },
    ];
    const validIdentifiers = new Set(["ENG-123"]);

    const { ticketToPRs, prToTickets } = buildLinkMap(prs, validIdentifiers);

    expect(ticketToPRs.size).toBe(0);
    expect(prToTickets.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
yarn test src/tickets/linker.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement linker**

Create `src/tickets/linker.ts`:

```typescript
const IDENTIFIER_RE = /\b([A-Z]{2,10}-\d+)\b/;

export interface LinkablePR {
  number: number;
  repo: string;
  branch: string;
  title: string;
  body: string;
}

export interface LinkedPRRef {
  number: number;
  repo: string;
  title: string;
}

export interface LinkMap {
  ticketToPRs: Map<string, LinkedPRRef[]>;
  prToTickets: Map<string, string[]>;
}

/**
 * Extract ticket identifiers from a PR. Checks branch name first, then title, then body.
 * Returns the first match from each source (deduped).
 */
export function extractTicketIdentifiers(pr: LinkablePR): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const text of [pr.branch, pr.title, pr.body]) {
    const match = text.match(IDENTIFIER_RE);
    if (match && !seen.has(match[1]!)) {
      seen.add(match[1]!);
      result.push(match[1]!);
    }
  }

  return result;
}

/**
 * Build bidirectional link maps between tickets and PRs.
 * Only includes identifiers present in `validIdentifiers` (actual tickets from the provider).
 */
export function buildLinkMap(prs: LinkablePR[], validIdentifiers: Set<string>): LinkMap {
  const ticketToPRs = new Map<string, LinkedPRRef[]>();
  const prToTickets = new Map<string, string[]>();

  for (const pr of prs) {
    const identifiers = extractTicketIdentifiers(pr).filter((id) => validIdentifiers.has(id));
    if (identifiers.length === 0) continue;

    const prKey = `${pr.repo}#${pr.number}`;
    prToTickets.set(prKey, identifiers);

    for (const id of identifiers) {
      const refs = ticketToPRs.get(id) ?? [];
      refs.push({ number: pr.number, repo: pr.repo, title: pr.title });
      ticketToPRs.set(id, refs);
    }
  }

  return { ticketToPRs, prToTickets };
}
```

- [ ] **Step 4: Run tests**

```bash
yarn test src/tickets/linker.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tickets/linker.ts src/tickets/linker.test.ts
git commit -m "feat: add ticket ↔ PR linking logic"
```

---

### Task 6: Backend API routes for tickets

**Files:**
- Modify: `src/api.ts` (add routes inside `registerRoutes`)
- Modify: `src/server.ts` (add ticket state and SSE event)

- [ ] **Step 1: Add in-memory ticket state to server.ts**

In `src/server.ts`, after the fix job status declarations, add:

```typescript
import type { TicketIssue, TicketIssueDetail } from "./tickets/types.js";
import type { LinkMap } from "./tickets/linker.js";

interface TicketState {
  myIssues: TicketIssue[];
  repoLinkedIssues: TicketIssue[];
  linkMap: LinkMap;
}

const ticketState: TicketState = {
  myIssues: [],
  repoLinkedIssues: [],
  linkMap: { ticketToPRs: new Map(), prToTickets: new Map() },
};

export function updateTicketState(state: Partial<TicketState>): void {
  Object.assign(ticketState, state);
  sseBroadcast("ticket-status", { updated: true });
}

export function getTicketState(): TicketState {
  return ticketState;
}
```

- [ ] **Step 2: Add ticket API routes to api.ts**

In `src/api.ts`, inside `registerRoutes()`, add after all existing routes:

```typescript
  // ── Tickets ──

  addRoute("GET", "/api/tickets/me", async (_req, res) => {
    const config = loadConfig();
    const { getTicketProvider } = await import("./tickets/index.js");
    const provider = await getTicketProvider(config);
    if (!provider) return json(res, { error: "No ticket provider configured" }, 400);
    try {
      const user = await provider.getCurrentUser();
      json(res, user);
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });

  addRoute("GET", "/api/tickets/mine", async (_req, res) => {
    const { myIssues } = getTicketState();
    json(res, myIssues);
  });

  addRoute("GET", "/api/tickets/repo-linked", async (_req, res) => {
    const { repoLinkedIssues, linkMap } = getTicketState();
    // Attach linked PRs to each issue
    const enriched = repoLinkedIssues.map((issue) => ({
      ...issue,
      linkedPRs: linkMap.ticketToPRs.get(issue.identifier) ?? [],
    }));
    json(res, enriched);
  });

  addRoute("GET", "/api/tickets/:id", async (_req, res, params) => {
    const config = loadConfig();
    const { getTicketProvider } = await import("./tickets/index.js");
    const provider = await getTicketProvider(config);
    if (!provider) return json(res, { error: "No ticket provider configured" }, 400);
    try {
      const detail = await provider.getIssueDetail(params.id);
      const { linkMap } = getTicketState();
      json(res, { ...detail, linkedPRs: linkMap.ticketToPRs.get(detail.identifier) ?? [] });
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });

  addRoute("GET", "/api/tickets/teams", async (_req, res) => {
    const config = loadConfig();
    const { getTicketProvider } = await import("./tickets/index.js");
    const provider = await getTicketProvider(config);
    if (!provider) return json(res, { error: "No ticket provider configured" }, 400);
    try {
      const teams = await provider.getTeams();
      json(res, teams);
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });

  addRoute("GET", "/api/tickets/link-map", async (_req, res) => {
    const { linkMap } = getTicketState();
    json(res, {
      ticketToPRs: Object.fromEntries(linkMap.ticketToPRs),
      prToTickets: Object.fromEntries(linkMap.prToTickets),
    });
  });
```

Note: You'll need to add `getTicketState` to the import from `"./server.js"` at the top of `api.ts`.

- [ ] **Step 3: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/api.ts src/server.ts
git commit -m "feat: add ticket API routes and server state"
```

---

### Task 7: Hook ticket polling into CLI poll cycle

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add ticket polling after GitHub poll completes**

In `src/cli.ts`, add the import near the top with other imports:

```typescript
import { getTicketProvider } from "./tickets/index.js";
import { extractTicketIdentifiers, buildLinkMap, type LinkablePR } from "./tickets/linker.js";
import { updateTicketState } from "./server.js";
```

Then in the `poll()` function, after the line `sseBroadcast("poll", { ok: true, at: Date.now() });` (around line 482), add:

```typescript
    // ── Ticket polling ──
    try {
      const provider = await getTicketProvider(config);
      if (provider) {
        const myIssues = await provider.fetchMyIssues();

        // Build linkable PRs from the current PR data
        const lists = await buildPullSidebarLists(repos);
        const linkablePRs: LinkablePR[] = [...lists.authored, ...lists.reviewRequested].map((p) => ({
          number: p.number,
          repo: p.repo as string,
          branch: p.branch as string,
          title: p.title as string,
          body: "", // Body not available in sidebar list; linking from branch/title is sufficient
        }));

        // Extract all candidate identifiers from PRs
        const allIdentifiers = new Set(linkablePRs.flatMap(extractTicketIdentifiers));

        // Fetch matching issues from provider (validates identifiers)
        const repoLinkedIssues = allIdentifiers.size > 0
          ? await provider.fetchIssuesByIdentifiers([...allIdentifiers])
          : [];

        // Build bidirectional link map
        const validIds = new Set([
          ...myIssues.map((i) => i.identifier),
          ...repoLinkedIssues.map((i) => i.identifier),
        ]);
        const linkMap = buildLinkMap(linkablePRs, validIds);

        updateTicketState({ myIssues, repoLinkedIssues, linkMap });
      }
    } catch (err) {
      console.error(`\n  Ticket poll error: ${(err as Error).message}`);
    }
```

- [ ] **Step 2: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: hook ticket polling into CLI poll cycle"
```

---

### Task 8: Frontend ticket types and API client

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add ticket types to frontend**

In `web/src/types.ts`, add at the end of the file:

```typescript
// ── Tickets ──

export interface TicketIssue {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; color: string; type: string };
  priority: number;
  assignee?: { name: string; avatarUrl?: string };
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  providerUrl: string;
}

export interface TicketComment {
  id: string;
  body: string;
  author: { name: string; avatarUrl?: string };
  createdAt: string;
}

export interface TicketIssueDetail extends TicketIssue {
  description?: string;
  comments: TicketComment[];
  linkedPRs: Array<{ number: number; repo: string; title: string }>;
}
```

- [ ] **Step 2: Add ticket API endpoints**

In `web/src/api.ts`, add the import for ticket types:

```typescript
import type { ..., TicketIssue, TicketIssueDetail } from "./types";
```

Then add to the `api` object:

```typescript
  // Tickets
  getTicketUser: () => fetchJSON<{ id: string; name: string; email: string }>("/api/tickets/me"),
  getMyTickets: () => fetchJSON<TicketIssue[]>("/api/tickets/mine"),
  getRepoLinkedTickets: () => fetchJSON<(TicketIssue & { linkedPRs: Array<{ number: number; repo: string; title: string }> })[]>("/api/tickets/repo-linked"),
  getTicketDetail: (id: string) => fetchJSON<TicketIssueDetail>(`/api/tickets/${encodeURIComponent(id)}`),
  getTicketTeams: () => fetchJSON<Array<{ id: string; key: string; name: string }>>("/api/tickets/teams"),
  getTicketLinkMap: () => fetchJSON<{ ticketToPRs: Record<string, Array<{ number: number; repo: string; title: string }>>; prToTickets: Record<string, string[]> }>("/api/tickets/link-map"),
```

- [ ] **Step 3: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat: add ticket types and API client to frontend"
```

---

### Task 9: Tickets Zustand slice

**Files:**
- Create: `web/src/store/ticketsSlice.ts`
- Modify: `web/src/store/types.ts`
- Modify: `web/src/store/index.ts`

- [ ] **Step 1: Add TicketsSlice interface**

In `web/src/store/types.ts`, add before the `// ── Combined Store ──` comment:

```typescript
// ── Tickets Slice ──

export interface TicketsSlice {
  activeMode: "code-review" | "tickets";
  myTickets: import("../types").TicketIssue[];
  repoLinkedTickets: (import("../types").TicketIssue & { linkedPRs: Array<{ number: number; repo: string; title: string }> })[];
  selectedTicket: string | null;
  ticketDetail: import("../types").TicketIssueDetail | null;
  ticketsLoading: boolean;
  ticketDetailLoading: boolean;
  ticketsError: string | null;
  prToTickets: Record<string, string[]>;

  setActiveMode: (mode: "code-review" | "tickets") => void;
  fetchTickets: () => Promise<void>;
  selectTicket: (id: string) => Promise<void>;
  clearTicket: () => void;
  navigateToLinkedPR: (number: number, repo: string) => void;
  navigateToLinkedTicket: (identifier: string) => void;
}
```

Update the `AppStore` type to include `TicketsSlice`:

```typescript
export type AppStore = AppSlice &
  PullsSlice &
  PrDetailSlice &
  PollStatusSlice &
  FixJobsSlice &
  NotificationsSlice &
  UiSlice &
  TicketsSlice;
```

- [ ] **Step 2: Create ticketsSlice.ts**

Create `web/src/store/ticketsSlice.ts`:

```typescript
import { api } from "../api";
import type { SliceCreator, TicketsSlice } from "./types";

export const createTicketsSlice: SliceCreator<TicketsSlice> = (set, get) => ({
  activeMode: "code-review",
  myTickets: [],
  repoLinkedTickets: [],
  selectedTicket: null,
  ticketDetail: null,
  ticketsLoading: false,
  ticketDetailLoading: false,
  ticketsError: null,
  prToTickets: {},

  setActiveMode: (mode) => set({ activeMode: mode }),

  fetchTickets: async () => {
    set({ ticketsLoading: true, ticketsError: null });
    try {
      const [mine, repoLinked, linkMap] = await Promise.all([
        api.getMyTickets(),
        api.getRepoLinkedTickets(),
        api.getTicketLinkMap(),
      ]);
      set({
        myTickets: mine,
        repoLinkedTickets: repoLinked,
        prToTickets: linkMap.prToTickets,
        ticketsLoading: false,
      });
    } catch (err) {
      set({ ticketsError: (err as Error).message, ticketsLoading: false });
    }
  },

  selectTicket: async (id) => {
    set({ selectedTicket: id, ticketDetail: null, ticketDetailLoading: true });
    try {
      const detail = await api.getTicketDetail(id);
      // Bail if user navigated away
      if (get().selectedTicket !== id) return;
      set({ ticketDetail: detail, ticketDetailLoading: false });
    } catch (err) {
      set({ ticketDetailLoading: false, ticketsError: (err as Error).message });
    }
  },

  clearTicket: () => set({ selectedTicket: null, ticketDetail: null }),

  navigateToLinkedPR: (number, repo) => {
    set({ activeMode: "code-review" });
    get().selectPR(number, repo);
  },

  navigateToLinkedTicket: (identifier) => {
    // Find the issue by identifier in either list
    const issue = get().myTickets.find((t) => t.identifier === identifier)
      ?? get().repoLinkedTickets.find((t) => t.identifier === identifier);
    if (issue) {
      set({ activeMode: "tickets" });
      get().selectTicket(issue.id);
    }
  },
});
```

- [ ] **Step 3: Wire slice into store**

In `web/src/store/index.ts`, add the import:

```typescript
import { createTicketsSlice } from "./ticketsSlice";
```

Add to the `create<AppStore>()` call:

```typescript
    ...createTicketsSlice(...a),
```

- [ ] **Step 4: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 5: Commit**

```bash
git add web/src/store/ticketsSlice.ts web/src/store/types.ts web/src/store/index.ts
git commit -m "feat: add tickets Zustand slice with cross-view navigation"
```

---

### Task 10: SSE listener for ticket updates

**Files:**
- Modify: `web/src/store/pollStatusSlice.ts`

- [ ] **Step 1: Add ticket-status SSE listener**

In `web/src/store/pollStatusSlice.ts`, inside the `connectSSE` function, after the `eval-complete` event listener, add:

```typescript
    es.addEventListener("ticket-status", () => {
      // Refresh ticket data when backend signals new data
      void get().fetchTickets();
    });
```

- [ ] **Step 2: Add ticket fetch to initialization**

In `web/src/store/appSlice.ts`, add a ticket fetch to the parallel init. After the existing `Promise.allSettled` block (the one that fetches user, repos, pulls, version), add:

```typescript
      // Fetch tickets if provider is configured
      if (r.config.hasLinearApiKey) {
        void get().fetchTickets();
      }
```

- [ ] **Step 3: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add web/src/store/pollStatusSlice.ts web/src/store/appSlice.ts
git commit -m "feat: add SSE listener and init fetch for tickets"
```

---

### Task 11: IconRail component

**Files:**
- Create: `web/src/components/IconRail.tsx`

- [ ] **Step 1: Create the IconRail component**

Create `web/src/components/IconRail.tsx`:

```tsx
import { useAppStore } from "../store";

function GitPullRequestIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function TicketIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3.5a1.5 1.5 0 1 0 0 3V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V9.5a1.5 1.5 0 0 0 0-3Zm11 1H4v1h8Zm-8 3h6v1H4Zm6 3H4v1h6Z" />
    </svg>
  );
}

export function IconRail() {
  const activeMode = useAppStore((s) => s.activeMode);
  const setActiveMode = useAppStore((s) => s.setActiveMode);
  const hasLinearApiKey = useAppStore((s) => s.config?.hasLinearApiKey ?? false);

  return (
    <div className="flex flex-col items-center w-12 shrink-0 bg-zinc-900 border-r border-zinc-800 py-3 gap-2">
      <button
        onClick={() => setActiveMode("code-review")}
        className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
          activeMode === "code-review"
            ? "bg-zinc-700 text-white"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
        }`}
        title="Code Review"
      >
        <GitPullRequestIcon />
      </button>
      {hasLinearApiKey && (
        <button
          onClick={() => setActiveMode("tickets")}
          className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
            activeMode === "tickets"
              ? "bg-zinc-700 text-white"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          }`}
          title="Tickets"
        >
          <TicketIcon />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/IconRail.tsx
git commit -m "feat: add IconRail component for top-level navigation"
```

---

### Task 12: TicketsSidebar component

**Files:**
- Create: `web/src/components/TicketsSidebar.tsx`

- [ ] **Step 1: Create the TicketsSidebar component**

Create `web/src/components/TicketsSidebar.tsx`:

```tsx
import { useState } from "react";
import { useAppStore } from "../store";
import type { TicketIssue } from "../types";

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "None", color: "text-zinc-500" },
  1: { label: "Urgent", color: "text-red-400" },
  2: { label: "High", color: "text-orange-400" },
  3: { label: "Medium", color: "text-yellow-400" },
  4: { label: "Low", color: "text-blue-400" },
};

function TicketCard({ issue, isSelected, onSelect }: { issue: TicketIssue; isSelected: boolean; onSelect: () => void }) {
  const priority = PRIORITY_LABELS[issue.priority] ?? PRIORITY_LABELS[0]!;
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
        isSelected
          ? "bg-zinc-800 border-zinc-600"
          : "bg-transparent border-transparent hover:bg-zinc-800/50"
      }`}
    >
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="font-mono">{issue.identifier}</span>
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: issue.state.color }}
          title={issue.state.name}
        />
        <span>{issue.state.name}</span>
        <span className={`ml-auto ${priority.color}`}>{priority.label}</span>
      </div>
      <div className="text-sm text-zinc-200 mt-0.5 truncate">{issue.title}</div>
      {issue.assignee && (
        <div className="text-xs text-zinc-500 mt-0.5">{issue.assignee.name}</div>
      )}
    </button>
  );
}

function CollapsibleSection({ title, count, children, defaultOpen = true }: { title: string; count: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center w-full px-3 py-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider hover:text-zinc-300"
      >
        <span className={`mr-1.5 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        {title}
        <span className="ml-auto text-zinc-500 normal-case font-normal">{count}</span>
      </button>
      {open && <div className="flex flex-col gap-0.5 px-1">{children}</div>}
    </div>
  );
}

export function TicketsSidebar() {
  const myTickets = useAppStore((s) => s.myTickets);
  const repoLinkedTickets = useAppStore((s) => s.repoLinkedTickets);
  const selectedTicket = useAppStore((s) => s.selectedTicket);
  const selectTicket = useAppStore((s) => s.selectTicket);
  const ticketsLoading = useAppStore((s) => s.ticketsLoading);
  const ticketsError = useAppStore((s) => s.ticketsError);
  const hasLinearApiKey = useAppStore((s) => s.config?.hasLinearApiKey ?? false);

  if (!hasLinearApiKey) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-center">
        <p className="text-zinc-400 text-sm">
          Add your Linear API key in{" "}
          <button
            onClick={() => useAppStore.getState().openSettings()}
            className="text-blue-400 hover:underline"
          >
            Settings
          </button>
          {" "}to connect your tickets.
        </p>
      </div>
    );
  }

  if (ticketsError) {
    return (
      <div className="px-3 py-2 mx-2 mt-2 rounded bg-red-900/30 border border-red-800 text-red-300 text-xs">
        {ticketsError}
        <button
          onClick={() => useAppStore.getState().openSettings()}
          className="ml-1 text-red-400 hover:underline"
        >
          Check settings
        </button>
      </div>
    );
  }

  if (ticketsLoading && myTickets.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
        Loading tickets…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 overflow-y-auto">
      <CollapsibleSection title="My Issues" count={myTickets.length}>
        {myTickets.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500">No active issues assigned to you.</p>
        ) : (
          myTickets.map((issue) => (
            <TicketCard
              key={issue.id}
              issue={issue}
              isSelected={selectedTicket === issue.id}
              onSelect={() => selectTicket(issue.id)}
            />
          ))
        )}
      </CollapsibleSection>
      <CollapsibleSection title="Repo-Linked Issues" count={repoLinkedTickets.length}>
        {repoLinkedTickets.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500">No tickets matched to your monitored repos.</p>
        ) : (
          repoLinkedTickets.map((issue) => (
            <TicketCard
              key={issue.id}
              issue={issue}
              isSelected={selectedTicket === issue.id}
              onSelect={() => selectTicket(issue.id)}
            />
          ))
        )}
      </CollapsibleSection>
    </div>
  );
}
```

- [ ] **Step 2: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TicketsSidebar.tsx
git commit -m "feat: add TicketsSidebar component with collapsible sections"
```

---

### Task 13: TicketIssueDetail component

**Files:**
- Create: `web/src/components/TicketIssueDetail.tsx`

- [ ] **Step 1: Create the TicketIssueDetail component**

Create `web/src/components/TicketIssueDetail.tsx`:

```tsx
import { useAppStore } from "../store";

const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export function TicketIssueDetail() {
  const ticketDetail = useAppStore((s) => s.ticketDetail);
  const ticketDetailLoading = useAppStore((s) => s.ticketDetailLoading);
  const selectedTicket = useAppStore((s) => s.selectedTicket);
  const navigateToLinkedPR = useAppStore((s) => s.navigateToLinkedPR);

  if (!selectedTicket) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Select a ticket to view details
      </div>
    );
  }

  if (ticketDetailLoading || !ticketDetail) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Loading ticket…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <span className="font-mono">{ticketDetail.identifier}</span>
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: ticketDetail.state.color }}
          />
          <span>{ticketDetail.state.name}</span>
          <span className="mx-1">·</span>
          <span>{PRIORITY_LABELS[ticketDetail.priority] ?? "None"}</span>
          <a
            href={ticketDetail.providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-blue-400 hover:underline text-xs"
          >
            Open in Linear ↗
          </a>
        </div>
        <h1 className="text-lg font-semibold text-zinc-100 mt-1">{ticketDetail.title}</h1>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {ticketDetail.assignee && (
            <span className="text-xs text-zinc-400">
              {ticketDetail.assignee.name}
            </span>
          )}
          {ticketDetail.labels.map((label) => (
            <span
              key={label.name}
              className="px-1.5 py-0.5 text-xs rounded"
              style={{ backgroundColor: label.color + "20", color: label.color }}
            >
              {label.name}
            </span>
          ))}
        </div>
      </div>

      {/* Description */}
      {ticketDetail.description && (
        <div className="px-6 py-4 border-b border-zinc-800">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Description</h2>
          <div className="prose prose-invert prose-sm max-w-none text-zinc-300 whitespace-pre-wrap">
            {ticketDetail.description}
          </div>
        </div>
      )}

      {/* Linked PRs */}
      {ticketDetail.linkedPRs.length > 0 && (
        <div className="px-6 py-4 border-b border-zinc-800">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
            Linked Pull Requests ({ticketDetail.linkedPRs.length})
          </h2>
          <div className="flex flex-col gap-1">
            {ticketDetail.linkedPRs.map((pr) => (
              <button
                key={`${pr.repo}#${pr.number}`}
                onClick={() => navigateToLinkedPR(pr.number, pr.repo)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left hover:bg-zinc-800 transition-colors"
              >
                <span className="text-blue-400 font-mono text-xs">{pr.repo}#{pr.number}</span>
                <span className="text-zinc-300 truncate">{pr.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Comments */}
      {ticketDetail.comments.length > 0 && (
        <div className="px-6 py-4">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
            Comments ({ticketDetail.comments.length})
          </h2>
          <div className="flex flex-col gap-4">
            {ticketDetail.comments.map((comment) => (
              <div key={comment.id} className="border-l-2 border-zinc-700 pl-3">
                <div className="flex items-center gap-2 text-xs text-zinc-400 mb-1">
                  <span className="font-medium text-zinc-300">{comment.author.name}</span>
                  <span>{new Date(comment.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="text-sm text-zinc-300 whitespace-pre-wrap">{comment.body}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TicketIssueDetail.tsx
git commit -m "feat: add TicketIssueDetail component with linked PRs"
```

---

### Task 14: Wire everything into App.tsx

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Import new components**

Add imports at the top of `web/src/App.tsx`:

```typescript
import { IconRail } from "./components/IconRail";
import { TicketsSidebar } from "./components/TicketsSidebar";
import { TicketIssueDetail } from "./components/TicketIssueDetail";
```

- [ ] **Step 2: Add store selectors**

In the component body where store selectors are extracted, add:

```typescript
const activeMode = useAppStore((s) => s.activeMode);
const prToTickets = useAppStore((s) => s.prToTickets);
const navigateToLinkedTicket = useAppStore((s) => s.navigateToLinkedTicket);
```

- [ ] **Step 3: Wrap the layout with IconRail**

The existing layout is roughly:

```
<div className="flex h-screen ...">
  <aside className="sidebar ...">...</aside>
  <main className="detail ...">...</main>
</div>
```

Wrap it to add the icon rail:

```
<div className="flex h-screen ...">
  <IconRail />
  <aside className="sidebar ...">
    {activeMode === "code-review" ? (
      /* existing sidebar content */
    ) : (
      <TicketsSidebar />
    )}
  </aside>
  <main className="detail ...">
    {activeMode === "code-review" ? (
      /* existing PR detail content */
    ) : (
      <TicketIssueDetail />
    )}
  </main>
</div>
```

This requires carefully wrapping the existing sidebar JSX in a conditional. The existing sidebar content (logo, timer, repo filter, PR lists) goes inside the `activeMode === "code-review"` branch. The existing detail panel (tabs, overview, threads, files, checks) goes inside the same branch in `<main>`.

- [ ] **Step 4: Add linked ticket badge to PR Overview tab**

In the Overview tab content (inside the PR detail area), add a linked ticket indicator. Find where the PR overview renders and add:

```tsx
{/* After PR metadata / before review section */}
{(() => {
  const prKey = `${detail.repo}#${detail.number}`;
  const linkedTicketIds = prToTickets[prKey];
  if (!linkedTicketIds?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {linkedTicketIds.map((id) => (
        <button
          key={id}
          onClick={() => navigateToLinkedTicket(id)}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-zinc-800 text-blue-400 hover:bg-zinc-700 transition-colors"
        >
          🎫 {id}
        </button>
      ))}
    </div>
  );
})()}
```

- [ ] **Step 5: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 6: Visual smoke test**

```bash
yarn dev
```

Open the app in the browser. The icon rail should appear on the left. If no Linear API key is configured, clicking the ticket icon (if visible) should show the setup prompt. With a key configured, it should show the tickets sidebar and detail view.

- [ ] **Step 7: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat: integrate icon rail and tickets view into App layout"
```

---

### Task 15: Settings UI for Linear API key

**Files:**
- Modify: `web/src/components/SettingsView.tsx` (or equivalent settings component)

- [ ] **Step 1: Find the settings form component**

The settings form renders fields from `SettingsFormState`. Find where GitHub token field is rendered (search for `githubToken` or `hasGithubToken` in the settings component).

- [ ] **Step 2: Add Linear API key field**

After the GitHub token section, add a "Linear Integration" section:

```tsx
{/* Linear Integration */}
<div className="border-t border-zinc-800 pt-4 mt-4">
  <h3 className="text-sm font-semibold text-zinc-300 mb-3">Linear Integration</h3>
  <div className="space-y-3">
    <div>
      <label className="block text-xs text-zinc-400 mb-1">
        Linear API Key
        {form.hasLinearApiKey && !form.linearApiKey && (
          <span className="ml-1 text-green-500">✓ configured</span>
        )}
      </label>
      <input
        type="password"
        placeholder={form.hasLinearApiKey ? "(unchanged)" : "lin_api_..."}
        value={form.linearApiKey}
        onChange={(e) => updateField("linearApiKey", e.target.value)}
        className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 placeholder-zinc-500"
      />
      <p className="text-xs text-zinc-500 mt-1">
        Generate at{" "}
        <a href="https://linear.app/settings/api" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
          linear.app/settings/api
        </a>
      </p>
    </div>
    <div>
      <label className="block text-xs text-zinc-400 mb-1">Team Keys (optional)</label>
      <input
        type="text"
        placeholder="ENG, PROD (comma-separated, blank = all teams)"
        value={form.linearTeamKeys}
        onChange={(e) => updateField("linearTeamKeys", e.target.value)}
        className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-200 placeholder-zinc-500"
      />
    </div>
  </div>
</div>
```

- [ ] **Step 3: Ensure settings submission serializes the new fields**

Find where the settings form is submitted (the `submitSettings` action or the form's submit handler). Ensure `linearApiKey` and `linearTeamKeys` are included in the body sent to `POST /api/config`. The `linearApiKey` should only be sent if the user typed a new value (not the empty placeholder). The `linearTeamKeys` string should be split into an array:

```typescript
// In the submit logic:
...(form.linearApiKey ? { linearApiKey: form.linearApiKey } : {}),
linearTeamKeys: form.linearTeamKeys
  ? form.linearTeamKeys.split(",").map((s) => s.trim()).filter(Boolean)
  : [],
```

- [ ] **Step 4: Handle the new fields in backend `mergeConfigFromBody`**

In `src/api.ts`, find `mergeConfigFromBody` (or wherever POST /api/config processes the body) and add handling for the new fields:

```typescript
if (typeof body.linearApiKey === "string" && body.linearApiKey.length > 0) {
  next.linearApiKey = body.linearApiKey;
}
if (Array.isArray(body.linearTeamKeys)) {
  next.linearTeamKeys = body.linearTeamKeys.length > 0 ? body.linearTeamKeys : undefined;
}
```

- [ ] **Step 5: Clear ticket provider cache on config save**

In the config saved handler (in `cli.ts` or wherever `setConfigSavedHandler` callback is), add:

```typescript
import { clearTicketProviderCache } from "./tickets/index.js";
// ... inside the handler:
clearTicketProviderCache();
```

- [ ] **Step 6: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/SettingsView.tsx src/api.ts src/cli.ts
git commit -m "feat: add Linear API key settings UI and config handling"
```

---

### Task 16: Router extension for ticket URLs

**Files:**
- Modify: `web/src/router.ts`

- [ ] **Step 1: Extend RouteState**

In `web/src/router.ts`, update `RouteState`:

```typescript
export interface RouteState {
  repo: string | null;
  prNumber: number | null;
  file: string | null;
  ticketId: string | null;
}
```

- [ ] **Step 2: Update parseRoute**

Add ticket URL parsing. After the existing PR parsing logic:

```typescript
  let ticketId: string | null = null;

  // /tickets/:id
  if (segments.length >= 2 && segments[0] === "tickets") {
    ticketId = decodeURIComponent(segments[1]!);
  }

  return { repo, prNumber, file, ticketId };
```

- [ ] **Step 3: Update buildPath**

Add ticket path building:

```typescript
export function buildPath(state: RouteState): string {
  if (state.ticketId) {
    return `/tickets/${encodeURIComponent(state.ticketId)}`;
  }

  let path = "/";
  // ... existing PR path logic ...
```

- [ ] **Step 4: Update selectTicket to push route**

In `web/src/store/ticketsSlice.ts`, update `selectTicket` to push a route:

```typescript
import { pushRoute } from "../router";

// Inside selectTicket, after set({ selectedTicket: id, ... }):
pushRoute({ repo: null, prNumber: null, file: null, ticketId: id });
```

- [ ] **Step 5: Update handlePopState**

In `prDetailSlice.ts`, the existing `handlePopState` should also handle ticket routes. Find `handlePopState` and add:

```typescript
const route = parseRoute();
if (route.ticketId) {
  get().setActiveMode("tickets");
  get().selectTicket(route.ticketId);
  return;
}
```

- [ ] **Step 6: Fix any callers of pushRoute/buildPath**

Search for all callers of `pushRoute` and `buildPath` and update them to include `ticketId: null` in the `RouteState` object they pass.

- [ ] **Step 7: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 8: Commit**

```bash
git add web/src/router.ts web/src/store/ticketsSlice.ts web/src/store/prDetailSlice.ts
git commit -m "feat: extend router to support /tickets/:id URLs"
```

---

### Task 17: Mobile responsive icon rail

**Files:**
- Modify: `web/src/components/IconRail.tsx`
- Modify: `web/src/App.tsx` (if needed for mobile drawer)

- [ ] **Step 1: Add responsive behavior to IconRail**

The icon rail should collapse on mobile (< 768px). Update `IconRail.tsx` to accept a mobile mode prop:

```tsx
export function IconRail({ mobile }: { mobile?: boolean }) {
  // ... existing code ...

  if (mobile) {
    // Horizontal layout for mobile drawer header
    return (
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <button
          onClick={() => setActiveMode("code-review")}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            activeMode === "code-review"
              ? "bg-zinc-700 text-white"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <GitPullRequestIcon />
          Reviews
        </button>
        {hasLinearApiKey && (
          <button
            onClick={() => setActiveMode("tickets")}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              activeMode === "tickets"
                ? "bg-zinc-700 text-white"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <TicketIcon />
            Tickets
          </button>
        )}
      </div>
    );
  }

  // ... existing desktop vertical layout ...
}
```

- [ ] **Step 2: Hide desktop rail on mobile**

In `App.tsx`, the icon rail should be hidden on mobile. Add responsive classes:

```tsx
<div className="hidden md:flex">
  <IconRail />
</div>
```

And add the mobile version inside the mobile drawer:

```tsx
{/* Inside the mobile drawer, at the top */}
<IconRail mobile />
```

- [ ] **Step 3: Verify build compiles**

```bash
yarn build:all
```

Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/IconRail.tsx web/src/App.tsx
git commit -m "feat: add responsive mobile layout for icon rail"
```

---

### Task 18: End-to-end verification

**Files:** None new — verification only.

- [ ] **Step 1: Run all tests**

```bash
yarn test
```

Expected: All tests pass.

- [ ] **Step 2: Build everything**

```bash
yarn build:all
```

Expected: Clean compile, no errors or warnings.

- [ ] **Step 3: Visual smoke test**

```bash
yarn dev
```

Verify:
1. Icon rail appears on the left with Code Review icon active
2. Clicking Code Review icon shows existing PR sidebar
3. If Linear API key is configured: ticket icon appears, clicking it shows ticket sidebar
4. If no key: ticket icon appears, clicking shows setup prompt
5. Selecting a ticket loads the detail view
6. Linked PRs in ticket detail are clickable and switch to Code Review mode
7. PR overview tab shows linked ticket badges (if any)
8. Mobile layout shows horizontal mode switcher in drawer
9. URL changes when navigating between tickets and PRs
10. Browser back/forward works across views

- [ ] **Step 4: Commit any final fixes**

If any issues were found in smoke testing, fix and commit them.
