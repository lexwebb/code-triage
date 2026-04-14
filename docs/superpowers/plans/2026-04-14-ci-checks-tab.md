# CI Checks Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Checks" tab to the PR detail view showing CI check run statuses grouped by suite, with expandable annotations for failures.

**Architecture:** New backend endpoint `GET /api/pulls/:number/checks` returns check suites with runs and annotations. The existing `GET /api/pulls/:number` gets a lightweight `checksSummary` for the tab label. Frontend `ChecksPanel` component lazy-loads full data only when the tab is activated.

**Tech Stack:** TypeScript, React, Tailwind CSS, Lucide icons, existing `CollapsibleSection` component, GitHub REST API (check-suites, check-runs, annotations endpoints via `ghAsync`).

---

### Task 1: Add shared types for check data

**Files:**
- Modify: `web/src/types.ts`

- [ ] **Step 1: Add CheckAnnotation, CheckRun, CheckSuite interfaces and extend PullRequestDetail**

Add to the end of `web/src/types.ts` (before the closing of the file):

```ts
export interface CheckAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: "notice" | "warning" | "failure";
  message: string;
  title: string | null;
}

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  htmlUrl: string;
  annotations: CheckAnnotation[];
}

export interface CheckSuite {
  id: number;
  name: string;
  conclusion: string | null;
  runs: CheckRun[];
}
```

Add `checksSummary` to the `PullRequestDetail` interface:

```ts
export interface PullRequestDetail extends PullRequest {
  body: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewers: Reviewer[];
  checksSummary: {
    total: number;
    success: number;
    failure: number;
    pending: number;
  } | null;
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd web && npx tsc --noEmit`
Expected: Compilation errors in components that use `PullRequestDetail` because `checksSummary` is now required but backend doesn't send it yet. That's fine — we'll fix it in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add web/src/types.ts
git commit -m "feat(types): add CheckSuite, CheckRun, CheckAnnotation types and checksSummary to PullRequestDetail"
```

---

### Task 2: Backend — add `checksSummary` to PR detail endpoint

**Files:**
- Modify: `src/api.ts:422-487` (the `GET /api/pulls/:number` handler)

- [ ] **Step 1: Add a `getChecksSummary` helper in `src/api.ts`**

Add this above the `registerRoutes` function:

```ts
interface GhCheckRunsResponse {
  total_count: number;
  check_runs: Array<{
    id: number;
    status: string;
    conclusion: string | null;
  }>;
}

async function getChecksSummary(repoPath: string, sha: string): Promise<{
  total: number;
  success: number;
  failure: number;
  pending: number;
} | null> {
  try {
    const data = await ghAsync<GhCheckRunsResponse>(
      `/repos/${repoPath}/commits/${sha}/check-runs?per_page=100`,
    );
    const runs = data.check_runs;
    if (runs.length === 0) return null;

    let success = 0;
    let failure = 0;
    let pending = 0;
    for (const r of runs) {
      if (r.status !== "completed") {
        pending++;
      } else if (r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral") {
        success++;
      } else {
        failure++;
      }
    }
    return { total: runs.length, success, failure, pending };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Call `getChecksSummary` in the PR detail handler and include it in the response**

In the `GET /api/pulls/:number` handler, after fetching reviews and before calling `json(res, ...)`, add a parallel fetch for checksSummary. Change the response to include it:

```ts
const checksSummary = await getChecksSummary(repo, pr.head.sha);
```

Add to the `json(res, { ... })` object:

```ts
checksSummary,
```

- [ ] **Step 3: Verify the build compiles**

Run: `yarn build:all`
Expected: PASS — both backend and frontend compile.

- [ ] **Step 4: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): add checksSummary to GET /api/pulls/:number response"
```

---

### Task 3: Backend — new `GET /api/pulls/:number/checks` endpoint

**Files:**
- Modify: `src/api.ts` (inside `registerRoutes()`)

- [ ] **Step 1: Add GitHub response type interfaces above `registerRoutes`**

```ts
interface GhCheckSuite {
  id: number;
  app: { name: string; slug: string } | null;
  conclusion: string | null;
  status: string;
}

interface GhCheckSuitesResponse {
  total_count: number;
  check_suites: GhCheckSuite[];
}

interface GhCheckRunFull {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  check_suite: { id: number };
  output: { annotations_count: number };
}

interface GhCheckRunsFullResponse {
  total_count: number;
  check_runs: GhCheckRunFull[];
}

interface GhAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title: string | null;
}
```

- [ ] **Step 2: Add the route handler inside `registerRoutes()`**

Place this after the existing `GET /api/pulls/:number` route and before `GET /api/pulls/:number/files`:

```ts
// GET /api/pulls/:number/checks?repo=owner/repo
addRoute("GET", "/api/pulls/:number/checks", async (_req, res, params, query) => {
  const repo = requireRepo(query);
  const prNumber = parseInt(params.number, 10);

  // Get the PR head SHA
  const pr = await ghAsync<{ head: { sha: string } }>(`/repos/${repo}/pulls/${prNumber}`);
  const sha = pr.head.sha;

  // Fetch suites and runs in parallel
  const [suitesData, runsData] = await Promise.all([
    ghAsync<GhCheckSuitesResponse>(`/repos/${repo}/commits/${sha}/check-suites?per_page=100`),
    ghAsync<GhCheckRunsFullResponse>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
  ]);

  // Build suite name map
  const suiteNameMap = new Map<number, string>();
  for (const s of suitesData.check_suites) {
    suiteNameMap.set(s.id, s.app?.name ?? "Unknown");
  }

  // Deduplicate runs: keep only the latest (highest id) per name per suite
  const latestByKey = new Map<string, GhCheckRunFull>();
  for (const run of runsData.check_runs) {
    const key = `${run.check_suite.id}:${run.name}`;
    const existing = latestByKey.get(key);
    if (!existing || run.id > existing.id) {
      latestByKey.set(key, run);
    }
  }
  const dedupedRuns = Array.from(latestByKey.values());

  // Fetch annotations for failed runs (in parallel, capped)
  const failedRuns = dedupedRuns.filter(
    (r) => r.status === "completed" && (r.conclusion === "failure" || r.conclusion === "timed_out"),
  );
  const annotationsByRunId = new Map<number, GhAnnotation[]>();
  await Promise.all(
    failedRuns.map(async (run) => {
      if (run.output.annotations_count === 0) return;
      try {
        const annotations = await ghAsync<GhAnnotation[]>(
          `/repos/${repo}/check-runs/${run.id}/annotations`,
        );
        annotationsByRunId.set(run.id, annotations);
      } catch {
        /* skip annotation fetch failures */
      }
    }),
  );

  // Sort helper: failure=0, pending=1, success=2
  function sortOrder(run: GhCheckRunFull): number {
    if (run.status !== "completed") return 1;
    if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required") return 0;
    return 2;
  }

  // Group runs by suite
  const suiteRunsMap = new Map<number, GhCheckRunFull[]>();
  for (const run of dedupedRuns) {
    const suiteId = run.check_suite.id;
    if (!suiteRunsMap.has(suiteId)) suiteRunsMap.set(suiteId, []);
    suiteRunsMap.get(suiteId)!.push(run);
  }

  // Build response
  const suites = Array.from(suiteRunsMap.entries()).map(([suiteId, runs]) => {
    runs.sort((a, b) => sortOrder(a) - sortOrder(b));

    const hasFailure = runs.some((r) => sortOrder(r) === 0);
    const hasPending = runs.some((r) => r.status !== "completed");
    const suiteConclusion = hasFailure ? "failure" : hasPending ? null : "success";

    return {
      id: suiteId,
      name: suiteNameMap.get(suiteId) ?? "Unknown",
      conclusion: suiteConclusion,
      runs: runs.map((r) => {
        const annotations = (annotationsByRunId.get(r.id) ?? []).map((a) => ({
          path: a.path,
          startLine: a.start_line,
          endLine: a.end_line,
          level: a.annotation_level,
          message: a.message,
          title: a.title,
        }));
        const startMs = r.started_at ? new Date(r.started_at).getTime() : null;
        const endMs = r.completed_at ? new Date(r.completed_at).getTime() : null;
        return {
          id: r.id,
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          startedAt: r.started_at,
          completedAt: r.completed_at,
          durationMs: startMs && endMs ? endMs - startMs : null,
          htmlUrl: r.html_url,
          annotations,
        };
      }),
    };
  });

  // Sort suites: those with failures first
  suites.sort((a, b) => {
    const aFail = a.conclusion === "failure" ? 0 : 1;
    const bFail = b.conclusion === "failure" ? 0 : 1;
    return aFail - bFail;
  });

  json(res, suites);
});
```

- [ ] **Step 3: Verify the build compiles**

Run: `yarn build:all`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): add GET /api/pulls/:number/checks endpoint with suites, runs, and annotations"
```

---

### Task 4: Frontend API client — add `getChecks` method

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: Add the import for `CheckSuite` and the API method**

Add `CheckSuite` to the type import at the top of `web/src/api.ts`:

```ts
import type { User, RepoInfo, PullRequest, PullRequestDetail, PullFile, ReviewComment, CrWatchState, CheckSuite } from "./types";
```

Add to the `api` object:

```ts
getChecks: (number: number, repo: string) => fetchJSON<CheckSuite[]>(`/api/pulls/${number}/checks${repoQueryRequired(repo)}`),
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web/api): add getChecks method for CI checks endpoint"
```

---

### Task 5: Frontend — `ChecksPanel` component

**Files:**
- Create: `web/src/components/ChecksPanel.tsx`

- [ ] **Step 1: Create the ChecksPanel component**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import type { CheckSuite, CheckRun, CheckAnnotation } from "../types";
import { CollapsibleSection } from "./ui/collapsible-section";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Minus,
  CircleDot,
  Timer,
  AlertTriangle,
  ExternalLink,
  Loader2,
  FileCode,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function RunStatusIcon({ run }: { run: CheckRun }) {
  if (run.status === "in_progress") {
    return <Loader2 size={16} className="text-yellow-400 animate-spin" />;
  }
  if (run.status === "queued") {
    return <CircleDot size={16} className="text-yellow-400" />;
  }
  switch (run.conclusion) {
    case "success":
      return <CheckCircle2 size={16} className="text-green-400" />;
    case "failure":
      return <XCircle size={16} className="text-red-400" />;
    case "cancelled":
      return <XCircle size={16} className="text-gray-500" />;
    case "timed_out":
      return <Timer size={16} className="text-red-400" />;
    case "action_required":
      return <AlertTriangle size={16} className="text-orange-400" />;
    case "skipped":
    case "neutral":
      return <Minus size={16} className="text-gray-500" />;
    default:
      return <Clock size={16} className="text-gray-500" />;
  }
}

function SuiteStatusIcon({ conclusion }: { conclusion: string | null }) {
  if (conclusion === "success") return <CheckCircle2 size={14} className="text-green-400" />;
  if (conclusion === "failure") return <XCircle size={14} className="text-red-400" />;
  return <Loader2 size={14} className="text-yellow-400 animate-spin" />;
}

function AnnotationLevelBadge({ level }: { level: CheckAnnotation["level"] }) {
  const styles = {
    failure: "bg-red-900/50 text-red-300",
    warning: "bg-yellow-900/50 text-yellow-300",
    notice: "bg-blue-900/50 text-blue-300",
  };
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${styles[level]}`}>
      {level}
    </span>
  );
}

function AnnotationsList({
  annotations,
  onSelectFile,
}: {
  annotations: CheckAnnotation[];
  onSelectFile?: (file: string) => void;
}) {
  return (
    <div className="ml-8 mb-2 space-y-1">
      {annotations.map((a, i) => (
        <div key={i} className="text-xs bg-gray-900/60 border border-gray-800 rounded px-3 py-2">
          <div className="flex items-center gap-2 mb-1">
            <AnnotationLevelBadge level={a.level} />
            {a.title && <span className="text-gray-300 font-medium">{a.title}</span>}
          </div>
          <button
            type="button"
            className="flex items-center gap-1 text-blue-400 hover:text-blue-300 mb-1"
            onClick={() => onSelectFile?.(a.path)}
          >
            <FileCode size={12} />
            {a.path}:{a.startLine}{a.endLine !== a.startLine ? `-${a.endLine}` : ""}
          </button>
          <pre className="text-gray-400 whitespace-pre-wrap break-words">{a.message}</pre>
        </div>
      ))}
    </div>
  );
}

function CheckRunRow({
  run,
  onSelectFile,
}: {
  run: CheckRun;
  onSelectFile?: (file: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasAnnotations = run.annotations.length > 0;

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-1.5 hover:bg-gray-800/30">
        <RunStatusIcon run={run} />
        <button
          type="button"
          className={`flex-1 text-left text-sm text-gray-200 ${hasAnnotations ? "cursor-pointer hover:text-white" : ""}`}
          onClick={() => hasAnnotations && setExpanded(!expanded)}
          disabled={!hasAnnotations}
        >
          <span className="flex items-center gap-1.5">
            {run.name}
            {hasAnnotations && (
              expanded
                ? <ChevronDown size={12} className="text-gray-500" />
                : <ChevronRight size={12} className="text-gray-500" />
            )}
          </span>
        </button>
        {run.durationMs != null && (
          <span className="text-xs text-gray-500">{formatDuration(run.durationMs)}</span>
        )}
        <a
          href={run.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-600 hover:text-gray-400"
          title="View on GitHub"
        >
          <ExternalLink size={14} />
        </a>
      </div>
      {expanded && hasAnnotations && (
        <AnnotationsList annotations={run.annotations} onSelectFile={onSelectFile} />
      )}
    </div>
  );
}

export default function ChecksPanel({
  prNumber,
  repo,
  onSelectFile,
}: {
  prNumber: number;
  repo: string;
  onSelectFile?: (file: string) => void;
}) {
  const [suites, setSuites] = useState<CheckSuite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSuites(null);
    setError(null);
    api.getChecks(prNumber, repo).then(
      (data) => { if (!cancelled) setSuites(data); },
      (err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load checks"); },
    );
    return () => { cancelled = true; };
  }, [prNumber, repo]);

  if (error) {
    return <div className="text-red-400 text-sm p-4">{error}</div>;
  }

  if (suites === null) {
    return (
      <div className="flex items-center justify-center p-8 text-gray-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading checks...
      </div>
    );
  }

  if (suites.length === 0) {
    return <div className="text-gray-500 text-center mt-12">No CI checks found for this commit</div>;
  }

  return (
    <div className="overflow-y-auto flex-1">
      {suites.map((suite) => (
        <CollapsibleSection
          key={suite.id}
          defaultOpen={suite.conclusion === "failure" || suite.conclusion === null}
          title={
            <span className="flex items-center gap-2">
              <SuiteStatusIcon conclusion={suite.conclusion} />
              {suite.name}
              <span className="text-gray-600">({suite.runs.length})</span>
            </span>
          }
          className="px-4 py-2 text-sm text-gray-300 border-b border-gray-800"
        >
          <div className="divide-y divide-gray-800/50">
            {suite.runs.map((run) => (
              <CheckRunRow key={run.id} run={run} onSelectFile={onSelectFile} />
            ))}
          </div>
        </CollapsibleSection>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ChecksPanel.tsx
git commit -m "feat(web): add ChecksPanel component with suite grouping, status icons, and expandable annotations"
```

---

### Task 6: Frontend — wire Checks tab into App.tsx

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Add the import for ChecksPanel**

Add at the top of `App.tsx` with the other component imports:

```ts
import ChecksPanel from "./components/ChecksPanel";
```

- [ ] **Step 2: Extend the activeTab state type**

Change line 97 from:

```ts
const [activeTab, setActiveTab] = useState<"overview" | "threads" | "files">("threads");
```

to:

```ts
const [activeTab, setActiveTab] = useState<"overview" | "threads" | "files" | "checks">("threads");
```

- [ ] **Step 3: Add the Checks tab button to the tab bar**

In the tab bar array (around line 834), add the checks tab. Replace the existing array:

```ts
{([
  { id: "overview" as const, label: "Overview" },
  { id: "threads" as const, label: `Review (${prComments.filter((c) => c.inReplyToId === null).length})` },
  { id: "files" as const, label: `Files (${prFiles.length})` },
]).map((tab) => (
```

with:

```ts
{([
  { id: "overview" as const, label: "Overview" },
  { id: "threads" as const, label: `Review (${prComments.filter((c) => c.inReplyToId === null).length})` },
  { id: "files" as const, label: `Files (${prFiles.length})` },
  { id: "checks" as const, label: prDetail.checksSummary
    ? prDetail.checksSummary.failure > 0
      ? `Checks (${prDetail.checksSummary.failure}/${prDetail.checksSummary.total})`
      : `Checks (${prDetail.checksSummary.total})`
    : "Checks" },
]).map((tab) => (
```

- [ ] **Step 4: Add a colored dot indicator to the Checks tab**

The tab label string handles the count, but we also want a status dot. Update the tab button rendering to include a dot for the checks tab. Replace the tab button content from:

```tsx
{tab.label}
```

to:

```tsx
<span className="flex items-center gap-1.5">
  {tab.id === "checks" && prDetail?.checksSummary && (
    <span className={`inline-block w-2 h-2 rounded-full ${
      prDetail.checksSummary.failure > 0 ? "bg-red-400" :
      prDetail.checksSummary.pending > 0 ? "bg-yellow-400" :
      "bg-green-400"
    }`} />
  )}
  {tab.label}
</span>
```

- [ ] **Step 5: Add the ChecksPanel rendering in the tab content area**

After the existing `{activeTab === "files" && ( ... )}` block (around line 904), add:

```tsx
{activeTab === "checks" && selectedPR && (
  <ChecksPanel
    prNumber={selectedPR.number}
    repo={selectedPR.repo}
    onSelectFile={(f) => { setActiveTab("files"); setSelectedFile(f); }}
  />
)}
```

- [ ] **Step 6: Verify the full build compiles**

Run: `yarn build:all`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(web): wire Checks tab into PR detail view with status dot and lazy loading"
```

---

### Task 7: Smoke test

- [ ] **Step 1: Run the test suite**

Run: `yarn test`
Expected: All existing tests pass.

- [ ] **Step 2: Run the full build**

Run: `yarn build:all`
Expected: PASS — both CLI and web compile cleanly.

- [ ] **Step 3: Manual smoke test**

Run: `yarn dev`

1. Open the web UI in a browser
2. Select a PR that has CI checks
3. Verify the Checks tab appears with a count and status dot
4. Click the Checks tab — verify suites load with runs grouped
5. Verify failed runs show expandable annotations
6. Click an annotation file path — verify it navigates to the Files tab
7. Click the GitHub link icon on a run — verify it opens the check on GitHub

- [ ] **Step 4: Commit any fixes if needed**
