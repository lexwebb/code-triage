# Attention Dual-Column Snapshot Design

## Summary

Evolve the `attention` page into a two-column layout:

- Left: personal attention feed (existing behavior remains primary)
- Right: aggregate team snapshot (new, summary-oriented)

On narrow screens, preserve personal triage speed by collapsing the team snapshot behind an expandable section.

## Goals

1. Keep personal triage fast and uninterrupted.
2. Add team-level awareness in-context without replacing `/team`.
3. Reuse existing Direction A and Team Radar patterns to minimize new complexity.

## Non-Goals

- Do not turn `attention` into a full team dashboard.
- Do not mix personal and team items into a single unified queue in v1.
- Do not require team features to use the attention page.

## UX Design

## Desktop (`md+`)

- Two-column layout:
  - Left column: `Your attention`
  - Right column: `Team snapshot`
- Left column uses the current `AttentionFeed` semantics:
  - Priority order, pin/snooze/dismiss, lifecycle bars, PR/ticket jump
- Right column is aggregate summary blocks (not a per-item team inbox):
  - `Stuck items` (team-wide, threshold-based)
  - `Awaiting review` (longest waiting)
  - `Recently merged`
  - `Unlinked work` (PRs without tickets, tickets without PRs)
- Each block links to `/team` for deep drill-down.

## Narrow screens

- Personal feed renders first.
- Team snapshot appears as a collapsed section by default.
- Collapsed header includes lightweight counters when available (e.g. `3 stuck · 5 awaiting review`).
- User can expand to view the same aggregate sections.

This keeps the primary triage workflow visible while still exposing team signal.

## Data Model and Sources

## Personal column

- Continue using current attention data pipeline:
  - `GET /api/attention`
  - `web/src/store/attention-slice.ts`
  - `web/src/components/attention-feed.tsx`

## Team column

- Use Team Radar aggregate endpoint data from `GET /api/team/overview` in v1.
- Team panel data is independent from personal attention data:
  - Independent loading state
  - Independent error state
  - Personal feed must remain functional if team data fails

## Gating and Availability

- Team snapshot is shown only when `team.enabled` is true and team integrations are configured.
- If disabled/unavailable, attention page falls back to full-width personal feed.

## Integration with Existing Infrastructure

- Config pattern: follow existing `coherence` style in `src/config.ts`; read `team.enabled` and team poll settings.
- Settings pattern: use existing section/toggle style from `web/src/components/settings-view.tsx`.
- Route/UI pattern:
  - Keep `attention` as the primary route.
  - Team deep-link target remains `/team`.
- Store/query pattern:
  - Keep personal query path unchanged.
  - Add team snapshot query/slice aligned with current query invalidation and Zustand mirror patterns.
- Coherence/lifecycle reuse:
  - Reuse existing lifecycle derivation and visualization components for ticket/PR chips shown in team summary rows.
- SSE/polling:
  - Follow existing SSE invalidation style used for attention updates.
  - Team updates can run at a slower cadence than personal attention.

## API Budget and Batching Strategy

Minimizing GitHub and Linear requests is a first-class requirement for this work.

### Current request hotspots

- Linear issue mapping currently performs per-issue follow-up calls for labels/attachments in `src/tickets/linear.ts` (`mapIssue()` calls `labels()` and `attachments()`), which creates N+1 request patterns as issue counts grow.
- Ticket poll loop in `src/cli.ts` may call `fetchMyIssues()` up to 3 times in a cycle when transient empty responses occur (retry behavior is intentional but increases request pressure during instability).
- Team APIs (from Team Radar) will significantly increase payload breadth if fetched on the same cadence as personal data.

### Linear strategy

- Use GraphQL shape consolidation: fetch issue core fields + labels + attachments/synced metadata in the same `issues(...)` query for list/snapshot scenarios.
- Keep detail-expensive data (`comments`, large descriptions) on-demand only in detail endpoints (`/api/tickets/:id` style), never in aggregate snapshot fetches.
- Add incremental fetch windows (`updatedAt` watermark) for team snapshot refreshes and merge into SQLite cache.
- Keep and extend identifier cache/negative cache behavior already present in `LinearProvider`.

### GitHub strategy

- Reuse existing GraphQL batching patterns already in repo (`src/github-batching.ts`) for team snapshot derivations rather than per-repo/per-PR REST fan-out.
- Keep single-page REST where full pagination is unnecessary (`ghAsyncSinglePage` pattern).
- Partition by token using existing helpers (`partitionRepoPathsByToken` / `partitionEntriesByToken`) so batching remains account-safe.

### Polling and serving model

- Personal attention remains near-real-time (existing cadence).
- Team snapshot refreshes on a slower interval (default 5 minutes) and serves from SQLite cache between refreshes.
- **Manual refresh:** the team snapshot panel exposes a refresh action that triggers an upstream refresh (same code path as interval refresh). Apply a **30 second** client-side cooldown after manual refresh so repeated clicks cannot spam GitHub/Linear; honor server-side rate-limit backoff when present.
- UI should read cached team snapshot data and avoid forcing immediate upstream re-fetch on every page navigation.

### Acceptance criteria for request efficiency

- No per-issue network calls during aggregate list/snapshot construction.
- Team snapshot endpoint succeeds from cache when upstream providers are unavailable or rate-limited.
- Stats surfaces (existing request stats) should show reduced Linear operation counts for list fetches after batching refactor.

## Component Boundaries

- Keep current `AttentionFeed` responsible for personal list rendering and item actions.
- Add `TeamSnapshotPanel` for desktop summary.
- Add `TeamSnapshotCollapsible` (or shared responsive wrapper) for narrow screens.
- Add a parent layout container component for split/stack behavior and shared empty/error framing.

## Error Handling

- Personal fetch failure: show current personal error behavior.
- Team fetch failure: show non-blocking inline panel error with retry action; do not affect personal list actions.
- Partial data in team panel should render available sections and suppress unavailable ones.

## Testing Strategy

- Unit tests:
  - Responsive state logic (desktop split vs mobile collapsed)
  - Team panel visibility gating by `team.enabled`
  - Independent loading/error handling across personal/team queries
- Component tests:
  - Mobile collapsed header shows summary counts when present
  - Expand/collapse behavior
  - Desktop panel section rendering for all aggregate groups
  - Manual team snapshot refresh triggers refetch and respects the 30s cooldown between clicks
- Integration tests:
  - Personal actions (pin/snooze/dismiss/jump) still work unchanged with team panel enabled
  - Team panel failure does not degrade personal feed behavior

## Rollout Plan

1. Ship layout shell and gating with mocked team snapshot data.
2. Wire team snapshot to Team Radar API output.
3. Add mobile collapsed summary counts.
4. Polish copy and drill-down links to `/team`.

## Open Dependencies

- Team Radar backend endpoints and caching for aggregate team snapshot.
- Existing TicketProvider extensions already identified in Team Radar/Cockpit specs:
  - `getCycles()` / `getCurrentCycle()`
  - `transitionIssue()`

These are not required for initial layout work, but affect eventual completeness of team insights shown in the right column.
