import { execAsync, ghAsync } from "./exec.js";

export type CiProvider = "github-actions" | "circleci";
export type CiRunStatus = "success" | "failure" | "pending";

export interface CiRun {
  id: string;
  provider: CiProvider;
  name: string;
  status: CiRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  htmlUrl: string | null;
  logsAvailable: boolean;
}

export interface CiProviderSection {
  provider: CiProvider;
  runs: CiRun[];
  status: CiRunStatus;
}

export interface PullCiResult {
  overallStatus: CiRunStatus;
  providers: CiProviderSection[];
}

export interface PullCiLogChunk {
  text: string;
  truncated: boolean;
  nextCursor: string | null;
  maxBytes: number;
  externalUrl: string | null;
}

const LOG_CHUNK_MAX_BYTES = 1_000_000;
const LOG_TOTAL_MAX_BYTES = 10_000_000;

function toStatus(input: string | null | undefined): CiRunStatus {
  const s = (input ?? "").toLowerCase();
  if (s === "success" || s === "passed") return "success";
  if (s === "failed" || s === "failure" || s === "error" || s === "timed_out" || s === "canceled" || s === "cancelled") return "failure";
  return "pending";
}

function reduceStatus(runs: CiRun[]): CiRunStatus {
  if (runs.some((r) => r.status === "failure")) return "failure";
  if (runs.some((r) => r.status === "pending")) return "pending";
  if (runs.some((r) => r.status === "success")) return "success";
  return "pending";
}

function durationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

type GhWorkflowRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string | null;
  updated_at: string | null;
};
type GhWorkflowRunList = { workflow_runs: GhWorkflowRun[] };
type GhActionsJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
};
type GhActionsJobs = { jobs: GhActionsJob[] };
type GhCommitStatus = {
  id: number;
  state: "success" | "failure" | "pending" | "error";
  context: string;
  target_url: string | null;
  created_at: string;
  updated_at: string;
};
type GhCombinedStatus = { statuses: GhCommitStatus[] };

async function getGitHubActionRuns(repo: string, sha: string): Promise<CiProviderSection> {
  const workflowRunsData = await ghAsync<GhWorkflowRunList>(
    `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`,
    repo,
  ).catch(() => ({ workflow_runs: [] }));
  const jobs: CiRun[] = [];
  await Promise.all(
    workflowRunsData.workflow_runs.slice(0, 10).map(async (run) => {
      const runJobs = await ghAsync<GhActionsJobs>(
        `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        repo,
      ).catch(() => ({ jobs: [] }));
      for (const job of runJobs.jobs) {
        jobs.push({
          id: String(job.id),
          provider: "github-actions",
          name: `${run.name}: ${job.name}`,
          status: toStatus(job.status === "completed" ? job.conclusion : job.status),
          startedAt: job.started_at,
          completedAt: job.completed_at,
          durationMs: durationMs(job.started_at, job.completed_at),
          htmlUrl: job.html_url ?? run.html_url,
          logsAvailable: true,
        });
      }
    }),
  );

  if (jobs.length === 0) {
    for (const run of workflowRunsData.workflow_runs) {
      jobs.push({
        id: `run-${run.id}`,
        provider: "github-actions",
        name: run.name || `Workflow #${run.id}`,
        status: toStatus(run.status === "completed" ? run.conclusion : run.status),
        startedAt: run.created_at,
        completedAt: run.updated_at,
        durationMs: durationMs(run.created_at, run.updated_at),
        htmlUrl: run.html_url ?? null,
        logsAvailable: false,
      });
    }
  }

  jobs.sort((a, b) => {
    const order = (s: CiRunStatus) => (s === "failure" ? 0 : s === "pending" ? 1 : 2);
    return order(a.status) - order(b.status);
  });
  return { provider: "github-actions", runs: jobs, status: reduceStatus(jobs) };
}

function statusProvider(status: GhCommitStatus): CiProvider {
  const ctx = status.context.toLowerCase();
  const target = (status.target_url ?? "").toLowerCase();
  if (ctx.startsWith("ci/circleci") || target.includes("circleci.com")) return "circleci";
  return "github-actions";
}

function circleRunIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/(\d+)(?:\?.*)?$/);
  return m ? m[1]! : null;
}

async function getCommitStatusRuns(repo: string, sha: string): Promise<CiRun[]> {
  const combined = await ghAsync<GhCombinedStatus>(`/repos/${repo}/commits/${sha}/status`, repo).catch(() => null);
  if (!combined?.statuses?.length) return [];
  const latestByContext = new Map<string, GhCommitStatus>();
  for (const s of combined.statuses) {
    const existing = latestByContext.get(s.context);
    if (!existing || s.id > existing.id) latestByContext.set(s.context, s);
  }
  return Array.from(latestByContext.values()).map((s) => {
    const provider = statusProvider(s);
    const circleRunId = provider === "circleci" ? circleRunIdFromUrl(s.target_url) : null;
    const isPending = s.state === "pending";
    return {
      id: circleRunId ?? String(s.id),
      provider,
      name: s.context,
      status: toStatus(s.state),
      startedAt: s.created_at ?? null,
      completedAt: isPending ? null : (s.updated_at ?? null),
      durationMs: null,
      htmlUrl: s.target_url ?? null,
      logsAvailable: provider === "circleci" && Boolean(circleRunId),
    } satisfies CiRun;
  });
}

let circleciAvailableCache: { at: number; value: boolean } | null = null;
async function isCircleCiAvailable(): Promise<boolean> {
  const now = Date.now();
  if (circleciAvailableCache && now - circleciAvailableCache.at < 60_000) return circleciAvailableCache.value;
  try {
    await execAsync("circleci", ["version"], { timeout: 4000 });
    circleciAvailableCache = { at: now, value: true };
    return true;
  } catch {
    circleciAvailableCache = { at: now, value: false };
    return false;
  }
}

async function circleciApi(path: string): Promise<unknown> {
  const out = await execAsync("circleci", ["api", "-X", "GET", path], { timeout: 15000 });
  return JSON.parse(out);
}

type CirclePipeline = {
  id: string;
  vcs?: { revision?: string | null };
  created_at?: string;
  updated_at?: string;
};
type CirclePipelinesResp = { items?: CirclePipeline[] };
type CircleWorkflow = {
  id: string;
  name: string;
  status: string;
  created_at?: string;
  stopped_at?: string;
  pipeline_id?: string;
};
type CircleWorkflowResp = { items?: CircleWorkflow[] };
type CircleJob = {
  id: string;
  name: string;
  status: string;
  started_at?: string;
  stopped_at?: string;
  project_slug?: string;
  job_number?: number;
};
type CircleJobsResp = { items?: CircleJob[] };

async function getCircleCiRuns(repo: string, branch: string, sha: string): Promise<CiProviderSection> {
  if (!(await isCircleCiAvailable())) {
    return { provider: "circleci", runs: [], status: "pending" };
  }
  const slug = `gh/${repo}`;
  const pipelines = (await circleciApi(`/project/${slug}/pipeline?branch=${encodeURIComponent(branch)}`) as CirclePipelinesResp).items ?? [];
  const matchingPipelines = pipelines.filter((p) => p.vcs?.revision === sha).slice(0, 10);
  const workflows: CircleWorkflow[] = [];
  await Promise.all(
    matchingPipelines.map(async (pipeline) => {
      const ws = (await circleciApi(`/pipeline/${pipeline.id}/workflow`) as CircleWorkflowResp).items ?? [];
      workflows.push(...ws);
    }),
  );
  const jobs: CiRun[] = [];
  await Promise.all(
    workflows.slice(0, 20).map(async (wf) => {
      const wfJobs = (await circleciApi(`/workflow/${wf.id}/job`) as CircleJobsResp).items ?? [];
      for (const job of wfJobs) {
        const htmlUrl = job.project_slug && job.job_number != null
          ? `https://app.circleci.com/pipelines/${job.project_slug}/${job.job_number}`
          : null;
        jobs.push({
          id: String(job.id),
          provider: "circleci",
          name: `${wf.name}: ${job.name}`,
          status: toStatus(job.status),
          startedAt: job.started_at ?? null,
          completedAt: job.stopped_at ?? null,
          durationMs: durationMs(job.started_at ?? null, job.stopped_at ?? null),
          htmlUrl,
          logsAvailable: true,
        });
      }
    }),
  );
  jobs.sort((a, b) => {
    const order = (s: CiRunStatus) => (s === "failure" ? 0 : s === "pending" ? 1 : 2);
    return order(a.status) - order(b.status);
  });
  return { provider: "circleci", runs: jobs, status: reduceStatus(jobs) };
}

export async function getPullCi(repo: string, branch: string, sha: string): Promise<PullCiResult> {
  const [ghActions, circleApi, commitStatusRuns] = await Promise.all([
    getGitHubActionRuns(repo, sha).catch(() => ({ provider: "github-actions", runs: [], status: "pending" } satisfies CiProviderSection)),
    getCircleCiRuns(repo, branch, sha).catch(() => ({ provider: "circleci", runs: [], status: "pending" } satisfies CiProviderSection)),
    getCommitStatusRuns(repo, sha).catch(() => [] as CiRun[]),
  ]);

  const allGithubRuns = [...ghActions.runs, ...commitStatusRuns.filter((r) => r.provider === "github-actions")];
  const allCircleRuns = [...circleApi.runs, ...commitStatusRuns.filter((r) => r.provider === "circleci")];
  function dedupeRuns(runs: CiRun[]): CiRun[] {
    const out = new Map<string, CiRun>();
    for (const run of runs) {
      const key = `${run.provider}\0${run.name}\0${run.htmlUrl ?? ""}`;
      const existing = out.get(key);
      if (!existing) {
        out.set(key, run);
        continue;
      }
      const existingTs = Date.parse(existing.completedAt ?? existing.startedAt ?? "");
      const runTs = Date.parse(run.completedAt ?? run.startedAt ?? "");
      if (!Number.isFinite(existingTs) || runTs > existingTs) out.set(key, run);
    }
    const deduped = Array.from(out.values());
    deduped.sort((a, b) => {
      const order = (s: CiRunStatus) => (s === "failure" ? 0 : s === "pending" ? 1 : 2);
      return order(a.status) - order(b.status);
    });
    return deduped;
  }

  const ghRuns = dedupeRuns(allGithubRuns);
  const circleRuns = dedupeRuns(allCircleRuns);
  const providers = [
    { provider: "github-actions", runs: ghRuns, status: reduceStatus(ghRuns) } satisfies CiProviderSection,
    { provider: "circleci", runs: circleRuns, status: reduceStatus(circleRuns) } satisfies CiProviderSection,
  ];
  const overallStatus = reduceStatus(providers.flatMap((p) => p.runs));
  return { overallStatus, providers };
}

function buildLogChunk(raw: string, cursor: number, externalUrl: string | null): PullCiLogChunk {
  const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
  const capped = raw.slice(0, LOG_TOTAL_MAX_BYTES);
  const end = Math.min(capped.length, safeCursor + LOG_CHUNK_MAX_BYTES);
  return {
    text: capped.slice(safeCursor, end),
    truncated: capped.length < raw.length || end < capped.length,
    nextCursor: end < capped.length ? String(end) : null,
    maxBytes: LOG_CHUNK_MAX_BYTES,
    externalUrl,
  };
}

export async function getPullCiLogs(input: {
  provider: CiProvider;
  repo: string;
  runId: string;
  cursor?: string;
}): Promise<PullCiLogChunk> {
  const cursor = input.cursor ? parseInt(input.cursor, 10) : 0;
  if (input.provider === "github-actions") {
    const out = await execAsync("gh", ["run", "view", input.runId, "--repo", input.repo, "--log"], { timeout: 20000 });
    return buildLogChunk(out, cursor, `https://github.com/${input.repo}/actions/runs/${input.runId}`);
  }
  const out = await execAsync("circleci", ["build", "show", input.runId], { timeout: 20000 });
  return buildLogChunk(out, cursor, null);
}
