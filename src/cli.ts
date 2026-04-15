#!/usr/bin/env node
import { parseArgs } from "util";
import { execSync, execFileSync } from "child_process";
import { loadState, saveState, needsEvaluation, getCommentsByStatus, compactCommentHistory, reconcileResolvedComments } from "./state.js";
import { fetchNewComments, fetchNewCommentsBatch, getGitHubLogin } from "./poller.js";
import { clampEvalConcurrency, killAllChildren } from "./actioner.js";
import { enqueueMany, recoverQueue, startWorker, stopWorker } from "./eval-queue.js";
import { loadFixQueue, advanceQueue as advanceFixQueue } from "./fix-queue.js";
import { cleanupAllWorktrees, pruneOrphanedWorktrees } from "./worktree.js";
import {
  setTokenResolver,
  resolveGitHubTokenFromSources,
  hasEnvGitHubToken,
  getRateLimitState,
  getGitHubRequestStatsSnapshot,
} from "./exec.js";
import {
  enableRawMode,
  registerHotkeys,
  setNextPollTime,
  clearCountdown,
  setStatus,
  setProcessing,
  cleanup as cleanupTerminal,
} from "./terminal.js";
import {
  startServer,
  updateRepos,
  updatePollState,
  sseBroadcast,
  setConfigSavedHandler,
  setManualPollHandler,
  loadPersistedFixJobResults,
  updateTicketState,
  getTicketState,
} from "./server.js";
import { getTicketProvider, clearTicketProviderCache } from "./tickets/index.js";
import {
  extractTicketIdentifiers,
  buildLinkMap,
  mergeProviderPullLinksIntoLinkMap,
  type LinkablePR,
} from "./tickets/linker.js";
import { initPush, processPolledData, startReviewReminder, sendTestPush } from "./push.js";
import { buildPullSidebarLists, fetchMergedAuthoredLinkablePRs } from "./api.js";
import { evaluateCoherence, type CoherenceInput, type CoherencePR } from "./coherence.js";
import { refreshAttentionFeed, shouldLogAttentionPipeline } from "./attention.js";
import { discoverRepos, type RepoInfo } from "./discovery.js";
import { filterRepoPathsWithPushAccess, loadCachedPushAccess } from "./github-batching.js";
import { loadConfig, saveConfig, configExists, isTeamFeaturesEnabled, type Config } from "./config.js";
import { computeEffectivePollIntervalMs, estimatePollRequestCount } from "./poll-rate-budget.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import { recordPollOutcomes, selectReposToPoll } from "./repo-poll-schedule.js";

const LINEAR_RATE_LIMIT_BACKOFF_MS = 10 * 60_000;
let linearRateLimitBackoffUntilMs = 0;
let lastTeamOverviewRefreshMs = 0;

function isLinearRateLimitError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message?.toLowerCase() ?? "";
  return msg.includes("rate limit exceeded") && msg.includes("linear");
}

const { values: flags } = parseArgs({
  options: {
    interval: { type: "string" },
    repo: { type: "string" },
    root: { type: "string" },
    cleanup: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    port: { type: "string" },
    config: { type: "boolean", default: false },
    open: { type: "boolean", default: false },
    demo: { type: "boolean", default: false },
    "eval-concurrency": { type: "string" },
    "poll-review-requested": { type: "boolean" },
    "comment-retention-days": { type: "string" },
  },
});

function printStatus(): void {
  const state = loadState();
  const pending = getCommentsByStatus(state, "pending");
  const replied = getCommentsByStatus(state, "replied");
  const fixed = getCommentsByStatus(state, "fixed");
  const dismissed = getCommentsByStatus(state, "dismissed");

  console.log("\ncode-triage status:");
  console.log(`  Last poll: ${state.lastPoll || "never"}`);
  console.log(`  Comments: ${Object.keys(state.comments).length} total`);
  console.log(`    Pending:   ${pending.length}`);
  console.log(`    Replied:   ${replied.length}`);
  console.log(`    Fixed:     ${fixed.length}`);
  console.log(`    Dismissed: ${dismissed.length}`);
  console.log("");
}

if (flags.cleanup) {
  cleanupAllWorktrees();
  process.exit(0);
}

if (flags.status) {
  printStatus();
  process.exit(0);
}

// Demo mode — skip all checks, serve dummy data
if (flags.demo) {
  const demoPort = flags.port ? parseInt(flags.port, 10) : 3100;
  const { startDemoServer } = await import("./demo.js");
  startDemoServer(demoPort);
  console.log(`\nCode Triage demo running at http://localhost:${demoPort}\n`);
  if (flags.open) {
    try { execSync(`open "http://localhost:${demoPort}"`, { stdio: "pipe" }); } catch { /* ignore */ }
  }
  // Keep process alive
  await new Promise(() => {});
}

// Check required CLI tools (avoid Unix `which` — it is not available in Windows cmd.exe)
function checkDependency(cmd: string, helpUrl: string): void {
  try {
    execFileSync(cmd, ["--version"], { stdio: "pipe" });
  } catch {
    console.error(`\n  Error: '${cmd}' is not installed or not in PATH.`);
    console.error(`  Install it from: ${helpUrl}\n`);
    process.exit(1);
  }
}

checkDependency("claude", "https://docs.anthropic.com/en/docs/claude-code");

let config = loadConfig();

function hasConfigGitHubCredential(c: Config): boolean {
  return Boolean(c.githubToken?.trim());
}

// Prefer env or config PAT; otherwise require `gh auth login`.
if (!hasEnvGitHubToken() && !hasConfigGitHubCredential(config)) {
  checkDependency("gh", "https://cli.github.com");
  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch {
    console.error("\n  Error: No GitHub token configured.");
    console.error("  Set GITHUB_TOKEN or GH_TOKEN, add a token in Settings, or run: gh auth login\n");
    process.exit(1);
  }
}

// First-run setup or --config flag
async function runSetup(existing: Config): Promise<Config> {
  console.log("\n  Code Triage Setup\n");

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

  const rootAnswer = await ask(`  Repos directory [${existing.root}]: `);
  const root = rootAnswer || existing.root;

  const portAnswer = await ask(`  Web UI port [${existing.port}]: `);
  const port = portAnswer ? parseInt(portAnswer, 10) : existing.port;

  const intervalAnswer = await ask(`  Poll interval in minutes [${existing.interval}]: `);
  const interval = intervalAnswer ? parseInt(intervalAnswer, 10) : existing.interval;

  // Optional: additional GitHub accounts (for multi-org support)
  const accounts = existing.accounts ?? [];
  const addAccount = await ask(`  Add a GitHub account for a different org? (y/N): `);
  if (addAccount.toLowerCase() === "y") {
    const name = await ask(`    Account name (e.g. work): `);
    const token = await ask(`    Personal access token: `);
    const orgs = await ask(`    Orgs (comma-separated, e.g. my-org,another-org): `);
    accounts.push({ name, token, orgs: orgs.split(",").map((o) => o.trim()).filter(Boolean) });
    console.log(`    Account '${name}' added for orgs: ${orgs}`);
  }

  rl.close();

  const config: Config = {
    ...existing,
    root,
    port,
    interval,
    ...(accounts.length ? { accounts } : {}),
  };
  saveConfig(config);
  console.log("\n  Config saved to ~/.code-triage/config.json\n");
  return config;
}

// Interactive setup only when --config (first launch uses web settings instead)
if (flags.config) {
  config = await runSetup(config);
}

function installTokenResolverFromConfig(c: Config): void {
  let defaultToken: string | null = null;
  const getDefault = (): string => {
    if (!defaultToken) {
      defaultToken = resolveGitHubTokenFromSources(c.githubToken);
    }
    return defaultToken;
  };
  if (c.accounts?.length) {
    setTokenResolver((repo?: string) => {
      if (repo && c.accounts?.length) {
        const owner = repo.split("/")[0];
        const match = c.accounts.find((a) => a.orgs.includes(owner ?? ""));
        if (match) return match.token;
      }
      return getDefault();
    });
  } else {
    setTokenResolver(() => getDefault());
  }
}

installTokenResolverFromConfig(config);

function getRoot(): string {
  return flags.root || loadConfig().root;
}

/** Drops discovered repos where the GitHub token cannot push (avoids polling read-only / unrelated clones). */
async function filterReposToPushAccess(repoList: RepoInfo[]): Promise<RepoInfo[]> {
  if (repoList.length === 0) return repoList;
  const allowed = new Set(await filterRepoPathsWithPushAccess(repoList.map((r) => r.repo)));
  const skipped = repoList.length - allowed.size;
  if (skipped > 0) {
    console.log(`  Skipping ${skipped} repo(s) without push access (read-only or no access).`);
  }
  return repoList.filter((r) => allowed.has(r.repo));
}

// CLI flags override config
const port = flags.port ? parseInt(flags.port, 10) : config.port;
let baseIntervalMs = (flags.interval ? parseInt(flags.interval, 10) : config.interval) * 60 * 1000;
const dryRun = flags["dry-run"]!;
let evalConcurrency = clampEvalConcurrency(
  flags["eval-concurrency"] ? parseInt(flags["eval-concurrency"]!, 10) : (config.evalConcurrency ?? 2),
);
let pollReviewRequested =
  flags["poll-review-requested"] === true ? true : config.pollReviewRequested === true;
let commentRetentionDays =
  flags["comment-retention-days"] !== undefined
    ? parseInt(flags["comment-retention-days"]!, 10)
    : (config.commentRetentionDays ?? 0);

// Resolve repos: single repo mode or multi-repo discovery
let repos: RepoInfo[];
if (flags.repo) {
  repos = [{ repo: flags.repo, localPath: "" }];
} else if (!configExists()) {
  console.log("No config file — open the web UI to finish setup.");
  console.log(`  (Serving on http://localhost:${port}; repos will be discovered after you save settings.)\n`);
  repos = [];
} else {
  const root = getRoot();
  console.log(`Discovering repos in ${root}...`);
  repos = discoverRepos(root);
  if (repos.length === 0) {
    console.error("No GitHub repos found. Use --root to specify a different directory, or --config to reconfigure.");
    process.exit(1);
  }
}

// In dev mode, prefer cached push-access to avoid refetching on every hot reload; without cache, resolve once
// (same as production) so we do not poll read-only / inaccessible clones. Opt out: CODE_TRIAGE_DEV_POLL_ALL_REPOS=1.
const devStartup = process.env.NODE_ENV === "development" || process.env.npm_lifecycle_event === "dev";
if (!devStartup) {
  repos = await filterReposToPushAccess(repos);
} else {
  const cached = loadCachedPushAccess(repos.map((r) => r.repo));
  if (cached) {
    const allowed = new Set(cached);
    const skipped = repos.length - allowed.size;
    repos = repos.filter((r) => allowed.has(r.repo));
    if (skipped > 0) {
      console.log(`  Dev mode: filtered ${skipped} repo(s) without push access (cached).`);
    }
  } else if (process.env.CODE_TRIAGE_DEV_POLL_ALL_REPOS === "1") {
    console.log(
      `  Dev mode: CODE_TRIAGE_DEV_POLL_ALL_REPOS=1 — not filtering by push access (${repos.length} repo(s)).`,
    );
  } else {
    console.log(`  Dev mode: no push-access cache — resolving push access once (then cached).`);
    repos = await filterReposToPushAccess(repos);
  }
}
if (repos.length === 0 && (flags.repo || configExists())) {
  console.error(
    "No GitHub repositories with push access. Remove read-only clones from your repos directory, or use a token with write access.",
  );
  process.exit(1);
}

function openBrowser(): void {
  const devMode = process.env.NODE_ENV === "development" || process.env.npm_lifecycle_event === "dev";
  const url = devMode ? "http://localhost:5173" : `http://localhost:${port}`;
  try {
    execSync(`open "${url}"`, { stdio: "pipe" });
    console.log(`\n  Opened ${url} in browser.\n`);
  } catch {
    console.log(`\n  Open ${url} in your browser.\n`);
  }
}

// --open flag: just open browser and continue
if (flags.open) {
  openBrowser();
}

console.log(`code-triage started`);
console.log(`  Repos (push access): ${repos.length}`);
for (const r of repos) {
  console.log(`    ${r.repo}`);
}
console.log(`  Base poll interval: ${baseIntervalMs / 60000}m (may stretch when quota is tight)`);
console.log(`  Dry run: ${dryRun}`);
console.log(`  Eval concurrency: ${evalConcurrency}`);
console.log(`  Poll review-requested PRs: ${pollReviewRequested}`);
if (Number.isFinite(commentRetentionDays) && commentRetentionDays > 0) {
  console.log(`  Comment retention: ${commentRetentionDays} days (replied/dismissed/fixed)`);
}
const isDev = process.env.NODE_ENV === "development" || process.env.npm_lifecycle_event === "dev";
if (isDev) {
  console.log(`  WebUI (dev): http://localhost:5173`);
  console.log(`  API server:  http://localhost:${port}\n`);
} else {
  console.log(`  WebUI: http://localhost:${port}\n`);
}

startServer(port, repos);
loadPersistedFixJobResults();
loadFixQueue();
initPush();
const stopReviewReminder = startReviewReminder();

// Prune any orphaned worktrees from previous crashed sessions
{
  const state = loadState();
  const activeJobs = state.fixJobs ?? [];
  for (const r of repos) {
    if (r.localPath) pruneOrphanedWorktrees(r.localPath, activeJobs);
  }
}

recoverQueue();
startWorker();
advanceFixQueue();

let running = false;
let shuttingDown = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(reposPolledCount?: number): void {
  const n = reposPolledCount ?? repos.length;
  const headroom = config.pollApiHeadroom ?? 0.35;
  const rateAware = config.pollRateLimitAware !== false;
  let effectiveMs = baseIntervalMs;
  let est = estimatePollRequestCount(n);
  let note: string | null = null;
  if (rateAware && n > 0) {
    const r = computeEffectivePollIntervalMs(baseIntervalMs, n, getRateLimitState(), Date.now(), headroom);
    effectiveMs = r.intervalMs;
    est = r.estimatedRequestsPerPoll;
    note = r.budgetReason;
  }
  if (pollTimer) clearTimeout(pollTimer);
  setNextPollTime(effectiveMs);
  const nextPoll = Date.now() + effectiveMs;
  updatePollState({
    nextPoll,
    intervalMs: effectiveMs,
    baseIntervalMs,
    estimatedPollRequests: est,
    pollBudgetNote: note,
  });
  pollTimer = setTimeout(poll, effectiveMs);
}

async function applyConfigReload(): Promise<void> {
  config = loadConfig();
  clearTicketProviderCache();
  baseIntervalMs = config.interval * 60 * 1000;
  evalConcurrency = clampEvalConcurrency(config.evalConcurrency ?? 2);
  pollReviewRequested = config.pollReviewRequested === true;
  commentRetentionDays = config.commentRetentionDays ?? 0;
  installTokenResolverFromConfig(config);
  if (!flags.repo) {
    const rootPath = getRoot();
    console.log(`\n  Re-discovering repos under ${rootPath}...`);
    repos = discoverRepos(rootPath);
    repos = await filterReposToPushAccess(repos);
    console.log(`  Found ${repos.length} repo(s) with push access.`);
    for (const r of repos) {
      console.log(`    ${r.repo}`);
    }
    updateRepos(repos);
    const state = loadState();
    const activeJobs = state.fixJobs ?? [];
    for (const repoInfo of repos) {
      if (repoInfo.localPath) pruneOrphanedWorktrees(repoInfo.localPath, activeJobs);
    }
  }
  schedulePoll(repos.length);
}

setConfigSavedHandler(applyConfigReload);

async function poll(): Promise<void> {
  if (running || shuttingDown) return;

  // Hard block: skip poll when >=80% of GitHub API quota is consumed
  const rl = getRateLimitState();
  if (rl.remaining != null && rl.limit != null && rl.limit > 0) {
    const usagePercent = ((rl.limit - rl.remaining) / rl.limit) * 100;
    if (usagePercent >= 80) {
      const resetMs = rl.resetAt ? Math.max(rl.resetAt - Date.now(), 30_000) : 60_000;
      const resetMin = Math.ceil(resetMs / 60_000);
      const reason = `${rl.remaining}/${rl.limit} remaining (${Math.round(usagePercent)}% used). Resuming in ~${resetMin}m.`;
      console.log(`\n  Rate limit: ${reason} Pausing polls.`);
      setStatus(`Paused — ${reason}`);
      updatePollState({ polling: false, pollPaused: true, pollPausedReason: reason });
      if (pollTimer) clearTimeout(pollTimer);
      setNextPollTime(resetMs);
      pollTimer = setTimeout(poll, resetMs);
      return;
    }
  }

  running = true;
  setProcessing(true);
  updatePollState({ polling: true, pollPaused: false, pollPausedReason: null });

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  clearCountdown();

  let reposPolledCount = 0;
  const ghStatsStart = getGitHubRequestStatsSnapshot();
  try {
    const state = loadState();
    const allRepoPaths = repos.map((r) => r.repo);
    const staleDays = config.repoPollStaleAfterDays ?? 7;
    const useAdaptive = !flags.repo && staleDays > 0;
    const reposToPoll = useAdaptive
      ? selectReposToPoll(allRepoPaths, Date.now(), {
          staleAfterDays: staleDays,
          coldIntervalMinutes: config.repoPollColdIntervalMinutes ?? 60,
          superColdMultiplier: config.repoPollSuperColdMultiplier ?? 3,
        })
      : allRepoPaths;
    reposPolledCount = reposToPoll.length;
    if (useAdaptive && reposToPoll.length < allRepoPaths.length) {
      setStatus(`Polling ${reposToPoll.length} of ${allRepoPaths.length} repo(s) (adaptive)…`);
    } else {
      setStatus(`Polling ${reposToPoll.length} repo(s)...`);
    }

    const githubLogin = await getGitHubLogin();
    const pollOutcomes: Array<{ repo: string; hadActivity: boolean }> = [];
    try {
      const batch = await fetchNewCommentsBatch(
        reposToPoll,
        (repo, id) => needsEvaluation(state, id, repo),
        pollReviewRequested,
        githubLogin,
      );
      for (const repoInfo of repos) {
        if (!reposToPoll.includes(repoInfo.repo)) continue;
        try {
          const result = batch.get(repoInfo.repo) ?? {
            comments: [],
            resolvedIds: new Set<number>(),
          };
          reconcileResolvedComments(result.resolvedIds);
          const hadActivity = result.comments.length > 0;
          pollOutcomes.push({ repo: repoInfo.repo, hadActivity });

          if (result.comments.length > 0) {
            enqueueMany(result.comments, repoInfo.repo, state);
          }
        } catch (err) {
          console.error(`\n  Error processing ${repoInfo.repo}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`\n  Batch poll failed: ${(err as Error).message}`);
      for (const repoInfo of repos) {
        if (!reposToPoll.includes(repoInfo.repo)) continue;
        try {
          const result = await fetchNewComments(
            repoInfo.repo,
            (id) => needsEvaluation(state, id, repoInfo.repo),
            pollReviewRequested,
            githubLogin,
          );
          reconcileResolvedComments(result.resolvedIds);
          const hadActivity = result.comments.length > 0;
          pollOutcomes.push({ repo: repoInfo.repo, hadActivity });
          if (result.comments.length > 0) {
            enqueueMany(result.comments, repoInfo.repo, state);
          }
        } catch (e2) {
          console.error(`\n  Error polling ${repoInfo.repo}: ${(e2 as Error).message}`);
        }
      }
    }

    recordPollOutcomes(pollOutcomes, Date.now());

    state.lastPoll = new Date().toISOString();
    saveState(state);

    const now = new Date().toLocaleTimeString();
    setStatus(`[${now}] Analyzed ${reposToPoll.length} of ${allRepoPaths.length} repo(s).`);
    updatePollState({ lastPoll: Date.now(), polling: false, lastPollError: null });

    /** One `buildPullSidebarLists` per poll (tickets, coherence, push) — avoids 3× GitHub fan-out. */
    let sidebarListsMemo: Awaited<ReturnType<typeof buildPullSidebarLists>> | null = null;
    async function getSidebarListsOnce() {
      if (!sidebarListsMemo) sidebarListsMemo = await buildPullSidebarLists(repos);
      return sidebarListsMemo;
    }

    // ── Ticket polling ──
    try {
      const provider = await getTicketProvider(config);
      if (provider) {
        if (Date.now() < linearRateLimitBackoffUntilMs) {
          const mins = Math.ceil((linearRateLimitBackoffUntilMs - Date.now()) / 60_000);
          if (shouldLogAttentionPipeline()) {
            console.error(`[tickets] Linear rate-limit backoff active (${mins}m remaining)`);
          }
        } else {
        let myIssues = await provider.fetchMyIssues();
        const prevMine = getTicketState().myIssues;
        // Linear occasionally returns an empty page; re-fetch before replacing a non-empty snapshot.
        if (myIssues.length === 0 && prevMine.length > 0) {
          await delay(400);
          myIssues = await provider.fetchMyIssues();
        }
        if (myIssues.length === 0 && prevMine.length > 0) {
          await delay(900);
          myIssues = await provider.fetchMyIssues();
        }

        // Open PRs plus recently merged (authored) so ticket links survive after merge
        const lists = await getSidebarListsOnce();
        const mergedForLinks = await fetchMergedAuthoredLinkablePRs(repos);
        const openLinkable: LinkablePR[] = [...lists.authored, ...lists.reviewRequested].map((p) => ({
          number: p.number as number,
          repo: p.repo as string,
          branch: p.branch as string,
          title: p.title as string,
          body: "",
        }));
        const openKeys = new Set(openLinkable.map((p) => `${p.repo}#${p.number}`));
        const linkablePRs: LinkablePR[] = [
          ...openLinkable,
          ...mergedForLinks.filter((p) => !openKeys.has(`${p.repo}#${p.number}`)),
        ];

        // Extract all candidate identifiers from PRs
        const allIdentifiers = new Set(linkablePRs.flatMap(extractTicketIdentifiers));

        // Fetch matching issues from provider (validates identifiers)
        const repoLinkedIssues = allIdentifiers.size > 0
          ? await provider.fetchIssuesByIdentifiers([...allIdentifiers])
          : [];

        // Build bidirectional link map
        const validIds = new Set([
          ...myIssues.map((i) => i.identifier),
          ...repoLinkedIssues.map((i) => i.identifier),
        ]);
        const linkMap = buildLinkMap(linkablePRs, validIds);
        for (const issue of [...myIssues, ...repoLinkedIssues]) {
          const extra = issue.providerLinkedPulls;
          if (extra?.length) {
            mergeProviderPullLinksIntoLinkMap(linkMap, issue.identifier, extra);
          }
        }

        updateTicketState({ myIssues, repoLinkedIssues, linkMap });
        }
      } else if (shouldLogAttentionPipeline()) {
        console.error("[tickets] no ticket provider configured — skipping Linear poll; ticket/link map left as-is");
      }
    } catch (err) {
      if (isLinearRateLimitError(err)) {
        linearRateLimitBackoffUntilMs = Date.now() + LINEAR_RATE_LIMIT_BACKOFF_MS;
      }
      console.error(`\n  Ticket poll error: ${(err as Error).message}`);
    }
    // ── Coherence evaluation ──
    try {
      const lists = await getSidebarListsOnce();
      const tState = getTicketState();

      const toPRsRecord: Record<string, Array<{ number: number; repo: string; title: string }>> = {};
      for (const [k, v] of tState.linkMap.ticketToPRs) {
        toPRsRecord[k] = v;
      }
      const toTicketsRecord: Record<string, string[]> = {};
      for (const [k, v] of tState.linkMap.prToTickets) {
        toTicketsRecord[k] = v;
      }

      const mapPR = (p: Record<string, unknown>): CoherencePR => ({
        number: p.number as number,
        repo: p.repo as string,
        title: p.title as string,
        branch: p.branch as string,
        updatedAt: p.updatedAt as string,
        checksStatus: p.checksStatus as string,
        hasHumanApproval: p.hasHumanApproval as boolean,
        merged: false,
        reviewers: [],
        pendingTriage: p.pendingTriage as number | undefined,
      });

      const coherenceInput: CoherenceInput = {
        myTickets: tState.myIssues,
        repoLinkedTickets: tState.repoLinkedIssues,
        authoredPRs: lists.authored.map(mapPR),
        reviewRequestedPRs: lists.reviewRequested.map(mapPR),
        ticketToPRs: toPRsRecord,
        prToTickets: toTicketsRecord,
        thresholds: {
          branchStalenessDays: config.coherence?.branchStalenessDays ?? 3,
          approvedUnmergedHours: config.coherence?.approvedUnmergedHours ?? 24,
          reviewWaitHours: config.coherence?.reviewWaitHours ?? 24,
          ticketInactivityDays: config.coherence?.ticketInactivityDays ?? 5,
        },
        now: Date.now(),
        mutedRepos: config.mutedRepos ?? [],
      };

      if (shouldLogAttentionPipeline()) {
        const ticketKeys = Object.keys(toPRsRecord).length;
        const prKeys = Object.keys(toTicketsRecord).length;
        const withProviderPrs = tState.myIssues.filter((i) => (i.providerLinkedPulls?.length ?? 0) > 0).length;
        console.error(
          `[coherence] link map: myIssues=${tState.myIssues.length} repoLinked=${tState.repoLinkedIssues.length} ` +
            `ticket→PR=${ticketKeys} pr→ticket=${prKeys} myIssuesWithProviderLinkedPRs=${withProviderPrs}`,
        );
        const startedNoSignal = tState.myIssues.filter(
          (i) =>
            i.state.type === "started"
            && !(toPRsRecord[i.identifier]?.length)
            && !(i.providerLinkedPulls?.length),
        );
        if (startedNoSignal.length > 0) {
          const show = startedNoSignal.slice(0, 20).map((i) => i.identifier);
          const tail = startedNoSignal.length > 20 ? ` …(+${startedNoSignal.length - 20} more)` : "";
          console.error(
            `[coherence] WARNING ${startedNoSignal.length} started "mine" ticket(s) have neither ticketToPRs nor providerLinkedPulls — ticket-no-pr likely: ${show.join(", ")}${tail}`,
          );
        }
      }

      const alerts = evaluateCoherence(coherenceInput);
      const { added, removed } = refreshAttentionFeed(alerts);
      if (added > 0 || removed > 0) {
        sseBroadcast("attention", { updated: true, added, removed });
      }
      if (added > 0) {
        try {
          const { getAttentionItems } = await import("./attention.js");
          const items = getAttentionItems();
          const highPriority = items.filter((i) => i.priority === "high");
          if (highPriority.length > 0) {
            const notifier = await import("node-notifier");
            notifier.default.notify({
              title: "Code Triage - Needs Attention",
              message: highPriority.length === 1
                ? highPriority[0]!.title
                : `${highPriority.length} high-priority items need your attention`,
            });
          }
        } catch {
          // Notification failures are non-fatal.
        }
      }
    } catch (err) {
      console.error(`\n  Coherence evaluation error: ${(err as Error).message}`);
    }
    if (isTeamFeaturesEnabled(config)) {
      const intervalMs = (config.team?.pollIntervalMinutes ?? 5) * 60_000;
      if (Date.now() - lastTeamOverviewRefreshMs >= intervalMs) {
        lastTeamOverviewRefreshMs = Date.now();
        try {
          const { rebuildTeamOverviewSnapshot, writeTeamOverviewCache } = await import("./team/overview.js");
          const { snapshot, error } = await rebuildTeamOverviewSnapshot();
          writeTeamOverviewCache(snapshot, error);
          sseBroadcast("team-overview", { updated: true });
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`\n  Team overview refresh error: ${msg}`);
          try {
            const { writeTeamOverviewCache } = await import("./team/overview.js");
            writeTeamOverviewCache(
              {
                generatedAt: new Date().toISOString(),
                summaryCounts: {
                  stuck: 0,
                  awaitingReview: 0,
                  recentlyMerged: 0,
                  unlinkedPrs: 0,
                  unlinkedTickets: 0,
                },
                stuck: [],
                awaitingReview: [],
                recentlyMerged: [],
                unlinkedPrs: [],
                unlinkedTickets: [],
              },
              msg,
            );
            sseBroadcast("team-overview", { updated: true });
          } catch {
            // DB or cache write failure — already logged above
          }
        }
      }
    }
    // After tickets + coherence so /api/attention and link maps match this poll cycle
    sseBroadcast("poll", { ok: true, at: Date.now() });
    // Feed poll data to push notification module
    try {
      const lists = await getSidebarListsOnce();
      processPolledData({
        authored: lists.authored.map((p) => ({
          repo: p.repo as string,
          number: p.number as number,
          title: p.title as string,
          checksStatus: p.checksStatus as string,
          openComments: p.openComments as number,
        })),
        reviewRequested: lists.reviewRequested.map((p) => ({
          repo: p.repo as string,
          number: p.number as number,
          title: p.title as string,
          checksStatus: p.checksStatus as string,
          openComments: p.openComments as number,
        })),
      });
    } catch { /* push notification failure should not break poll */ }
    if (Number.isFinite(commentRetentionDays) && commentRetentionDays > 0) {
      compactCommentHistory(commentRetentionDays);
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`\nPoll error: ${msg}`);
    setStatus(`Error: ${msg}`);
    updatePollState({ polling: false, lastPollError: msg });
    sseBroadcast("poll", { ok: false, at: Date.now(), error: msg });
  }

  running = false;
  setProcessing(false);
  const ghStatsEnd = getGitHubRequestStatsSnapshot();
  const totalDelta = ghStatsEnd.total - ghStatsStart.total;
  if (totalDelta > 0) {
    const families = Object.entries(ghStatsEnd.byFamily)
      .map(([k, v]) => [k, v - (ghStatsStart.byFamily[k] ?? 0)] as const)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const familyText = families.map(([k, v]) => `${k}:${v}`).join(", ");
    console.log(`  GitHub usage this poll: ${totalDelta} request(s)${familyText ? ` [${familyText}]` : ""}`);
  }
  schedulePoll(reposPolledCount);
}

setManualPollHandler(() => poll());

async function listPRs(): Promise<void> {
  if (running) return;
  running = true;
  setProcessing(true);

  try {
    const githubLogin = await getGitHubLogin();
    const state = loadState();
    const batch = await fetchNewCommentsBatch(
      repos.map((r) => r.repo),
      (repo, id) => needsEvaluation(state, id, repo),
      pollReviewRequested,
      githubLogin,
    );
    for (const repoInfo of repos) {
      const result = batch.get(repoInfo.repo) ?? {
        comments: [],
        pullsByNumber: {},
        resolvedIds: new Set<number>(),
      };
      reconcileResolvedComments(result.resolvedIds);
      const { comments, pullsByNumber } = result;

      const prNumbers = Object.keys(pullsByNumber);
      if (prNumbers.length === 0) continue;

      console.log(`\n  ${repoInfo.repo} (${prNumbers.length} PRs):`);
      for (const prNum of prNumbers) {
        const pr = pullsByNumber[Number(prNum)];
        const prComments = comments.filter((c) => c.prNumber === Number(prNum));
        const commentStr = prComments.length > 0 ? ` — ${prComments.length} new comment(s)` : "";
        console.log(`    PR #${prNum}: ${pr.title} (${pr.branch})${commentStr}`);
      }
    }
    console.log("");
  } catch (err) {
    console.error(`\n  Error fetching PRs: ${(err as Error).message}\n`);
  }

  running = false;
  setProcessing(false);
}

async function rediscover(): Promise<void> {
  if (flags.repo) {
    console.log("\n  Single-repo mode, skipping discovery.\n");
    return;
  }
  config = loadConfig();
  const rootPath = getRoot();
  console.log("\n  Re-discovering repos...");
  repos = discoverRepos(rootPath);
  repos = await filterReposToPushAccess(repos);
  console.log(`  Found ${repos.length} repo(s) with push access.`);
  for (const r of repos) {
    console.log(`    ${r.repo}`);
  }
  console.log("");
  updateRepos(repos);
}

function clearState(): void {
  saveState({ lastPoll: null, comments: {} });
  console.log("\n  State cleared.\n");
  setStatus("State cleared.");
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanupTerminal();
  console.log("\n\nShutting down code-triage...");
  stopReviewReminder();
  if (pollTimer) clearTimeout(pollTimer);
  killAllChildren();
  void stopWorker();
  const check = setInterval(() => {
    if (!running) {
      clearInterval(check);
      console.log("Goodbye.");
      process.exit(0);
    }
  }, 100);
  setTimeout(() => {
    console.log("Force exiting.");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Register hotkeys
registerHotkeys([
  { key: "r", label: "Refresh", handler: () => { poll(); } },
  { key: "o", label: "Open UI", handler: openBrowser },
  { key: "d", label: "Discover", handler: () => { void rediscover().catch((e) => console.error(e)); } },
  { key: "c", label: "Clear state", handler: clearState },
  { key: "s", label: "Status", handler: () => { printStatus(); } },
  { key: "p", label: "List PRs", handler: () => { listPRs(); } },
  { key: "n", label: "Test notif", handler: () => { sendTestPush(); console.log("\n  Test notification triggered.\n"); } },
  { key: "q", label: "Quit", handler: shutdown },
]);

// Initial poll, then enter interactive mode
// In dev mode, skip the blocking initial poll by default (saves quota on nodemon reload).
// A short delayed warmup still runs so ticket/coherence/attention logs and API state update without pressing [r].
if (shouldLogAttentionPipeline()) {
  const skipWarmup = isDev && process.env.CODE_TRIAGE_SKIP_DEV_WARMUP === "1";
  console.error(
    `[code-triage] attention/coherence logs go to stderr. ` +
      (isDev
        ? skipWarmup
          ? "Dev: warmup poll off (CODE_TRIAGE_SKIP_DEV_WARMUP=1) — use the web sidebar “poll now” button, or wait for the interval ([r] needs a TTY)."
          : "Dev: first poll in ~4s (set CODE_TRIAGE_SKIP_DEV_WARMUP=1 to skip). Under concurrently, use the web “poll now” control if [r] does not work."
        : "Each poll cycle ends with [coherence] / [attention] lines."),
  );
}
if (isDev) {
  console.log("  Dev mode: skipping immediate poll (warmup or [r] / interval)");
  schedulePoll(repos.length);
  if (process.env.CODE_TRIAGE_SKIP_DEV_WARMUP !== "1") {
    setTimeout(() => {
      void poll();
    }, 4000);
  }
} else {
  await poll();
}
enableRawMode();
