# Cockpit Automations: Reduce Manual Overhead

## Summary

Build on the Truth Layer foundation to let Code Triage act on your behalf — auto-resolving stale threads, syncing ticket status on PR events, delivering context-rich smart notifications, generating morning briefings, and auto-triaging new tickets with Claude. Each automation is opt-in and configurable.

## Goals

1. **Reduce repetitive actions** — automate the things you'd do every time anyway (resolve threads Claude flagged, transition tickets on merge).
2. **Context-rich notifications** — notifications that tell you what happened, what Claude thinks, and what you can do about it, without opening the dashboard.
3. **Start-of-day orientation** — morning briefing summarizes overnight activity so you can prioritize immediately.
4. **AI-assisted triage for tickets** — Claude pre-categorizes new tickets so you know what you're looking at before you read them.

## Non-Goals

- No team-wide automations (that's Direction C).
- No automations that can't be undone or reverted.
- No bulk automated actions without explicit user opt-in per automation type.

## Prerequisites

- Truth Layer (Direction A) must be implemented first — coherence engine, attention feed, and lifecycle tracking are the foundation these automations act on.

## Feature 1: Auto-Resolve Stale Threads

### Behavior

When Claude evaluates a review comment as "resolve" and no new activity occurs on that thread for N hours, automatically resolve it on GitHub.

### Configuration

```json
{
  "automations": {
    "autoResolve": {
      "enabled": false,
      "delayHours": 12,
      "requireEvalConfidence": true
    }
  }
}
```

- `enabled` — opt-in, off by default
- `delayHours` — how long to wait after Claude's evaluation before auto-resolving (default: 12)
- `requireEvalConfidence` — only auto-resolve if Claude's evaluation was high-confidence (not ambiguous)

### Safety

- Only resolves threads where you are the PR author (you have the authority to resolve).
- If anyone comments on the thread after Claude's evaluation, the auto-resolve is cancelled.
- Auto-resolved threads are tagged in local state so they can be bulk-undone if needed.
- Notification sent when auto-resolve fires ("Auto-resolved 3 threads on PR #42").

### Implementation

- New function in `src/actioner.ts`: `processAutoResolves()` — called after each poll cycle.
- Checks eligible threads: eval is "resolve", age > delay, no new comments since eval.
- Calls existing `resolveThread()` for each.
- Records action in `attention_items` for audit trail.

## Feature 2: Ticket Status Sync

### Behavior

Automatically transition Linear tickets based on PR lifecycle events:

| PR Event | Ticket Transition |
|----------|-------------------|
| PR opened for linked ticket | Ticket → "In Review" (or equivalent status) |
| PR merged | Ticket → "Done" |
| PR closed without merge | No auto-transition (notify only — could be intentional) |

### Configuration

```json
{
  "automations": {
    "ticketSync": {
      "enabled": false,
      "onPROpen": "in-review",
      "onPRMerge": "done",
      "onPRClose": "notify-only"
    }
  }
}
```

- Each transition is independently configurable: auto-transition, notify-only, or disabled.
- Status names map to Linear workflow states — resolved at runtime by querying team workflow states.

### Safety

- Only transitions tickets assigned to you.
- Notification sent on each auto-transition ("Moved ENG-42 to Done after PR #18 merged").
- If the ticket is already in the target state or further along, no action taken.

### Implementation

- New function in `src/tickets/sync.ts`: `syncTicketStatuses()`.
- Runs after each poll cycle, compares current PR states to last-known states.
- Uses `TicketProvider` interface — needs a new method: `transitionIssue(id, statusId)`.
- Linear provider implements via `@linear/sdk` issue update.

## Feature 3: Smart Notifications

### Behavior

Replace generic "new comment on PR #42" notifications with context-rich messages:

**Before:** "New comment on PR #42"
**After:** "Alice requested changes on your auth PR — Claude thinks it's a fix, estimated ~30 min of work"

### Notification Content

| Event | Smart Message |
|-------|--------------|
| New review comment | "{author} commented on {PR title} — Claude says: {eval summary}" |
| PR approved | "{reviewer} approved {PR title} — ready to merge" |
| CI failure | "CI failing on {PR title}: {check name} — {failure summary}" |
| Coherence alert | "{alert title} — {suggested action}" |
| Auto-action completed | "Auto-resolved {N} threads on {PR title}" |

### Notification Actions

Desktop notifications support actions (where platform allows):
- **Snooze** — snooze the attention item for 4h
- **Jump** — open the dashboard to the relevant detail view

### Implementation

- Enhance existing `sendNotification()` in the notification system to accept structured content.
- Claude evaluation summaries already exist — pipe them into notification messages.
- Browser Notification API supports actions natively; node-notifier supports them on macOS.

## Feature 4: Morning Briefing

### Behavior

On first dashboard open of the day (or at a configured time), show a briefing modal summarizing:

1. **Overnight activity** — new comments, reviews submitted, PRs merged, tickets moved
2. **What needs attention** — top items from the attention feed, grouped by urgency
3. **Stuck items** — anything that's been stuck for >1 day

### Configuration

```json
{
  "automations": {
    "morningBriefing": {
      "enabled": true,
      "showOnFirstOpen": true,
      "scheduledTime": null
    }
  }
}
```

- `showOnFirstOpen` — show briefing modal when dashboard is first opened after 6+ hours of inactivity
- `scheduledTime` — optional, send a notification at this time even if dashboard isn't open (e.g. "09:00")

### Content Generation

- **No Claude involved** — the briefing is assembled from data already computed by the coherence engine and poll cycle.
- Counts of events since last briefing, grouped by type.
- Top 5 attention items by priority.
- Stuck items from lifecycle tracking.

### Implementation

- New API endpoint: `GET /api/briefing` — returns briefing data since a given timestamp.
- Frontend: modal component shown on app initialization if conditions met.
- Last briefing timestamp stored in `localStorage`.

## Feature 5: Auto-Triage New Tickets

### Behavior

When a new ticket is assigned to you, Claude reads the title and description and pre-categorizes it:

| Category | Meaning |
|----------|---------|
| Quick fix | Small, well-defined change — likely <1 hour |
| Needs design | Ambiguous requirements, needs clarification or spec |
| Blocked | References dependencies, other tickets, or external factors |
| Bug | Describes broken behavior with reproduction steps |
| Chore | Maintenance, dependency updates, config changes |

### Display

Category shown as a badge on the ticket in the sidebar and attention feed. Clicking the badge shows Claude's reasoning (1-2 sentences).

### Configuration

```json
{
  "automations": {
    "autoTriageTickets": {
      "enabled": false
    }
  }
}
```

### Implementation

- New function in `src/actioner.ts`: `triageNewTickets()`.
- Uses `claude -p` with a focused prompt: ticket title + description → category + reasoning.
- Result stored in `attention_items` metadata.
- Runs once per ticket (keyed by ticket identifier), not on every poll.

## New Modules

| File | Responsibility |
|------|---------------|
| `src/automations.ts` | Orchestrator — runs enabled automations after each poll cycle |
| `src/tickets/sync.ts` | Ticket status sync logic |
| `web/src/components/morning-briefing.tsx` | Briefing modal |
| `web/src/components/smart-notification.tsx` | Enhanced notification content |

## Settings Integration

All automations exposed in the settings page under a new "Automations" section. Each automation has an enable/disable toggle and its specific configuration fields.
