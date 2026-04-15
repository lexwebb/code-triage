# Team Radar: Visibility Beyond Yourself

## Summary

Extend Code Triage from a personal productivity tool to a team awareness dashboard. Adds a team view showing PRs and tickets across your team(s), review load distribution, sprint/cycle health, a team activity feed, and PR dependency awareness.

## Goals

1. **Team-wide visibility** — see what's happening across your team without checking Linear and GitHub separately.
2. **Bottleneck detection** — identify who's overloaded with reviews, what's been waiting too long, where work is stuck.
3. **Sprint health** — see cycle progress with real PR linkage, not just ticket board status.
4. **Dependency awareness** — know when your work is blocked by someone else's, or vice versa.

## Non-Goals

- No management/reporting features (velocity charts, burndown, performance metrics).
- No write actions on behalf of other team members.
- No notification of team events by default (opt-in only to avoid noise).
- No fetching data for users outside your Linear team(s).

## Prerequisites

- Truth Layer (Direction A) — coherence engine and lifecycle tracking provide per-item status that team views aggregate.
- Ticket integration (Linear) — team membership and ticket data come from Linear.

## Feature 1: Team Dashboard

### Route

`/team` — new top-level route with icon in the icon rail (users/people icon).

### Layout

Two-column view:
- **Left panel**: Team member list with summary stats (open PRs, pending reviews, stuck items)
- **Right panel**: Selected member's detail or aggregate team view

### Aggregate View (default)

| Section | Content |
|---------|---------|
| Stuck Items | Items across the team stuck at a lifecycle stage beyond threshold (from coherence engine) |
| Awaiting Review | PRs waiting longest for review, sorted by wait time |
| Recently Merged | Last N merges across the team (celebration / awareness) |
| Unlinked Work | PRs without tickets, tickets without PRs |

### Per-Member View

Click a team member to see their:
- Open PRs (authored) with lifecycle bars
- Pending reviews (assigned to them)
- Active tickets with lifecycle bars
- Coherence alerts on their items

### Data Source

- Team members from `GET /api/tickets/teams` (Linear teams) — already exists.
- New endpoint needed: `GET /api/team/overview` — fetches PRs and tickets for all team members.
- GitHub data: fetch open PRs where author is a team member, or reviewer is a team member.
- Linear data: fetch active tickets assigned to team members.

### API Considerations

- **Rate limiting**: Team data is heavier on API usage. Fetch on a slower cadence than personal data (e.g. every 5 minutes vs every 1 minute).
- **Caching**: Team data cached in SQLite, served from cache between refreshes.
- **Incremental**: Only fetch updated items (use `updated_at` filters where APIs support it).

## Feature 2: Review Load Balancing

### Behavior

Show review workload distribution across the team to identify bottlenecks and imbalances.

### Display

Bar chart or table in the team dashboard showing per team member:
- Pending review requests (assigned but not started)
- Reviews submitted this week
- Average review turnaround time (time from request to first comment)

### Insights

Surface specific callouts:
- "Alice has 8 pending reviews — consider reassigning"
- "Bob hasn't reviewed anything in 3 days"
- "Carol's average turnaround is 2 hours — team average is 18 hours"

### Implementation

- Computed from PR data already fetched for the team dashboard.
- Review events from GitHub PR timeline API (list of review submissions with timestamps).
- New module: `src/team/review-load.ts` — computes stats from PR review data.

## Feature 3: Sprint/Cycle Health

### Behavior

Pull Linear cycle data and show ticket progress with real PR linkage — not just what the ticket board says, but what's actually happening in code.

### Display

Sprint view in the team dashboard showing:

| Column | Content |
|--------|---------|
| Not Started | Tickets with no branch or PR |
| In Progress | Tickets with branch activity but no PR, or PR in draft |
| In Review | Tickets with open PR awaiting review |
| Approved | Tickets with approved PR, awaiting merge |
| Merged/Done | Tickets with merged PR or completed status |

Each ticket card shows the lifecycle bar from Direction A.

### Health Indicators

- "3 tickets in this cycle have no PR yet" (with days remaining in cycle)
- "2 tickets have stale PRs (no activity in 3+ days)"
- "Sprint is 80% through, 40% of tickets are still in progress"

### Data Source

- New `TicketProvider` method: `getCycles()` / `getCurrentCycle()` — returns cycle with ticket list.
- Linear SDK provides cycle data with issue references.
- Cross-reference with PR linkage from existing linker.

### Configuration

```json
{
  "team": {
    "enabled": false,
    "pollIntervalMinutes": 5,
    "showCycleHealth": true
  }
}
```

## Feature 4: Team Activity Feed

### Route

`/team/activity` — sub-route of the team dashboard, or a tab within it.

### Behavior

Real-time stream of team events, filterable by person, repo, or event type:

| Event | Content |
|-------|---------|
| PR opened | "{author} opened PR #{number}: {title}" |
| Review submitted | "{reviewer} reviewed {author}'s PR #{number}: {verdict}" |
| PR merged | "{author} merged PR #{number}" |
| Ticket moved | "{assignee}'s ticket {identifier} moved to {status}" |
| CI failure | "CI failing on {author}'s PR #{number}" |

### Implementation

- Events derived from polling diffs — compare current state to previous state each cycle.
- Stored in a new SQLite table `team_events` with timestamp, type, actor, entity.
- Capped at last 7 days of events, older entries pruned.
- API: `GET /api/team/activity?since=ISO8601&actor=username&type=pr-opened`

### Notifications (Opt-In)

Users can opt into notifications for specific team event types:
- "Notify me when someone merges to main"
- "Notify me when my PR gets reviewed"

These use the existing notification system.

## Feature 5: Dependency Awareness

### Behavior

Detect when PRs depend on each other and surface blocking relationships.

### Detection Methods

1. **Branch base**: PR targeting another PR's branch (stacked PRs)
2. **Explicit mentions**: PR description contains "depends on #N" or "blocked by #N"
3. **File overlap**: Two open PRs modifying the same files (potential conflict, not a hard dependency)

### Display

- In PR detail view: "Depends on" and "Blocks" sections showing linked PRs with their status
- In attention feed: "Your PR #42 is blocked — PR #38 needs review from Bob"
- In team dashboard: dependency chains highlighted when any link is stuck

### Implementation

- New module: `src/team/dependencies.ts`
- Regex scan of PR descriptions for dependency patterns
- GitHub API: check PR base branch references
- File overlap: compare changed files between open PRs (from existing PR file data)

## New Modules

| File | Responsibility |
|------|---------------|
| `src/team/overview.ts` | Fetch and cache team-wide PR + ticket data |
| `src/team/review-load.ts` | Review workload stats computation |
| `src/team/activity.ts` | Team event tracking and storage |
| `src/team/dependencies.ts` | PR dependency detection |
| `src/db/team-schema.ts` | SQLite tables for team cache and events |
| `web/src/routes/team.tsx` | Team dashboard page |
| `web/src/components/team-overview.tsx` | Aggregate team view |
| `web/src/components/team-member.tsx` | Per-member detail view |
| `web/src/components/review-load.tsx` | Review load chart/table |
| `web/src/components/cycle-health.tsx` | Sprint/cycle health view |
| `web/src/components/activity-feed.tsx` | Team activity stream |
| `web/src/components/dependency-graph.tsx` | PR dependency visualization |
| `web/src/store/team-slice.ts` | Zustand slice for team state |

## API Surface

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/team/overview` | Team-wide PRs, tickets, and stats |
| `GET` | `/api/team/activity` | Team event feed (filterable) |
| `GET` | `/api/team/review-load` | Review workload stats per member |
| `GET` | `/api/team/cycles` | Current and recent cycles with health data |
| `GET` | `/api/team/dependencies` | PR dependency graph |
| `GET` | `/api/team/config` | Team feature configuration |
| `POST` | `/api/team/config` | Update team configuration |

## Settings Integration

Team features gated behind `team.enabled` in config. Entire `/team` route and icon hidden when disabled. Poll interval, notification preferences, and cycle health toggle all configurable in settings under a "Team" section.
