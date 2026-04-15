# Truth Layer: Real Status, Not Stated Status

## Summary

Add a unified "Attention" feed that cross-references GitHub PR state, Linear ticket state, and branch activity to surface what actually needs action. Includes a coherence engine that detects mismatches between systems, a work-in-progress lifecycle bar, and notification integration — all computed server-side on each poll cycle.

## Goals

1. **Single prioritized view** — one feed across PRs and tickets showing what needs attention, ranked by urgency.
2. **Status coherence** — detect contradictions between ticket state, PR state, and branch activity (e.g. ticket "Done" but PR unmerged).
3. **Lifecycle visibility** — compact progress bar showing where each piece of work is in its lifecycle, visible in list views.
4. **Actionable notifications** — new coherence alerts trigger desktop/browser notifications via the existing notification system.

## Non-Goals

- No AI/Claude involvement — all rules are deterministic.
- No modification of external state (no auto-resolving, no ticket transitions). That's Direction B.
- No team-wide data fetching. That's Direction C.
- No changes to existing review or ticket functionality. The attention feed aggregates signals that already exist in the reviews and tickets views — it does not replace them, just provides a unified entry point.

## Attention Feed

### Route and UI

New route: `/attention` — becomes the default landing page (replaces `/reviews` redirect from `/`).

New icon in the icon rail (top position, above Code Review): inbox/bell icon with badge count of non-dismissed, non-snoozed items.

The feed is a flat ranked list. Each item shows:
- Priority indicator (high/medium/low)
- Title (human-readable summary of what needs attention)
- Entity link (PR or ticket identifier, clickable)
- Lifecycle bar (compact dot progress, see below)
- Age ("first seen 2h ago")
- Action buttons: Jump, Snooze, Dismiss, Pin

### Event Types and Priority

| Signal | Source | Priority |
|--------|--------|----------|
| Review requested on your PR, no reviewer has started | GitHub PR | High |
| Review comment awaiting your reply (author) | GitHub + Claude eval | High |
| PR you need to review | GitHub | High |
| Ticket assigned to you with no branch/PR yet | Linear + GitHub | Medium |
| Your PR is approved but unmerged for >N hours | GitHub | Medium |
| Ticket status mismatch (coherence alert) | Linear + GitHub | Medium |
| Your PR's CI is failing | GitHub checks | Medium |
| Thread you snoozed has come due | Local state | Low |
| Ticket with no activity for >N days | Linear | Low |

### Prioritization

Within a priority tier, sort by age (oldest first — longest-waiting items bubble up). Pinned items always appear at the top regardless of priority.

### User Actions

- **Jump** — navigate to the relevant PR or ticket detail view
- **Snooze** — hide for N hours (1h, 4h, 1d, 3d)
- **Dismiss** — remove permanently (until condition resolves and then recurs)
- **Pin** — keep at top regardless of priority

## Status Coherence Engine

### Rules

| Rule | Condition | Alert |
|------|-----------|-------|
| Stale "In Progress" | Ticket is "In Progress" but linked branch has no commits in >N days | "ENG-42 says in progress but branch is idle" |
| Done but unmerged | Ticket moved to "Done"/"Closed" but linked PR is still open | "ENG-42 marked done but PR #18 isn't merged" |
| Approved but lingering | PR approved >N hours ago, no merge | "PR #18 approved 2 days ago — merge or update?" |
| Review bottleneck | PR has requested reviewers, none have commented in >N hours | "PR #18 waiting on review for 36 hours" |
| PR without ticket | PR opened on a tracked repo with no linked ticket | "PR #18 has no linked ticket" (informational) |
| Orphaned ticket | Ticket in active state but linked PR was closed without merge | "ENG-42 still open but PR #18 was abandoned" |

### Configurable Thresholds

All time-based thresholds stored in `config.json` under a `coherence` key, exposed in the settings page:

| Threshold | Default |
|-----------|---------|
| Branch staleness | 3 days |
| Approved-but-unmerged | 24 hours |
| Review wait | 24 hours |
| Ticket inactivity | 5 days |

### Alert Deduplication

Alerts are keyed by `rule + entity` (e.g. `stale-in-progress:ENG-42`). An alert fires once when first detected. If dismissed and the condition persists, it does not re-fire. If dismissed, the condition resolves, and then the condition recurs, it fires again.

## Work-in-Progress Lifecycle Bar

### Stages

```
Ticket Created → Branch Pushed → PR Opened → Review Requested → Approved → Merged → Ticket Closed
```

### Stage Detection

| Stage | Source |
|-------|--------|
| Ticket Created | Linear `createdAt` |
| Branch Pushed | GitHub — linked branch exists (from linker's branch name match) |
| PR Opened | GitHub — linked PR `createdAt` |
| Review Requested | GitHub — `requested_reviewers` populated |
| Approved | GitHub — PR review state is "approved" |
| Merged | GitHub — `merged_at` present |
| Ticket Closed | Linear — state category is "completed" or "canceled" |

### Visual Representation

Compact dot bar: filled dots for completed stages, half-filled for current, empty for remaining. Warning color on current dot if coherence threshold exceeded.

```
● ● ● ◐ ○ ○ ○
Created → Branch → PR → [Review] → ...
```

Hover shows stage name and timestamp. Stages can be skipped (not every ticket gets a PR).

### Placement

- **Attention feed** — each item shows its lifecycle bar
- **Tickets sidebar** — each ticket item shows the bar
- **PR list** — PRs with linked tickets show the bar
- **Ticket detail** — larger horizontal bar at the top with timestamps visible

## Notifications

When a new coherence alert fires for the first time:
- Desktop/browser notification with alert summary (via existing notification system)
- SSE event `attention` so the open dashboard updates immediately
- Attention feed badge count increments

## Persistence

New SQLite table `attention_items`:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Alert key (e.g. `stale-in-progress:ENG-42`) |
| `type` | TEXT | Coherence rule or event type |
| `entity_kind` | TEXT | `"pr"` or `"ticket"` |
| `entity_identifier` | TEXT | `"owner/repo#42"` or `"ENG-42"` |
| `priority` | TEXT | `"high"`, `"medium"`, `"low"` |
| `title` | TEXT | Human-readable summary |
| `stage` | TEXT | Current lifecycle stage (nullable) |
| `stuck_since` | TEXT | ISO8601 if stuck (nullable) |
| `first_seen_at` | TEXT | ISO8601 |
| `snoozed_until` | TEXT | ISO8601 (nullable) |
| `dismissed_at` | TEXT | ISO8601 (nullable) |
| `pinned` | INTEGER | 0 or 1 |

Items are recomputed each poll cycle. The table tracks user actions (snooze/dismiss/pin) that overlay the computed state.

## API Surface

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/attention` | Ranked attention items (excludes snoozed/dismissed unless `?all=true`) |
| `POST` | `/api/attention/:id/snooze` | Body: `{ until: "ISO8601" }` |
| `POST` | `/api/attention/:id/dismiss` | Dismiss an item |
| `POST` | `/api/attention/:id/pin` | Toggle pin |
| `GET` | `/api/coherence/config` | Current threshold settings |
| `POST` | `/api/coherence/config` | Update thresholds |

### SSE

New event type `attention` on existing `/api/events` stream, broadcast when the attention list changes after a poll cycle.

### Attention Item Shape

```typescript
interface AttentionItem {
  id: string;
  type: string;
  title: string;
  entity: {
    kind: "pr" | "ticket";
    identifier: string;
  };
  priority: "high" | "medium" | "low";
  stage?: string;
  stuckSince?: string;
  firstSeenAt: string;
  pinned: boolean;
  snoozedUntil?: string;
}
```

## New Modules

| File | Responsibility |
|------|---------------|
| `src/coherence.ts` | Rule engine — evaluates coherence rules against PR + ticket + link data |
| `src/attention.ts` | Attention feed — merges coherence alerts with other events, handles persistence |
| `src/db/attention-schema.ts` | Drizzle schema for `attention_items` table |
| `web/src/routes/attention.tsx` | Attention feed page |
| `web/src/components/attention-feed.tsx` | Feed list component with actions |
| `web/src/components/lifecycle-bar.tsx` | Compact progress bar (reused across views) |
| `web/src/store/attention-slice.ts` | Zustand slice for attention state |

## Integration Points

- **`src/cli.ts`** — After each poll cycle (GitHub + tickets), call `evaluateCoherence()` then `refreshAttentionFeed()`. Broadcast SSE `attention` event on changes.
- **`src/api.ts`** — Register attention and coherence config routes in `registerRoutes()`.
- **`src/db/schema.ts`** — Import and re-export the attention table.
- **`web/src/routes/__root.tsx`** — Default redirect changes from `/reviews` to `/attention`.
- **`web/src/components/icon-rail.tsx`** — New top icon for attention feed with badge count.
- **`web/src/components/tickets-sidebar.tsx`** — Add lifecycle bar to each ticket item.
- **`web/src/components/pr-list.tsx`** — Add lifecycle bar to PRs with linked tickets.
- **Settings page** — New "Coherence" section for threshold configuration.
