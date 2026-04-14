# Tickets Integration (Linear) — Design Spec

**Date:** 2026-04-14
**Status:** Draft

## Overview

Add a top-level "Tickets" view to Code Triage that surfaces Linear issues, links them bidirectionally to pull requests, and provides a full issue detail view — all behind a provider-agnostic abstraction so future ticketing tools (Jira, Shortcut, etc.) can be added without restructuring.

## Navigation: Icon Rail

A ~48px vertical icon rail on the far left of the app, always visible. Two icons:

- **Code Review** (git-pull-request icon) — the current sidebar + PR detail view
- **Tickets** (ticket/clipboard icon) — new sidebar + ticket detail view

Clicking an icon switches the sidebar content and detail panel. The active icon is visually highlighted. On mobile, the rail collapses into the existing hamburger/drawer pattern.

URL routing extends to: `/tickets/:identifier` alongside the existing `/:owner/:repo/pull/:number`.

## Config

Additions to `~/.code-triage/config.json`:

```jsonc
{
  // Existing fields...
  "linearApiKey": "lin_api_...",        // Personal API key, stored server-side
  "linearTeamKeys": ["ENG", "PROD"],    // Optional: limit to specific teams
  "ticketProvider": "linear"            // Active provider (default: "linear" if linearApiKey present)
}
```

Frontend receives `hasLinearApiKey: boolean` — the key value is never sent to the browser, matching the `githubToken` pattern.

## Backend Architecture

### Provider Abstraction

```
src/tickets/
  types.ts          — TicketProvider interface, generic ticket types
  linear.ts         — LinearProvider implements TicketProvider using @linear/sdk
  index.ts          — resolves active provider from config
  linker.ts         — PR ↔ ticket linking logic
```

**`TicketProvider` interface:**

- `fetchMyIssues(): Promise<TicketIssue[]>` — issues assigned to authenticated user, active states only
- `fetchRepoLinkedIssues(identifiers: string[]): Promise<TicketIssue[]>` — fetches issues by identifier (e.g., `["ENG-123", "PROD-45"]`); the linker extracts these from PR branches/titles/bodies and passes them in
- `getIssueDetail(id: string): Promise<TicketIssueDetail>` — full issue with description and comments
- `getCurrentUser(): Promise<{ id: string; name: string; email: string }>`
- `getTeams(): Promise<TicketTeam[]>` — for settings/filtering

**`LinearProvider`** implements this using `@linear/sdk` (`LinearClient`), initialized with the API key from config.

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/tickets/me` | Current ticket provider user info |
| `GET` | `/api/tickets/mine` | Issues assigned to authenticated user |
| `GET` | `/api/tickets/repo-linked` | Issues linked to monitored repos |
| `GET` | `/api/tickets/:id` | Full issue detail with comments and linked PRs |
| `GET` | `/api/tickets/teams` | Teams/projects for settings filtering |

All handlers are `async`, following the existing `api.ts` pattern. Linear errors (invalid key, rate limits) return structured error responses without affecting GitHub functionality.

SSE stream (`/api/events`) gets a new event type: `ticket-status`, broadcast after each ticket poll.

### Polling

Ticket data refreshes on the same interval as GitHub polling — one poll cycle fetches both. The flow:

1. GitHub poll runs (existing behavior)
2. Ticket poll runs (fetch my issues + all issues for linking)
3. Linker runs (match PRs ↔ tickets using in-memory data)
4. SSE broadcasts `ticket-status`

### Linking Logic

**Pattern matching** to connect Linear issues to PRs:

- Regex: `/\b([A-Z]{2,10}-\d+)\b/`
- Applied to PR branch name first, then PR title, then PR body (first match wins per PR)
- Candidate identifiers validated against fetched tickets — unmatched identifiers discarded

**Bidirectional map** (rebuilt each poll cycle, stored in memory):

- `ticketId → PR[]` — used in ticket detail to show linked PRs
- `PR key (owner/repo#number) → ticketId[]` — used in PR overview to show linked ticket badge

No extra API calls — matching is pure in-memory string comparison against already-fetched data.

## Frontend

### Types (`web/src/types.ts`)

```typescript
interface TicketIssue {
  id: string;
  identifier: string;       // e.g., "ENG-123"
  title: string;
  state: { name: string; color: string; type: string };
  priority: number;          // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  assignee?: { name: string; avatarUrl?: string };
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  providerUrl: string;       // link to open in Linear/Jira/etc.
}

interface TicketIssueDetail extends TicketIssue {
  description?: string;      // markdown
  comments: TicketComment[];
  linkedPRs: LinkedPR[];
}

interface TicketComment {
  id: string;
  body: string;              // markdown
  author: { name: string; avatarUrl?: string };
  createdAt: string;
}

interface LinkedPR {
  number: number;
  repo: string;              // "owner/repo"
  title: string;
  state: string;
}
```

### Zustand Slice: `ticketsSlice.ts`

New slice added to the store:

- `myIssues: TicketIssue[]`
- `repoLinkedIssues: TicketIssue[]`
- `selectedIssue: string | null`
- `issueDetail: TicketIssueDetail | null`
- `ticketsLoading: boolean`
- `fetchTickets()`, `selectIssue(id)`, `clearIssue()`

### Components

- **`IconRail.tsx`** — vertical icon rail, manages active mode (`"code-review" | "tickets"`)
- **`TicketsSidebar.tsx`** — two collapsible sections ("My Issues" / "Repo-Linked"), issue cards with identifier, title, status badge, priority indicator
- **`TicketIssueDetail.tsx`** — full issue view: title, status, priority, assignee, labels, markdown-rendered description, comments thread, "Linked PRs" section

### Cross-View Navigation

- **Ticket → PR:** Linked PRs in ticket detail are clickable cards. Clicking one switches the icon rail to Code Review mode and navigates to that PR. If the PR isn't in the current list (e.g., closed), it's fetched on demand.
- **PR → Ticket:** If a PR is linked to a ticket, a badge/link appears in the PR's Overview tab. Clicking it switches to Tickets mode and selects that issue.

## Error Handling

- **No API key:** Icon rail shows tickets icon, but clicking it shows a setup prompt linking to Settings. No API calls made.
- **Invalid/expired key:** Inline error banner in tickets sidebar with link to Settings. GitHub polling unaffected.
- **Rate limiting:** `@linear/sdk` handles Linear rate limits internally. Errors surface as a temporary banner in the tickets sidebar.
- **Empty states:** "No active issues assigned to you." / "No tickets matched to your monitored repos."

## Dependencies

- `@linear/sdk` — official Linear TypeScript SDK (new dependency)

## Out of Scope

- Team/project-wide issue views (future expansion)
- Creating or updating Linear issues from Code Triage
- Jira/Shortcut providers (architecture supports them, implementation deferred)
- Webhook-based real-time updates from Linear
