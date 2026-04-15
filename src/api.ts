import { addRoute, json, getRepos, getBody, getPollState, getHealthPayload, setFixJobStatus, clearFixJobStatus, getActiveFixForBranch, subscribeSse, getListenPort, notifyConfigSaved, getFixJobStatus, getAllFixJobStatuses, getTicketState, triggerManualPoll } from "./server.js";
import { enqueueFix, isInFixQueue, advanceQueue, getFixQueue, removeFromFixQueue } from "./fix-queue.js";
import { getVapidKeys } from "./vapid.js";
import { savePushSubscription, deletePushSubscription, mutePR as dbMutePR, unmutePR as dbUnmutePR, getMutedPRs as dbGetMutedPRs } from "./push-db.js";
import { sendTestPush } from "./push.js";
import type { RepoInfo } from "./discovery.js";
import { loadConfig, saveConfig, configExists, type Config } from "./config.js";
import { loadState, markComment, patchCommentTriage, saveState, addFixJob as addFixJobState, removeFixJob as removeFixJobState, getFixJobs, getPendingTriageCountsByPr, needsEvaluation, reconcileResolvedComments } from "./state.js";
import { postReply, resolveThread, applyFixWithClaude, clampEvalConcurrency } from "./actioner.js";
import { createWorktree, getWorktreePath, getDiffInWorktree, removeWorktree, commitAndPushWorktree } from "./worktree.js";
import { ghAsync, ghAsyncSinglePage, ghPost, getGitHubViewerCached } from "./exec.js";
import {
  batchPullPollData,
  batchPullPollDataForRepos,
  fetchOpenPullRequestsForRepos,
  type OpenPull,
  type PullPollData,
} from "./github-batching.js";
import { reduceCiToTriState, type CiChecksSummary } from "./ci-state.js";
import { clearRepoPollSchedule } from "./repo-poll-schedule.js";
import { enqueueEvaluation, drainOnce } from "./eval-queue.js";
import { buildIgnoredBotSet } from "./poller.js";
import { getRawSqlite } from "./db/client.js";
import type { LinkablePR } from "./tickets/linker.js";

async function getUsernameOrNull(): Promise<string | null> {
  const u = await getGitHubViewerCached();
  return u?.login ?? null;
}

interface GhPull {
  number: number;
  title: string;
  body?: string | null;
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
  merged_at?: string | null;
  state?: string;
}

interface GhCommitStatus {
  id: number;
  state: "success" | "failure" | "pending" | "error";
  context: string;
  description: string | null;
  target_url: string | null;
  created_at: string;
  updated_at: string;
}

interface GhCombinedStatus {
  state: "success" | "failure" | "pending" | "error";
  statuses: GhCommitStatus[];
}

/** Per `buildPullSidebarLists` invocation: dedupe concurrent status/check calls for the same commit. */
let prStatusDedupe: Map<string, Promise<"success" | "failure" | "pending">> | null = null;

function getPrStatusDeduped(repoPath: string, sha: string): Promise<"success" | "failure" | "pending"> {
  const key = `${repoPath}\0${sha}`;
  const map = prStatusDedupe;
  if (!map) return getPrStatus(repoPath, sha);
  const hit = map.get(key);
  if (hit) return hit;
  const p = getPrStatus(repoPath, sha);
  map.set(key, p);
  return p;
}

async function getPrStatus(repoPath: string, sha: string): Promise<"success" | "failure" | "pending"> {
  try {
    const [statusData, checksSummary] = await Promise.all([
      ghAsync<GhCombinedStatus>(`/repos/${repoPath}/commits/${sha}/status`).catch(() => null),
      getChecksSummaryFromRuns(repoPath, sha),
    ]);
    return reduceCiToTriState({
      status: statusData
        ? {
            state: statusData.state,
            hasStatuses: (statusData.statuses?.length ?? 0) > 0,
          }
        : null,
      checks: checksSummary,
    });
  } catch { /* ignore */ }
  return "pending";
}

/** Check runs only (no commit statuses) — used by getPrStatus to avoid double-counting */
async function getChecksSummaryFromRuns(repoPath: string, sha: string): Promise<{
  success: number; failure: number; pending: number;
} | null> {
  try {
    const data = await ghAsync<GhCheckRunsResponse>(
      `/repos/${repoPath}/commits/${sha}/check-runs?per_page=100`,
    );
    const runs = data.check_runs;
    if (runs.length === 0) return null;
    let success = 0, failure = 0, pending = 0;
    for (const r of runs) {
      if (r.status !== "completed") pending++;
      else if (r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral") success++;
      else failure++;
    }
    return { success, failure, pending } satisfies CiChecksSummary;
  } catch { return null; }
}

function openTopLevelUnresolvedCount(
  comments: Array<{ id: number; in_reply_to_id: number | null }>,
  resolvedIds: Set<number>,
): number {
  return comments.filter((c) => c.in_reply_to_id === null && !resolvedIds.has(c.id)).length;
}

/** One pass per repo: single list of open PRs, then authored + review-requested rows (halves REST vs two endpoints). */
export async function buildPullSidebarLists(targetRepos: RepoInfo[]): Promise<{
  authored: Array<Record<string, unknown>>;
  reviewRequested: Array<Record<string, unknown>>;
  /** True when GET /user failed and we have no cached login (sidebar lists are empty). */
  githubUserUnavailable?: boolean;
}> {
  const username = await getUsernameOrNull();
  if (username == null) {
    return { authored: [], reviewRequested: [], githubUserUnavailable: true };
  }
  const authored: Array<Record<string, unknown>> = [];
  const reviewRequested: Array<Record<string, unknown>> = [];
  prStatusDedupe = new Map();
  try {
    const repoPaths = targetRepos.map((r) => r.repo);
    let pullsByRepo = new Map<string, OpenPull[]>();
    try {
      pullsByRepo = (await fetchOpenPullRequestsForRepos(repoPaths)).pullsByRepo;
    } catch {
      // Fallback: preserve behavior if batched GraphQL fails.
      for (const repoInfo of targetRepos) {
        try {
          pullsByRepo.set(repoInfo.repo, await ghAsync<OpenPull[]>(`/repos/${repoInfo.repo}/pulls?state=open`));
        } catch {
          pullsByRepo.set(repoInfo.repo, []);
        }
      }
    }

    const selectedByRepo = new Map<string, { myPulls: OpenPull[]; needsReview: OpenPull[]; prNums: number[] }>();
    for (const repoInfo of targetRepos) {
      const pulls = pullsByRepo.get(repoInfo.repo) ?? [];
      const myPulls = pulls.filter((pr) => pr.user.login === username);
      const needsReview = pulls.filter(
        (pr) =>
          pr.user.login !== username &&
          pr.requested_reviewers.some((r) => r.login === username),
      );
      const prNums = [...new Set([...myPulls.map((p) => p.number), ...needsReview.map((p) => p.number)])];
      selectedByRepo.set(repoInfo.repo, { myPulls, needsReview, prNums });
    }

    let pollDataByRepo = new Map<string, Map<number, PullPollData>>();
    const pollEntries = Array.from(selectedByRepo.entries())
      .filter(([, v]) => v.prNums.length > 0)
      .map(([repoPath, v]) => ({ repoPath, prNumbers: v.prNums }));
    if (pollEntries.length > 0) {
      try {
        pollDataByRepo = await batchPullPollDataForRepos(pollEntries);
      } catch {
        for (const pe of pollEntries) {
          try {
            pollDataByRepo.set(pe.repoPath, await batchPullPollData(pe.repoPath, pe.prNumbers));
          } catch {
            pollDataByRepo.set(pe.repoPath, new Map());
          }
        }
      }
    }

    for (const repoMap of pollDataByRepo.values()) {
      for (const poll of repoMap.values()) {
        reconcileResolvedComments(poll.resolvedIds);
      }
    }

    const triageCounts = getPendingTriageCountsByPr();

    async function buildRow(
      repoPath: string,
      pr: OpenPull,
      poll: PullPollData | undefined,
    ): Promise<Record<string, unknown>> {
      const checksStatus = poll?.checksStatus
        ?? (pr.head.sha ? await getPrStatusDeduped(repoPath, pr.head.sha) : "pending");
      const openComments = poll
        ? openTopLevelUnresolvedCount(poll.comments, poll.resolvedIds)
        : 0;
      return {
        number: pr.number,
        title: pr.title,
        author: pr.user.login,
        authorAvatar: pr.user.avatar_url ?? "",
        branch: pr.head.ref,
        baseBranch: pr.base?.ref ?? "",
        url: pr.html_url,
        createdAt: pr.created_at ?? "",
        updatedAt: pr.updated_at ?? "",
        draft: pr.draft ?? false,
        repo: repoPath,
        checksStatus,
        openComments,
        pendingTriage: triageCounts.get(`${repoPath}:${pr.number}`) ?? 0,
        hasHumanApproval: poll?.hasHumanApproval ?? false,
      };
    }

    for (const repoInfo of targetRepos) {
      const selected = selectedByRepo.get(repoInfo.repo);
      if (!selected) continue;
      const pollByPr = pollDataByRepo.get(repoInfo.repo) ?? new Map();
      const authoredRows = await Promise.all(
        selected.myPulls.map((pr) => buildRow(repoInfo.repo, pr, pollByPr.get(pr.number))),
      );
      const reviewRows = await Promise.all(
        selected.needsReview.map((pr) => buildRow(repoInfo.repo, pr, pollByPr.get(pr.number))),
      );
      authored.push(...authoredRows);
      reviewRequested.push(...reviewRows);
    }

    return { authored, reviewRequested };
  } finally {
    prStatusDedupe = null;
  }
}

/** TTL for per-repo cached closed authored PRs (ticket linking); avoids N GitHub calls every poll. */
const CLOSED_AUTHORED_CACHE_TTL_MS = 15 * 60 * 1000;

function loadClosedAuthoredCache(repo: string): LinkablePR[] | null {
  try {
    const sqlite = getRawSqlite();
    const row = sqlite
      .prepare(
        "SELECT data_json, fetched_at_ms FROM repo_closed_authored_cache WHERE repo = ?",
      )
      .get(repo) as { data_json: string; fetched_at_ms: number } | undefined;
    if (!row || Date.now() - row.fetched_at_ms > CLOSED_AUTHORED_CACHE_TTL_MS) return null;
    return JSON.parse(row.data_json) as LinkablePR[];
  } catch {
    return null;
  }
}

function saveClosedAuthoredCache(repo: string, items: LinkablePR[]): void {
  try {
    getRawSqlite()
      .prepare(
        `INSERT INTO repo_closed_authored_cache (repo, data_json, fetched_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET data_json = excluded.data_json, fetched_at_ms = excluded.fetched_at_ms`,
      )
      .run(repo, JSON.stringify(items), Date.now());
  } catch {
    /* non-fatal */
  }
}

/**
 * Recently merged PRs authored by the viewer, for ticket-to-PR linking after open PRs drop off the sidebar.
 * One list request per repo (`state=closed`, newest first). Uses a single page only — does not walk every `Link: rel=next` page (that was burning quota on high-volume repos).
 */
export async function fetchMergedAuthoredLinkablePRs(
  targetRepos: RepoInfo[],
  perRepoLimit = 100,
): Promise<LinkablePR[]> {
  const username = await getUsernameOrNull();
  if (username == null) return [];

  const out: LinkablePR[] = [];
  for (const repoInfo of targetRepos) {
    try {
      const cached = loadClosedAuthoredCache(repoInfo.repo);
      if (cached) {
        out.push(...cached);
        continue;
      }
      const pulls = await ghAsyncSinglePage<GhPull[]>(
        `/repos/${repoInfo.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perRepoLimit}`,
        repoInfo.repo,
      );
      const repoItems: LinkablePR[] = [];
      for (const pr of pulls) {
        if (pr.user.login !== username) continue;
        if (!pr.merged_at) continue;
        repoItems.push({
          number: pr.number,
          repo: repoInfo.repo,
          branch: pr.head.ref,
          title: pr.title,
          body: pr.body ?? "",
          mergedAt: pr.merged_at ?? undefined,
        });
      }
      saveClosedAuthoredCache(repoInfo.repo, repoItems);
      out.push(...repoItems);
    } catch {
      /* skip repos that fail (e.g., no access) */
    }
  }
  return out;
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
    repoPollStaleAfterDays: c.repoPollStaleAfterDays ?? 3,
    repoPollColdIntervalMinutes: c.repoPollColdIntervalMinutes ?? 120,
    repoPollSuperColdMultiplier: c.repoPollSuperColdMultiplier ?? 3,
    pollApiHeadroom: c.pollApiHeadroom ?? 0.35,
    pollRateLimitAware: c.pollRateLimitAware !== false,
    preferredEditor: c.preferredEditor ?? "vscode",
    fixConversationMaxTurns: c.fixConversationMaxTurns ?? 5,
    hasLinearApiKey: Boolean(c.linearApiKey?.length),
    linearTeamKeys: c.linearTeamKeys ?? [],
    ticketProvider: c.ticketProvider ?? (c.linearApiKey ? "linear" : undefined),
    coherence: {
      branchStalenessDays: c.coherence?.branchStalenessDays ?? 3,
      approvedUnmergedHours: c.coherence?.approvedUnmergedHours ?? 24,
      reviewWaitHours: c.coherence?.reviewWaitHours ?? 24,
      ticketInactivityDays: c.coherence?.ticketInactivityDays ?? 5,
    },
    team: {
      enabled: c.team?.enabled === true,
      pollIntervalMinutes: c.team?.pollIntervalMinutes ?? 5,
    },
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
    repoPollStaleAfterDays = Math.max(0, toInt(body.repoPollStaleAfterDays, previous.repoPollStaleAfterDays ?? 3));
  }

  let repoPollColdIntervalMinutes: number | undefined;
  if (body.repoPollColdIntervalMinutes === undefined || body.repoPollColdIntervalMinutes === null || body.repoPollColdIntervalMinutes === "") {
    repoPollColdIntervalMinutes = previous.repoPollColdIntervalMinutes;
  } else {
    repoPollColdIntervalMinutes = Math.max(1, toInt(body.repoPollColdIntervalMinutes, previous.repoPollColdIntervalMinutes ?? 120));
  }

  let repoPollSuperColdMultiplier: number | undefined;
  if (body.repoPollSuperColdMultiplier === undefined || body.repoPollSuperColdMultiplier === null || body.repoPollSuperColdMultiplier === "") {
    repoPollSuperColdMultiplier = previous.repoPollSuperColdMultiplier ?? 3;
  } else {
    repoPollSuperColdMultiplier = Math.max(1, toInt(body.repoPollSuperColdMultiplier, previous.repoPollSuperColdMultiplier ?? 3));
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

  let linearApiKey: string | undefined = previous.linearApiKey;
  if (typeof body.linearApiKey === "string" && body.linearApiKey.length > 0) {
    linearApiKey = body.linearApiKey;
  }

  let linearTeamKeys: string[] | undefined = previous.linearTeamKeys;
  if (Array.isArray(body.linearTeamKeys)) {
    linearTeamKeys = body.linearTeamKeys.length > 0 ? body.linearTeamKeys : undefined;
  }

  const coherenceBody = (typeof body.coherence === "object" && body.coherence !== null)
    ? body.coherence as Record<string, unknown>
    : undefined;
  const previousCoherence = previous.coherence ?? {};
  const coherence = {
    branchStalenessDays: toInt(
      coherenceBody?.branchStalenessDays,
      previousCoherence.branchStalenessDays ?? 3,
    ),
    approvedUnmergedHours: toInt(
      coherenceBody?.approvedUnmergedHours,
      previousCoherence.approvedUnmergedHours ?? 24,
    ),
    reviewWaitHours: toInt(
      coherenceBody?.reviewWaitHours,
      previousCoherence.reviewWaitHours ?? 24,
    ),
    ticketInactivityDays: toInt(
      coherenceBody?.ticketInactivityDays,
      previousCoherence.ticketInactivityDays ?? 5,
    ),
  };

  const teamBody =
    typeof body.team === "object" && body.team !== null ? (body.team as Record<string, unknown>) : undefined;
  const previousTeam = previous.team ?? {};
  const team = {
    enabled:
      typeof teamBody?.enabled === "boolean" ? teamBody.enabled : (previousTeam.enabled === true),
    pollIntervalMinutes: Math.max(
      1,
      toInt(teamBody?.pollIntervalMinutes, previousTeam.pollIntervalMinutes ?? 5),
    ),
  };

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
    repoPollSuperColdMultiplier,
    pollApiHeadroom,
    pollRateLimitAware,
    preferredEditor,
    fixConversationMaxTurns,
    linearApiKey,
    linearTeamKeys,
    coherence,
    team,
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
    const [runsData, statusData] = await Promise.all([
      ghAsync<GhCheckRunsResponse>(
        `/repos/${repoPath}/commits/${sha}/check-runs?per_page=100`,
      ),
      ghAsync<GhCombinedStatus>(`/repos/${repoPath}/commits/${sha}/status`).catch(() => null),
    ]);
    const runs = runsData.check_runs;
    const statuses = statusData?.statuses ?? [];
    if (runs.length === 0 && statuses.length === 0) return null;

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
    // Deduplicate commit statuses: keep latest per context
    const latestByContext = new Map<string, GhCommitStatus>();
    for (const s of statuses) {
      const existing = latestByContext.get(s.context);
      if (!existing || s.id > existing.id) {
        latestByContext.set(s.context, s);
      }
    }
    for (const s of latestByContext.values()) {
      if (s.state === "success") success++;
      else if (s.state === "failure" || s.state === "error") failure++;
      else pending++;
    }
    return { total: runs.length + latestByContext.size, success, failure, pending };
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
    const user = await getGitHubViewerCached();
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

    // Fetch suites, runs, and commit statuses in parallel
    const [suitesData, runsData, statusData] = await Promise.all([
      ghAsync<GhCheckSuitesResponse>(`/repos/${repo}/commits/${sha}/check-suites?per_page=100`),
      ghAsync<GhCheckRunsFullResponse>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
      ghAsync<GhCombinedStatus>(`/repos/${repo}/commits/${sha}/status`).catch(() => null),
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

    // Include commit statuses (older GitHub CI API) as a synthetic suite
    if (statusData?.statuses?.length) {
      const latestByContext = new Map<string, GhCommitStatus>();
      for (const s of statusData.statuses) {
        const existing = latestByContext.get(s.context);
        if (!existing || s.id > existing.id) {
          latestByContext.set(s.context, s);
        }
      }
      const statusRuns = Array.from(latestByContext.values());
      const hasFailure = statusRuns.some((s) => s.state === "failure" || s.state === "error");
      const hasPending = statusRuns.some((s) => s.state === "pending");
      const statusConclusion = hasFailure ? "failure" : hasPending ? null : "success";

      function statusSortOrder(s: GhCommitStatus): number {
        if (s.state === "failure" || s.state === "error") return 0;
        if (s.state === "pending") return 1;
        return 2;
      }

      statusRuns.sort((a, b) => statusSortOrder(a) - statusSortOrder(b));
      suites.push({
        id: -1,
        name: "Commit Statuses",
        conclusion: statusConclusion,
        runs: statusRuns.map((s) => ({
          id: s.id,
          name: s.context,
          status: s.state === "pending" ? ("in_progress" as const) : ("completed" as const),
          conclusion: s.state === "pending" ? null : s.state === "error" ? "failure" : s.state,
          startedAt: s.created_at,
          completedAt: s.state !== "pending" ? s.updated_at : null,
          durationMs: null,
          htmlUrl: s.target_url ?? "",
          annotations: [],
        })),
      });
    }

    // Sort suites: those with failures first, then pending
    suites.sort((a, b) => {
      const order = (c: string | null) => c === "failure" ? 0 : c === null ? 1 : 2;
      return order(a.conclusion) - order(b.conclusion);
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
    const autoEvaluateParam = query.get("autoEvaluate");
    const autoEvaluate =
      autoEvaluateParam !== "0" &&
      autoEvaluateParam !== "false" &&
      autoEvaluateParam !== "off";

    const pollByPr = await batchPullPollData(repo, [prNumber]);
    const poll = pollByPr.get(prNumber);
    const comments = poll?.comments ?? [];
    const resolvedIds = poll?.resolvedIds ?? new Set<number>();

    const state = loadState();
    const config = loadConfig();
    const ignoredBots = buildIgnoredBotSet(config.ignoredBots);

    if (autoEvaluate) {
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
    }

    json(res, comments.map((c) => {
      const stateKey = `${repo}:${c.id}`;
      const record = state.comments[stateKey];
      return {
        id: c.id,
        htmlUrl: c.html_url ?? "",
        author: c.user.login,
        authorAvatar: c.user.avatar_url ?? "",
        isBot: c.user.type === "Bot" || c.user.login.endsWith("[bot]"),
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

  // POST /api/actions/poll-now — same as CLI hotkey [r] (GitHub + tickets + coherence); unavailable in demo mode
  addRoute("POST", "/api/actions/poll-now", async (_req, res) => {
    if (!triggerManualPoll()) {
      json(res, { ok: false, error: "Poll control not available" }, 503);
      return;
    }
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

    // 1. Already queued?
    if (isInFixQueue(body.commentId)) {
      json(res, { error: "already queued" }, 409);
      return;
    }

    // 2. Already active (running/completed/awaiting_response)?
    const existingStatus = getFixJobStatus(body.commentId);
    if (existingStatus && (existingStatus.status === "running" || existingStatus.status === "completed" || existingStatus.status === "awaiting_response")) {
      json(res, { error: "already active" }, 409);
      return;
    }

    // 3. Branch conflict with a different comment?
    const activeBranch = getActiveFixForBranch(body.branch);
    if (activeBranch && activeBranch.commentId !== body.commentId) {
      json(res, { error: `A fix is already running on branch ${body.branch} (${activeBranch.path})` }, 409);
      return;
    }

    // 4. Another fix is running or completed — enqueue instead of starting
    const allStatuses = getAllFixJobStatuses();
    if (allStatuses.some((j) => j.status === "running" || j.status === "completed")) {
      const item = enqueueFix({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        branch: body.branch, comment: body.comment, userInstructions: body.userInstructions,
      });
      json(res, { success: true, status: "queued", position: item.position });
      return;
    }

    const state = loadState();
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
    const sessionId = crypto.randomUUID();
    try {
      const result = await applyFixWithClaude(worktreePath, body.comment, body.userInstructions, { sessionId });

      if (result.action === "questions") {
        // Claude is asking questions — park the job
        const conversation: Array<{ role: "claude" | "user"; message: string }> = [
          { role: "claude", message: result.message },
        ];
        // Keep worktree alive, persist session info
        const s = loadState();
        const existingJob = getFixJobs(s).find((j) => j.commentId === body.commentId);
        if (existingJob) {
          existingJob.sessionId = sessionId;
          existingJob.conversation = conversation;
          saveState(s);
        }
        setFixJobStatus({
          commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
          path: body.comment.path, startedAt: Date.now(), status: "awaiting_response",
          branch: body.branch, claudeOutput: result.rawOutput,
          sessionId, conversation,
        });
        advanceQueue();
        return;
      }

      // action === "fix" — check for diff as before
      const diff = getDiffInWorktree(worktreePath);

      if (!diff.trim()) {
        removeWorktree(body.branch, repoInfo?.localPath);
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
          path: body.comment.path, startedAt: Date.now(), status: "no_changes",
          suggestedReply: result.message,
          claudeOutput: result.message,
        });
        advanceQueue();
        return;
      }

      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        path: body.comment.path, startedAt: Date.now(), status: "completed",
        diff, branch: body.branch, claudeOutput: result.message,
        conversation: [{ role: "claude", message: result.message }],
      });
      // completed blocks queue — don't advance
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
      advanceQueue();
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
      advanceQueue();

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
    advanceQueue();
    json(res, { success: true });
  });

  // POST /api/actions/fix-reply-and-resolve — post suggested reply and resolve the thread
  addRoute("POST", "/api/actions/fix-reply-and-resolve", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number; replyBody: string }>(req);

    try {
      await postReply(body.repo, body.prNumber, body.commentId, body.replyBody);
      await resolveThread(body.repo, body.commentId, body.prNumber, undefined);
    } catch (err) {
      json(res, { error: `Reply failed: ${(err as Error).message}` }, 500);
      return;
    }

    const state = loadState();
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    clearFixJobStatus(body.commentId);
    advanceQueue();

    json(res, { success: true });
  });

  // POST /api/actions/fix-reply — respond to Claude's questions and resume the fix session
  addRoute("POST", "/api/actions/fix-reply", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; message: string }>(req);

    // Find the job — must be awaiting_response
    const job = getFixJobStatus(body.commentId);
    if (!job || job.status !== "awaiting_response") {
      json(res, { error: "No fix job awaiting response for this comment" }, 400);
      return;
    }
    if (!job.sessionId || !job.branch) {
      json(res, { error: "Fix job missing session or branch info" }, 400);
      return;
    }

    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) {
      json(res, { error: "Repo local path not found" }, 400);
      return;
    }

    // Append user message to conversation
    const conversation = [...(job.conversation ?? []), { role: "user" as const, message: body.message }];

    // Check turn limit
    const config = loadConfig();
    const maxTurns = config.fixConversationMaxTurns ?? 5;
    const claudeTurnCount = conversation.filter((m) => m.role === "claude").length;
    const isLastTurn = maxTurns > 0 && claudeTurnCount >= maxTurns - 1;

    // Set status to running
    setFixJobStatus({ ...job, status: "running", conversation });

    // Respond immediately
    json(res, { success: true, status: "running" });

    // Resume Claude session in background
    const worktreePath = getWorktreePath(job.branch, repoInfo.localPath);
    try {
      const result = await applyFixWithClaude(
        worktreePath,
        { path: job.path, line: 0, body: "", diffHunk: "" }, // not used for resume
        body.message, // passed as userInstructions, used as the prompt for resume
        { resumeSessionId: job.sessionId, isLastTurn },
      );

      const updatedConversation = [...conversation, { role: "claude" as const, message: result.message }];

      if (result.action === "questions" && !isLastTurn) {
        // More questions — update job
        const s = loadState();
        const persistedJob = getFixJobs(s).find((j) => j.commentId === body.commentId);
        if (persistedJob) {
          persistedJob.conversation = updatedConversation;
          saveState(s);
        }
        setFixJobStatus({
          ...job, status: "awaiting_response",
          conversation: updatedConversation,
          claudeOutput: result.rawOutput,
        });
        advanceQueue();
        return;
      }

      // Claude answered "fix" or hit turn limit — check for diff
      const diff = getDiffInWorktree(worktreePath);

      if (!diff.trim()) {
        removeWorktree(job.branch, repoInfo.localPath);
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          ...job, status: "failed",
          error: isLastTurn && result.action === "questions"
            ? "Claude could not complete the fix within the turn limit"
            : "Claude made no changes",
          conversation: updatedConversation,
          claudeOutput: result.rawOutput,
        });
        advanceQueue();
        return;
      }

      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        ...job, status: "completed",
        diff, conversation: updatedConversation,
        claudeOutput: result.rawOutput,
      });
      // completed blocks queue — don't advance
    } catch (err) {
      removeWorktree(job.branch, repoInfo.localPath);
      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        ...job, status: "failed",
        error: (err as Error).message,
        conversation,
      });
      advanceQueue();
    }
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

  // GET /api/fix-queue — list queued fixes
  addRoute("GET", "/api/fix-queue", (_req, res) => {
    const queue = getFixQueue();
    json(res, queue.map((q) => ({
      commentId: q.commentId, repo: q.repo, prNumber: q.prNumber,
      path: q.path, branch: q.branch, position: q.position, queuedAt: q.queuedAt,
    })));
  });

  // DELETE /api/fix-queue/:commentId — remove an item from the queue
  addRoute("DELETE", "/api/fix-queue/:commentId", (_req, res, params) => {
    const commentId = Number(params.commentId);
    if (!Number.isFinite(commentId)) {
      json(res, { error: "Invalid commentId" }, 400);
      return;
    }
    const removed = removeFromFixQueue(commentId);
    if (!removed) {
      json(res, { error: "Item not found in queue" }, 404);
      return;
    }
    json(res, { success: true });
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

  // ── Push notification endpoints ──

  addRoute("GET", "/api/push/vapid-public-key", (_req, res) => {
    const keys = getVapidKeys();
    json(res, { publicKey: keys.publicKey });
  });

  addRoute("POST", "/api/push/subscribe", async (req, res) => {
    const body = await getBody(req) as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      res.writeHead(400);
      json(res, { error: "Missing endpoint or keys" });
      return;
    }
    savePushSubscription({
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    });
    json(res, { ok: true });
  });

  addRoute("DELETE", "/api/push/unsubscribe", async (req, res) => {
    const body = await getBody(req) as { endpoint?: string };
    if (!body.endpoint) {
      res.writeHead(400);
      json(res, { error: "Missing endpoint" });
      return;
    }
    deletePushSubscription(body.endpoint);
    json(res, { ok: true });
  });

  addRoute("POST", "/api/push/mute", async (req, res) => {
    const body = await getBody(req) as { repo?: string; number?: number };
    if (!body.repo || typeof body.number !== "number") {
      res.writeHead(400);
      json(res, { error: "Missing repo or number" });
      return;
    }
    dbMutePR(body.repo, body.number);
    json(res, { ok: true });
  });

  addRoute("DELETE", "/api/push/mute", async (req, res) => {
    const body = await getBody(req) as { repo?: string; number?: number };
    if (!body.repo || typeof body.number !== "number") {
      res.writeHead(400);
      json(res, { error: "Missing repo or number" });
      return;
    }
    dbUnmutePR(body.repo, body.number);
    json(res, { ok: true });
  });

  addRoute("GET", "/api/push/muted", (_req, res) => {
    json(res, { muted: dbGetMutedPRs() });
  });

  addRoute("POST", "/api/push/test", (_req, res) => {
    sendTestPush();
    json(res, { ok: true });
  });

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
    const enriched = repoLinkedIssues.map((issue) => ({
      ...issue,
      linkedPRs: linkMap.ticketToPRs.get(issue.identifier) ?? [],
    }));
    json(res, enriched);
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

  // ── Team overview (cached snapshot) ──

  addRoute("GET", "/api/team/overview", async (_req, res) => {
    const c = loadConfig();
    if (!c.team?.enabled) {
      json(res, { error: "Team features disabled" }, 404);
      return;
    }
    const { readTeamOverviewCache } = await import("./team/overview.js");
    const row = readTeamOverviewCache();
    if (!row) {
      json(res, {
        snapshot: null,
        updatedAtMs: null,
        refreshError: null,
        stale: true,
      });
      return;
    }
    json(res, {
      snapshot: row.snapshot,
      updatedAtMs: row.updatedAtMs,
      refreshError: row.refreshError,
      stale: false,
    });
  });

  addRoute("POST", "/api/team/overview/refresh", async (_req, res) => {
    const c = loadConfig();
    if (!c.team?.enabled) {
      json(res, { error: "Team features disabled" }, 404);
      return;
    }
    const { rebuildTeamOverviewSnapshot, writeTeamOverviewCache } = await import("./team/overview.js");
    try {
      const { snapshot, error } = await rebuildTeamOverviewSnapshot();
      writeTeamOverviewCache(snapshot, error);
      json(res, { ok: true, snapshot, error });
    } catch (e) {
      const msg = (e as Error).message;
      json(res, { ok: false, error: msg }, 500);
    }
  });

  // ── Attention feed ──

  addRoute("GET", "/api/attention", async (_req, res, _params, query) => {
    const { getAttentionItems } = await import("./attention.js");
    const includeAll = query.get("all") === "true";
    const items = getAttentionItems({ includeAll });
    json(res, items);
  });

  addRoute("POST", "/api/attention/:id/snooze", async (req, res, params) => {
    const { until } = getBody<{ until: string }>(req);
    const { snoozeItem } = await import("./attention.js");
    snoozeItem(decodeURIComponent(params.id), until);
    json(res, { ok: true });
  });

  addRoute("POST", "/api/attention/:id/dismiss", async (_req, res, params) => {
    const { dismissItem } = await import("./attention.js");
    dismissItem(decodeURIComponent(params.id));
    json(res, { ok: true });
  });

  addRoute("POST", "/api/attention/:id/pin", async (_req, res, params) => {
    const { pinItem } = await import("./attention.js");
    pinItem(decodeURIComponent(params.id));
    json(res, { ok: true });
  });
}
