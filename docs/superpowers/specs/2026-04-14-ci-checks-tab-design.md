# CI Checks Tab — Design Spec

## Overview

Add a "Checks" tab to the PR detail view that displays CI check run statuses grouped by check suite, with expandable annotations for failed runs. Data is lazy-loaded only when the tab is activated.

## Requirements

- Show all CI check runs for the PR's head commit, grouped by check suite (e.g. "GitHub Actions", "CircleCI")
- Within each suite, sort runs: failures first, then pending, then passing
- Only show the latest run of each check name (dedup by name, keep highest id)
- Each run displays: status icon, name, duration, link to GitHub
- Failed runs show expandable annotations (file, line, level, message)
- Tab label shows a lightweight summary (counts) without requiring the full checks fetch
- Full check details are only fetched when the user clicks the Checks tab

## Backend

### Lightweight summary on `GET /api/pulls/:number`

Extend the existing PR detail response with:

```ts
checksSummary: {
  total: number;
  success: number;
  failure: number;
  pending: number;
} | null;
```

Source: `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` with `per_page=100`, counting by conclusion. One additional API call per PR detail load.

### New endpoint: `GET /api/pulls/:number/checks`

Calls two GitHub APIs for the PR's head SHA:

1. `GET /repos/{owner}/{repo}/commits/{sha}/check-suites` — suite grouping
2. `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` — individual runs

For failed runs only, also fetches:

3. `GET /repos/{owner}/{repo}/check-runs/{id}/annotations` — error details

**Response shape:**

```ts
interface CheckSuite {
  id: number;
  name: string;                // e.g. "GitHub Actions"
  conclusion: string | null;
  runs: CheckRun[];
}

interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;   // "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required"
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  htmlUrl: string;
  annotations: CheckAnnotation[];
}

interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  message: string;
  title: string | null;
}
```

Deduplication: for each check name within a suite, keep only the run with the highest `id` (latest).

Sorting within each suite: failure → pending → success/neutral/skipped.

## Frontend

### ChecksPanel component (`web/src/components/ChecksPanel.tsx`)

- Fetches `api.getChecks(prNumber, repo)` on mount (lazy — only rendered when tab is active)
- Shows loading spinner while fetching
- Groups runs by check suite using `CollapsibleSection`
- Suite header: suite name + overall status icon
- Each run row: status icon (color-coded), name, duration (e.g. "2m 34s"), GitHub link icon
- Failed runs with annotations: expandable section showing file path, line, level badge, message
- Clicking annotation file path navigates to Files tab at that file (reuses `onSelectFile` pattern)
- Empty state: "No CI checks found for this commit"

### Status icons

| Conclusion      | Icon/Color          |
|-----------------|---------------------|
| success         | Green check          |
| failure         | Red circle-x         |
| in_progress     | Yellow dot (animated)|
| queued          | Yellow dot           |
| neutral         | Gray dash            |
| skipped         | Gray dash            |
| cancelled       | Gray circle          |
| timed_out       | Red clock            |
| action_required | Orange alert         |

### Tab integration in App.tsx

- Extend `activeTab` union: `"overview" | "threads" | "files" | "checks"`
- Tab label uses `checksSummary` from `prDetail` (already loaded):
  - Failures present: `Checks (2/5)` with red dot
  - All passing: `Checks (5)` with green dot
  - Some pending: `Checks (5)` with yellow dot
- Render `<ChecksPanel>` when `activeTab === "checks"`
- ChecksPanel manages its own data fetching; no state hoisted to App.tsx

### Web API client (`web/src/api.ts`)

Add: `getChecks(prNumber: number, repo: string): Promise<CheckSuite[]>`

### Types (`web/src/types.ts`)

Add `CheckSuite`, `CheckRun`, `CheckAnnotation` interfaces and extend `PullRequestDetail` with `checksSummary`.
