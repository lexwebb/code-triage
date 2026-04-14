import { addRoute, json, getRepos, getBody, getPollState, getHealthPayload, setFixJobStatus, clearFixJobStatus, getActiveFixForBranch, getActiveFixForPR, subscribeSse, getListenPort, notifyConfigSaved } from "./server.js";
import type { RepoInfo } from "./discovery.js";
import { loadConfig, saveConfig, configExists, type Config } from "./config.js";
import { loadState, markComment, patchCommentTriage, saveState, addFixJob as addFixJobState, removeFixJob as removeFixJobState, getFixJobs, getPendingTriageCountsByPr, needsEvaluation } from "./state.js";
import { postReply, resolveThread, applyFixWithClaude, clampEvalConcurrency } from "./actioner.js";
import { createWorktree, getWorktreePath, getDiffInWorktree, removeWorktree, commitAndPushWorktree } from "./worktree.js";
import { ghAsync, ghPost } from "./exec.js";
import { batchPullPollData, type PullPollData } from "./github-batching.js";
import { clearRepoPollSchedule } from "./repo-poll-schedule.js";
import { enqueueEvaluation, drainOnce } from "./eval-queue.js";
import { buildIgnoredBotSet } from "./poller.js";
import { getRawSqlite } from "./db/client.js";

const GITHUB_USER_CACHE_MS = 60_000;
let cachedGitHubUser: { at: number; user: { login: string; avatar_url: string; html_url: string } } | null = null;

/**
 * Cached GET /user; on failure (rate limit, network) returns the last successful user (stale-while-error),
 * or `null` if we have never successfully fetched (avoids 500 on `/api/pulls-bundle` when GitHub throttles).
 */
async function getCachedGitHubUser(): Promise<{ login: string; avatar_url: string; html_url: string } | null> {
  const now = Date.now();
  if (cachedGitHubUser && now - cachedGitHubUser.at < GITHUB_USER_CACHE_MS) {
    return cachedGitHubUser.user;
  }
  try {
    const user = await ghAsync<{ login: string; avatar_url: string; html_url: string }>("/user");
    cachedGitHubUser = { at: now, user };
    return user;
  } catch {
    if (cachedGitHubUser) {
      return cachedGitHubUser.user;
    }
    return null;
  }
}

async function getUsernameOrNull(): Promise<string | null> {
  const u = await getCachedGitHubUser();
  return u?.login ?? null;
}

interface GhPull {
  number: number;
  title: string;
  user: { login: string; avatar_url: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  requested_reviewers: Array<{ login: string; avatar_url: string }>;
  mergeable_state: string;
}

interface GhCombinedStatus {
  state: "success" | "failure" | "pending" | "error";
}

async function getPrStatus(repoPath: string, sha: string): Promise<"success" | "failure" | "pending"> {
  try {
    const status = await ghAsync<GhCombinedStatus>(`/repos/${repoPath}/commits/${sha}/status`);
    if (status.state === "success") return "success";
    if (status.state === "failure" || status.state === "error") return "failure";
  } catch { /* ignore */ }
  return "pending";
}

function openTopLevelUnresolvedCount(
  comments: Array<{ id: number; in_reply_to_id: number | null }>,
  resolvedIds: Set<number>,
): number {
  return comments.filter((c) => c.in_reply_to_id === null && !resolvedIds.has(c.id)).length;
}

/** One pass per repo: single list of open PRs, then authored + review-requested rows (halves REST vs two endpoints). */
async function buildPullSidebarLists(targetRepos: RepoInfo[]): Promise<{
  authored: Array<Record<string, unknown>>;
  reviewRequested: Array<Record<string, unknown>>;
  /** True when GET /user failed and we have no cached login (sidebar lists are empty). */
  githubUserUnavailable?: boolean;
}> {
  const username = await getUsernameOrNull();
  if (username == null) {
    return { authored: [], reviewRequested: [], githubUserUnavailable: true };
  }
  const triageCounts = getPendingTriageCountsByPr();
  const authored: Array<Record<string, unknown>> = [];
  const reviewRequested: Array<Record<string, unknown>> = [];

  for (const repoInfo of targetRepos) {
    try {
      const pulls = await ghAsync<GhPull[]>(`/repos/${repoInfo.repo}/pulls?state=open`);
      const myPulls = pulls.filter((pr) => pr.user.login === username);
      const needsReview = pulls.filter(
        (pr) =>
          pr.user.login !== username &&
          pr.requested_reviewers.some((r) => r.login === username),
      );
      const prNums = [...new Set([...myPulls.map((p) => p.number), ...needsReview.map((p) => p.number)])];
      const pollByPr = prNums.length === 0 ? new Map<number, PullPollData>() : await batchPullPollData(repoInfo.repo, prNums);

      async function buildRow(
        pr: GhPull,
        poll: PullPollData | undefined,
      ): Promise<Record<string, unknown>> {
        const checksStatus = await getPrStatus(repoInfo.repo, pr.head.sha);
        const openComments = poll
          ? openTopLevelUnresolvedCount(poll.comments, poll.resolvedIds)
          : 0;
        return {
          number: pr.number,
          title: pr.title,
          author: pr.user.login,
          authorAvatar: pr.user.avatar_url,
          branch: pr.head.ref,
          baseBranch: pr.base.ref,
          url: pr.html_url,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          draft: pr.draft,
          repo: repoInfo.repo,
          checksStatus,
          openComments,
          pendingTriage: triageCounts.get(`${repoInfo.repo}:${pr.number}`) ?? 0,
          hasHumanApproval: poll?.hasHumanApproval ?? false,
        };
      }

      const authoredRows = await Promise.all(
        myPulls.map((pr) => buildRow(pr, pollByPr.get(pr.number))),
      );
      const reviewRows = await Promise.all(
        needsReview.map((pr) => buildRow(pr, pollByPr.get(pr.number))),
      );
      authored.push(...authoredRows);
      reviewRequested.push(...reviewRows);
    } catch {
      /* skip repos that fail (e.g., no access) */
    }
  }

  return { authored, reviewRequested };
}

export function toInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && v.trim() !== "") return parseInt(v, 10);
  return fallback;
}

/** Safe JSON shape for the web settings form (no account tokens). */
export function serializeConfigForClient(c: Config): Record<string, unknown> {
  return {
    root: c.root,
    port: c.port,
    interval: c.interval,
    evalConcurrency: c.evalConcurrency ?? 2,
    pollReviewRequested: c.pollReviewRequested ?? false,
    commentRetentionDays: c.commentRetentionDays ?? 0,
    ignoredBots: c.ignoredBots ?? [],
    accounts: (c.accounts ?? []).map((a) => ({
      name: a.name,
      orgs: a.orgs,
      hasToken: Boolean(a.token?.length),
    })),
    hasGithubToken: Boolean(c.githubToken?.length),
    evalPromptAppend: c.evalPromptAppend ?? "",
    evalPromptAppendByRepo: c.evalPromptAppendByRepo ?? {},
    evalClaudeExtraArgs: c.evalClaudeExtraArgs ?? [],
    repoPollStaleAfterDays: c.repoPollStaleAfterDays ?? 7,
    repoPollColdIntervalMinutes: c.repoPollColdIntervalMinutes ?? 60,
    pollApiHeadroom: c.pollApiHeadroom ?? 0.35,
    pollRateLimitAware: c.pollRateLimitAware !== false,
    preferredEditor: c.preferredEditor ?? "vscode",
    fixConversationMaxTurns: c.fixConversationMaxTurns ?? 5,
  };
}

export function mergeConfigFromBody(body: Record<string, unknown>, previous: Config): Config {
  const root = typeof body.root === "string" ? body.root.trim() : previous.root;
  if (!root) throw new Error("root is required");

  const port = toInt(body.port, previous.port);
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error("port must be 1–65535");

  const interval = toInt(body.interval, previous.interval);
  if (!Number.isFinite(interval) || interval < 1) throw new Error("interval must be at least 1 (minutes)");

  const evalConcurrency = clampEvalConcurrency(
    body.evalConcurrency !== undefined && body.evalConcurrency !== null && body.evalConcurrency !== ""
      ? toInt(body.evalConcurrency, previous.evalConcurrency ?? 2)
      : (previous.evalConcurrency ?? 2),
  );

  const pollReviewRequested =
    typeof body.pollReviewRequested === "boolean"
      ? body.pollReviewRequested
      : (previous.pollReviewRequested ?? false);

  let commentRetentionDays: number;
  if (body.commentRetentionDays !== undefined && body.commentRetentionDays !== null && body.commentRetentionDays !== "") {
    commentRetentionDays = Math.max(0, toInt(body.commentRetentionDays, 0));
  } else {
    commentRetentionDays = previous.commentRetentionDays ?? 0;
  }

  let ignoredBots: string[] | undefined;
  if (body.ignoredBots === undefined) {
    ignoredBots = previous.ignoredBots;
  } else if (Array.isArray(body.ignoredBots)) {
    ignoredBots = body.ignoredBots.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  } else {
    throw new Error("ignoredBots must be an array of strings");
  }

  let githubToken: string | undefined;
  if (body.githubToken === undefined) {
    githubToken = previous.githubToken;
  } else if (typeof body.githubToken === "string") {
    const t = body.githubToken.trim();
    githubToken = t || undefined;
  } else {
    throw new Error("githubToken must be a string");
  }

  let accounts: Config["accounts"];
  if (body.accounts === undefined) {
    accounts = previous.accounts;
  } else if (!Array.isArray(body.accounts)) {
    throw new Error("accounts must be an array");
  } else if (body.accounts.length === 0) {
    accounts = undefined;
  } else {
    accounts = body.accounts.map((row, i) => {
      if (!row || typeof row !== "object") throw new Error(`accounts[${i}] invalid`);
      const r = row as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name.trim() : "";
      if (!name) throw new Error(`accounts[${i}]: name required`);
      let orgs: string[];
      if (Array.isArray(r.orgs)) {
        orgs = r.orgs.filter((x): x is string => typeof x === "string").map((o) => o.trim()).filter(Boolean);
      } else if (typeof r.orgs === "string") {
        orgs = r.orgs.split(",").map((o) => o.trim()).filter(Boolean);
      } else {
        orgs = [];
      }
      const tokenIn = typeof r.token === "string" ? r.token.trim() : "";
      const prevAcc = previous.accounts?.find((a) => a.name === name);
      const token = tokenIn || prevAcc?.token || "";
      if (!token) throw new Error(`Account "${name}": personal access token required`);
      return { name, orgs, token };
    });
  }

  let evalPromptAppend: string | undefined;
  if (body.evalPromptAppend === undefined) {
    evalPromptAppend = previous.evalPromptAppend;
  } else if (body.evalPromptAppend === null || body.evalPromptAppend === "") {
    evalPromptAppend = undefined;
  } else if (typeof body.evalPromptAppend === "string") {
    evalPromptAppend = body.evalPromptAppend;
  } else {
    throw new Error("evalPromptAppend must be a string");
  }

  let evalPromptAppendByRepo: Record<string, string> | undefined;
  if (body.evalPromptAppendByRepo === undefined) {
    evalPromptAppendByRepo = previous.evalPromptAppendByRepo;
  } else if (body.evalPromptAppendByRepo === null) {
    evalPromptAppendByRepo = undefined;
  } else if (typeof body.evalPromptAppendByRepo === "object" && !Array.isArray(body.evalPromptAppendByRepo)) {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.evalPromptAppendByRepo)) {
      if (typeof v === "string" && v.trim()) o[k] = v;
    }
    evalPromptAppendByRepo = Object.keys(o).length ? o : undefined;
  } else {
    throw new Error("evalPromptAppendByRepo must be an object");
  }

  let evalClaudeExtraArgs: string[] | undefined;
  if (body.evalClaudeExtraArgs === undefined) {
    evalClaudeExtraArgs = previous.evalClaudeExtraArgs;
  } else if (Array.isArray(body.evalClaudeExtraArgs)) {
    const xs = body.evalClaudeExtraArgs.filter((x): x is string => typeof x === "string");
    evalClaudeExtraArgs = xs.length ? xs : undefined;
  } else {
    throw new Error("evalClaudeExtraArgs must be an array of strings");
  }

  let repoPollStaleAfterDays: number | undefined;
  if (body.repoPollStaleAfterDays === undefined || body.repoPollStaleAfterDays === null || body.repoPollStaleAfterDays === "") {
    repoPollStaleAfterDays = previous.repoPollStaleAfterDays;
  } else {
    repoPollStaleAfterDays = Math.max(0, toInt(body.repoPollStaleAfterDays, previous.repoPollStaleAfterDays ?? 7));
  }

  let repoPollColdIntervalMinutes: number | undefined;
  if (body.repoPollColdIntervalMinutes === undefined || body.repoPollColdIntervalMinutes === null || body.repoPollColdIntervalMinutes === "") {
    repoPollColdIntervalMinutes = previous.repoPollColdIntervalMinutes;
  } else {
    repoPollColdIntervalMinutes = Math.max(1, toInt(body.repoPollColdIntervalMinutes, previous.repoPollColdIntervalMinutes ?? 60));
  }

  let pollApiHeadroom: number | undefined;
  if (body.pollApiHeadroom === undefined || body.pollApiHeadroom === null || body.pollApiHeadroom === "") {
    pollApiHeadroom = previous.pollApiHeadroom ?? 0.35;
  } else {
    const h = typeof body.pollApiHeadroom === "number" ? body.pollApiHeadroom : parseFloat(String(body.pollApiHeadroom));
    if (!Number.isFinite(h) || h < 0 || h > 0.95) throw new Error("pollApiHeadroom must be between 0 and 0.95");
    pollApiHeadroom = h;
  }

  const pollRateLimitAware =
    typeof body.pollRateLimitAware === "boolean"
      ? body.pollRateLimitAware
      : (previous.pollRateLimitAware !== false);

  const preferredEditor =
    typeof body.preferredEditor === "string" && body.preferredEditor.trim()
      ? body.preferredEditor.trim()
      : (previous.preferredEditor ?? "vscode");

  const fixConversationMaxTurns = toInt(body.fixConversationMaxTurns, previous.fixConversationMaxTurns ?? 5);

  return {
    root,
    port,
    interval,
    evalConcurrency,
    pollReviewRequested,
    commentRetentionDays: commentRetentionDays > 0 ? commentRetentionDays : undefined,
    ignoredBots: ignoredBots?.length ? ignoredBots : undefined,
    githubToken,
    accounts,
    evalPromptAppend,
    evalPromptAppendByRepo,
    evalClaudeExtraArgs,
    repoPollStaleAfterDays,
    repoPollColdIntervalMinutes,
    pollApiHeadroom,
    pollRateLimitAware,
    preferredEditor,
    fixConversationMaxTurns,
  };
}

function requireRepo(query: URLSearchParams): string {
  const repo = query.get("repo");
  if (!repo) throw new Error("Missing required ?repo= query parameter");
  const repos = getRepos();
  if (!repos.some((r) => r.repo === repo)) {
    throw new Error(`Repo "${repo}" is not tracked`);
  }
  return repo;
}

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

export function registerRoutes(): void {

  // GET /api/config — settings for web UI (tokens omitted)
  addRoute("GET", "/api/config", (_req, res) => {
    const c = loadConfig();
    json(res, {
      config: serializeConfigForClient(c),
      needsSetup: !configExists(),
      listenPort: getListenPort(),
    });
  });

  // POST /api/config — save ~/.code-triage/config.json and reload in-process state
  addRoute("POST", "/api/config", async (req, res) => {
    const body = getBody<Record<string, unknown>>(req);
    const previous = loadConfig();
    const next = mergeConfigFromBody(body, previous);
    saveConfig(next);
    notifyConfigSaved();
    const restartRequired = next.port !== getListenPort();
    json(res, { ok: true, restartRequired });
  });

  // GET /api/events — Server-Sent Events (poll + fix-job broadcasts)
  addRoute("GET", "/api/events", (req, res) => {
    subscribeSse(req, res);
  });

  // GET /api/user
  addRoute("GET", "/api/user", async (_req, res) => {
    const user = await getCachedGitHubUser();
    if (!user) {
      json(res, { login: "", avatarUrl: "", url: "", degraded: true });
      return;
    }
    json(res, { login: user.login, avatarUrl: user.avatar_url, url: user.html_url });
  });

  // GET /api/repos
  addRoute("GET", "/api/repos", (_req, res) => {
    json(res, getRepos());
  });

  // GET /api/pulls-bundle?repo= — single round-trip for sidebar (authored + review-requested; one GET pulls per repo)
  addRoute("GET", "/api/pulls-bundle", async (_req, res, _params, query) => {
    const repoFilter = query.get("repo");
    const targetRepos = repoFilter
      ? getRepos().filter((r) => r.repo === repoFilter)
      : getRepos();
    const lists = await buildPullSidebarLists(targetRepos);
    json(res, lists);
  });

  // GET /api/pulls?repo=owner/repo (optional — if omitted, returns all)
  addRoute("GET", "/api/pulls", async (_req, res, _params, query) => {
    const repoFilter = query.get("repo");
    const targetRepos = repoFilter
      ? getRepos().filter((r) => r.repo === repoFilter)
      : getRepos();
    const { authored } = await buildPullSidebarLists(targetRepos);
    json(res, authored);
  });

  // GET /api/pulls/review-requested?repo=owner/repo (optional)
  addRoute("GET", "/api/pulls/review-requested", async (_req, res, _params, query) => {
    const repoFilter = query.get("repo");
    const targetRepos = repoFilter
      ? getRepos().filter((r) => r.repo === repoFilter)
      : getRepos();
    const { reviewRequested } = await buildPullSidebarLists(targetRepos);
    json(res, reviewRequested);
  });

  // GET /api/pulls/:number?repo=owner/repo
  addRoute("GET", "/api/pulls/:number", async (_req, res, params, query) => {
    const repo = requireRepo(query);
    const prNumber = parseInt(params.number, 10);

    const pr = await ghAsync<{
      number: number;
      title: string;
      body: string;
      user: { login: string; avatar_url: string };
      head: { ref: string; sha: string };
      base: { ref: string };
      html_url: string;
      created_at: string;
      updated_at: string;
      draft: boolean;
      additions: number;
      deletions: number;
      changed_files: number;
      requested_reviewers: Array<{ login: string; avatar_url: string }>;
    }>(`/repos/${repo}/pulls/${prNumber}`);

    // Fetch reviews to get each reviewer's latest state
    interface GhReview {
      user: { login: string; avatar_url: string };
      state: string;
      submitted_at: string;
    }
    const reviews = await ghAsync<GhReview[]>(`/repos/${repo}/pulls/${prNumber}/reviews`);

    const reviewerMap = new Map<string, { login: string; avatar: string; state: string }>();

    for (const r of pr.requested_reviewers) {
      reviewerMap.set(r.login, { login: r.login, avatar: r.avatar_url, state: "PENDING" });
    }

    for (const r of reviews) {
      if (r.state === "COMMENTED" || r.state === "DISMISSED") {
        if (!reviewerMap.has(r.user.login)) {
          reviewerMap.set(r.user.login, { login: r.user.login, avatar: r.user.avatar_url, state: r.state });
        }
        continue;
      }
      reviewerMap.set(r.user.login, { login: r.user.login, avatar: r.user.avatar_url, state: r.state });
    }

    const checksSummary = await getChecksSummary(repo, pr.head.sha);

    json(res, {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.user.login,
      authorAvatar: pr.user.avatar_url,
      branch: pr.head.ref,
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      draft: pr.draft,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      repo,
      reviewers: Array.from(reviewerMap.values()),
      checksSummary,
    });
  });

  // GET /api/pulls/:number/checks?repo=owner/repo&sha=abc123
  addRoute("GET", "/api/pulls/:number/checks", async (_req, res, params, query) => {
    const repo = requireRepo(query);
    const prNumber = parseInt(params.number, 10);

    // Use SHA from query param (already known from PR detail) to avoid an extra API call
    let sha = query.get("sha") ?? "";
    if (!sha) {
      const pr = await ghAsync<{ head: { sha: string } }>(`/repos/${repo}/pulls/${prNumber}`);
      sha = pr.head.sha;
    }

    // Fetch suites and runs in parallel (per_page=100; repos with >100 check runs will be truncated)
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

  // GET /api/pulls/:number/files?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/files", async (_req, res, params, query) => {
    const repo = requireRepo(query);

    interface GhFile {
      sha: string;
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }

    const files = await ghAsync<GhFile[]>(`/repos/${repo}/pulls/${params.number}/files`);

    json(res, files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || "",
    })));
  });

  // GET /api/pulls/:number/comments?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/comments", async (_req, res, params, query) => {
    const repo = requireRepo(query);
    const prNumber = parseInt(params.number, 10);

    const pollByPr = await batchPullPollData(repo, [prNumber]);
    const poll = pollByPr.get(prNumber);
    const comments = poll?.comments ?? [];
    const resolvedIds = poll?.resolvedIds ?? new Set<number>();

    const state = loadState();
    const config = loadConfig();
    const ignoredBots = buildIgnoredBotSet(config.ignoredBots);

    // Enqueue evaluations for comments missing them
    let enqueued = 0;
    for (const c of comments) {
      if (ignoredBots.has(c.user.login)) continue;
      if (!needsEvaluation(state, c.id, repo)) continue;
      const crComment = {
        id: c.id,
        prNumber,
        path: c.path,
        line: c.line || c.original_line || 0,
        diffHunk: c.diff_hunk,
        body: c.body,
        inReplyToId: c.in_reply_to_id ?? null,
      };
      const result = enqueueEvaluation(crComment, prNumber, repo, state);
      if (result === "queued") enqueued++;
    }
    if (enqueued > 0) {
      saveState(state);
      void drainOnce();
    }

    json(res, comments.map((c) => {
      const stateKey = `${repo}:${c.id}`;
      const record = state.comments[stateKey];
      return {
        id: c.id,
        htmlUrl: c.html_url ?? "",
        author: c.user.login,
        authorAvatar: c.user.avatar_url ?? "",
        path: c.path,
        line: c.line || c.original_line || 0,
        diffHunk: c.diff_hunk,
        body: c.body,
        createdAt: c.created_at ?? "",
        inReplyToId: c.in_reply_to_id ?? null,
        isResolved: resolvedIds.has(c.id),
        evaluation: record?.evaluation ?? null,
        crStatus: record?.status ?? null,
        snoozeUntil: record?.snoozeUntil ?? null,
        priority: record?.priority ?? null,
        triageNote: record?.triageNote ?? null,
        evalFailed: record?.evalFailed ?? false,
      };
    }));
  });

  // GET /api/pulls/:number/files/*path?repo=owner/repo (full file content)
  addRoute("GET", "/api/pulls/:number/files/*path", async (_req, res, params, query) => {
    const repo = requireRepo(query);
    const pr = await ghAsync<{ head: { ref: string } }>(`/repos/${repo}/pulls/${params.number}`);
    const filePath = params.path;

    try {
      const file = await ghAsync<{ content: string }>(`/repos/${repo}/contents/${filePath}?ref=${pr.head.ref}`);
      const decoded = Buffer.from(file.content, "base64").toString("utf-8");
      json(res, { content: decoded, path: filePath });
    } catch {
      json(res, { error: "File not found" }, 404);
    }
  });

  // GET /api/state
  addRoute("GET", "/api/state", (_req, res) => {
    json(res, loadState());
  });

  // GET /api/health — readiness snapshot (does not consume test-notification flag)
  addRoute("GET", "/api/health", (_req, res) => {
    json(res, {
      ...getHealthPayload(),
      persistedLastPoll: loadState().lastPoll,
    });
  });

  // GET /api/poll-status
  addRoute("GET", "/api/poll-status", (_req, res) => {
    json(res, getPollState());
  });

  // GET /api/version — check if running version is behind origin/main
  let versionCache: { localSha: string; remoteSha: string; behind: number; checkedAt: number } | null = null;
  addRoute("GET", "/api/version", async (_req, res) => {
    // Cache for 10 minutes
    if (versionCache && Date.now() - versionCache.checkedAt < 600_000) {
      json(res, versionCache);
      return;
    }
    try {
      const { execFileSync } = await import("child_process");
      const cwd = new URL(".", import.meta.url).pathname;
      // Fetch latest from remote (silent)
      try { execFileSync("git", ["fetch", "origin", "main", "--quiet"], { cwd, stdio: "pipe", timeout: 10000 }); } catch { /* offline */ }
      const localSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8", timeout: 5000 }).trim();
      const remoteSha = execFileSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf-8", timeout: 5000 }).trim();
      let behind = 0;
      if (localSha !== remoteSha) {
        const count = execFileSync("git", ["rev-list", "--count", `HEAD..origin/main`], { cwd, encoding: "utf-8", timeout: 5000 }).trim();
        behind = parseInt(count, 10) || 0;
      }
      versionCache = { localSha: localSha.slice(0, 7), remoteSha: remoteSha.slice(0, 7), behind, checkedAt: Date.now() };
      json(res, versionCache);
    } catch (err) {
      json(res, { localSha: "unknown", remoteSha: "unknown", behind: 0, checkedAt: Date.now(), error: (err as Error).message });
    }
  });

  // POST /api/actions/clear-repo-poll-schedule — wipe `repo_poll` so the next CLI poll recomputes adaptive hot/cold
  addRoute("POST", "/api/actions/clear-repo-poll-schedule", async (_req, res) => {
    clearRepoPollSchedule();
    json(res, { ok: true });
  });

  // POST /api/actions/reply
  addRoute("POST", "/api/actions/reply", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];

    if (!record?.evaluation?.reply) {
      json(res, { error: "No reply text in evaluation" }, 400);
      return;
    }

    await postReply(body.repo, body.prNumber, body.commentId, record.evaluation.reply);
    await resolveThread(body.repo, body.commentId, body.prNumber, undefined);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "replied" });
  });

  // POST /api/actions/resolve
  addRoute("POST", "/api/actions/resolve", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];

    await resolveThread(body.repo, body.commentId, body.prNumber, record?.evaluation?.reply);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "replied" });
  });

  // POST /api/actions/dismiss
  addRoute("POST", "/api/actions/dismiss", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    markComment(state, body.commentId, "dismissed", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "dismissed" });
  });

  // POST /api/actions/batch — perform reply/resolve/dismiss on multiple comments
  addRoute("POST", "/api/actions/batch", async (req, res) => {
    const body = getBody<{ action: "reply" | "resolve" | "dismiss"; items: Array<{ repo: string; commentId: number; prNumber: number }> }>(req);
    const state = loadState();
    const results: Array<{ commentId: number; success: boolean; error?: string }> = [];

    for (const item of body.items) {
      try {
        const key = `${item.repo}:${item.commentId}`;
        const record = state.comments[key];

        if (body.action === "reply") {
          if (!record?.evaluation?.reply) throw new Error("No reply text in evaluation");
          await postReply(item.repo, item.prNumber, item.commentId, record.evaluation.reply);
          await resolveThread(item.repo, item.commentId, item.prNumber, undefined);
          markComment(state, item.commentId, "replied", item.prNumber, item.repo);
        } else if (body.action === "resolve") {
          await resolveThread(item.repo, item.commentId, item.prNumber, record?.evaluation?.reply);
          markComment(state, item.commentId, "replied", item.prNumber, item.repo);
        } else {
          markComment(state, item.commentId, "dismissed", item.prNumber, item.repo);
        }
        results.push({ commentId: item.commentId, success: true });
      } catch (err) {
        results.push({ commentId: item.commentId, success: false, error: (err as Error).message });
      }
    }

    saveState(state);
    json(res, { results });
  });

  // POST /api/actions/re-evaluate — re-run Claude evaluation on a comment
  addRoute("POST", "/api/actions/re-evaluate", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();

    let ghComment: { id: number; path: string; line: number | null; original_line: number | null; diff_hunk: string; body: string; in_reply_to_id: number | null };
    try {
      ghComment = await ghAsync<typeof ghComment>(`/repos/${body.repo}/pulls/comments/${body.commentId}`);
    } catch (err) {
      json(res, { error: `Failed to fetch comment: ${(err as Error).message}` }, 500);
      return;
    }

    const comment = {
      id: ghComment.id,
      prNumber: body.prNumber,
      path: ghComment.path,
      line: ghComment.line ?? ghComment.original_line ?? 0,
      diffHunk: ghComment.diff_hunk,
      body: ghComment.body,
      inReplyToId: ghComment.in_reply_to_id ?? null,
    };

    // Clear any existing queue entry and reset state
    const sqlite = getRawSqlite();
    sqlite.prepare("DELETE FROM eval_queue WHERE comment_key = ?").run(`${body.repo}:${body.commentId}`);

    // Remove evalFailed flag and reset status so needsEvaluation returns true
    const key = `${body.repo}:${body.commentId}`;
    if (state.comments[key]) {
      delete state.comments[key].evalFailed;
      // Reset to pending so enqueueEvaluation's needsEvaluation check passes
      if (state.comments[key].status === "evaluating") {
        state.comments[key].status = "pending";
      }
      // Clear old evaluation so needsEvaluation returns true
      delete state.comments[key].evaluation;
    }

    const result = enqueueEvaluation(comment, body.prNumber, body.repo, state);
    saveState(state);
    if (result === "queued") void drainOnce();
    json(res, { success: true, status: result });
  });

  // POST /api/actions/comment-triage — local snooze / priority / note (SQLite only)
  addRoute("POST", "/api/actions/comment-triage", async (req, res) => {
    const body = getBody<{
      repo: string;
      commentId: number;
      prNumber: number;
      snoozeUntil?: string | null;
      priority?: number | null;
      triageNote?: string | null;
    }>(req);
    const state = loadState();
    patchCommentTriage(state, body.commentId, body.repo, body.prNumber, {
      ...(body.snoozeUntil !== undefined ? { snoozeUntil: body.snoozeUntil } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.triageNote !== undefined ? { triageNote: body.triageNote } : {}),
    });
    saveState(state);
    json(res, { success: true });
  });

  // POST /api/actions/fix — create worktree, run Claude, return diff
  addRoute("POST", "/api/actions/fix", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number; branch: string; comment: { path: string; line: number; body: string; diffHunk: string }; userInstructions?: string }>(req);

    // Prevent concurrent fixes on the same branch or PR
    const activeBranch = getActiveFixForBranch(body.branch);
    if (activeBranch) {
      json(res, { error: `A fix is already running on branch ${body.branch} (${activeBranch.path})` }, 409);
      return;
    }
    const activePR = getActiveFixForPR(body.repo, body.prNumber);
    if (activePR) {
      json(res, { error: `A fix is already running on this PR (${activePR.path})` }, 409);
      return;
    }
    const state = loadState();
    const persistedJob = getFixJobs(state).find((j) => j.branch === body.branch);
    if (persistedJob) {
      json(res, { error: `A fix is already in progress on branch ${body.branch} (${persistedJob.path})` }, 409);
      return;
    }

    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) {
      json(res, { error: "Repo local path not found" }, 400);
      return;
    }

    let worktreePath: string;
    try {
      worktreePath = createWorktree(body.branch, repoInfo.localPath);
    } catch (err) {
      json(res, { error: `Failed to create worktree: ${(err as Error).message}` }, 500);
      return;
    }

    // Persist job to disk and track in memory
    const jobRecord = {
      commentId: body.commentId,
      repo: body.repo,
      prNumber: body.prNumber,
      branch: body.branch,
      path: body.comment.path,
      worktreePath,
      startedAt: new Date().toISOString(),
    };
    addFixJobState(state, jobRecord);
    saveState(state);

    setFixJobStatus({
      commentId: body.commentId,
      repo: body.repo,
      prNumber: body.prNumber,
      path: body.comment.path,
      startedAt: Date.now(),
      status: "running",
    });

    // Respond immediately — the fix runs async, frontend polls for status
    json(res, { success: true, status: "running", branch: body.branch });

    // Run Claude in background
    try {
      const claudeOutput = await applyFixWithClaude(worktreePath, body.comment, body.userInstructions);
      const diff = getDiffInWorktree(worktreePath);

      if (!diff.trim()) {
        removeWorktree(body.branch, repoInfo?.localPath);
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
          path: body.comment.path, startedAt: Date.now(), status: "failed",
          error: "Claude made no changes",
          claudeOutput,
        });
        return;
      }

      // Mark completed with diff — keep worktree for apply/discard
      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        path: body.comment.path, startedAt: Date.now(), status: "completed",
        diff, branch: body.branch, claudeOutput,
      });
    } catch (err) {
      removeWorktree(body.branch, repoInfo?.localPath);
      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        path: body.comment.path, startedAt: Date.now(), status: "failed",
        error: (err as Error).message,
      });
    }
  });

  // POST /api/actions/fix-apply — commit and push worktree changes
  addRoute("POST", "/api/actions/fix-apply", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number; branch: string }>(req);
    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) {
      json(res, { error: "Repo local path not found" }, 400);
      return;
    }

    try {
      const worktreePath = getWorktreePath(body.branch, repoInfo.localPath);
      const commitMsg = `fix: apply CodeRabbit suggestion for PR #${body.prNumber}`;
      commitAndPushWorktree(worktreePath, commitMsg, body.branch);
      removeWorktree(body.branch, repoInfo?.localPath);

      const state = loadState();
      markComment(state, body.commentId, "fixed", body.prNumber, body.repo);
      saveState(state);
      clearFixJobStatus(body.commentId);

      json(res, { success: true, status: "fixed" });
    } catch (err) {
      json(res, { error: `Push failed: ${(err as Error).message}` }, 500);
    }
  });

  // POST /api/actions/fix-discard — discard worktree
  addRoute("POST", "/api/actions/fix-discard", async (req, res) => {
    const body = getBody<{ branch: string; repo?: string; commentId?: number }>(req);
    const discardRepoInfo = body.repo ? getRepos().find((r) => r.repo === body.repo) : undefined;
    try {
      removeWorktree(body.branch, discardRepoInfo?.localPath);
    } catch { /* ignore */ }
    if (body.commentId) clearFixJobStatus(body.commentId);
    json(res, { success: true });
  });

  // GET /api/fix-jobs/recover — check for stale fix jobs from a previous session
  addRoute("GET", "/api/fix-jobs/recover", (_req, res) => {
    const state = loadState();
    const staleJobs = getFixJobs(state);
    const results: Array<{ job: typeof staleJobs[0]; hasDiff: boolean; diff?: string }> = [];

    for (const job of staleJobs) {
      try {
        const diff = getDiffInWorktree(job.worktreePath);
        results.push({ job, hasDiff: !!diff.trim(), diff: diff.trim() || undefined });
      } catch {
        // Worktree no longer exists — clean up
        removeFixJobState(state, job.commentId);
      }
    }

    saveState(state);
    json(res, results);
  });

  // POST /api/actions/review — submit a PR review (approve or request changes)
  addRoute("POST", "/api/actions/review", async (req, res) => {
    const parsed = getBody<{ repo: string; prNumber: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }>(req);
    try {
      const reviewText = typeof parsed.body === "string" ? parsed.body.trim() : "";
      if (parsed.event !== "APPROVE" && reviewText.length === 0) {
        json(res, { error: "Review comment body is required for this action." }, 400);
        return;
      }
      // Omit `body` when empty for APPROVE — GitHub rejects blank `body` on create-review.
      const payload: Record<string, unknown> = { event: parsed.event };
      if (reviewText.length > 0) {
        payload.body = reviewText;
      }
      await ghPost(`/repos/${parsed.repo}/pulls/${parsed.prNumber}/reviews`, payload);
      json(res, { success: true });
    } catch (err) {
      json(res, { error: `Review failed: ${(err as Error).message}` }, 500);
    }
  });

  // POST /api/actions/comment — create a review comment on a specific line
  addRoute("POST", "/api/actions/comment", async (req, res) => {
    const body = getBody<{
      repo: string;
      prNumber: number;
      commitId: string;
      path: string;
      line: number;
      side: "LEFT" | "RIGHT";
      body: string;
    }>(req);
    try {
      await ghPost(`/repos/${body.repo}/pulls/${body.prNumber}/comments`, {
        body: body.body,
        commit_id: body.commitId,
        path: body.path,
        line: body.line,
        side: body.side,
      });
      json(res, { success: true });
    } catch (err) {
      json(res, { error: `Comment failed: ${(err as Error).message}` }, 500);
    }
  });
}
