#!/usr/bin/env node
import { parseArgs } from "util";
import { execSync, execFileSync } from "child_process";
import { loadState, saveState, needsEvaluation, getCommentsByStatus, compactCommentHistory, reconcileResolvedComments } from "./state.js";
import { fetchNewComments, fetchNewCommentsBatch, getGitHubLogin } from "./poller.js";
import { clampEvalConcurrency, killAllChildren } from "./actioner.js";
import { enqueueMany, recoverQueue, startWorker, stopWorker } from "./eval-queue.js";
import { loadFixQueue, advanceQueue as advanceFixQueue } from "./fix-queue.js";
import { cleanupAllWorktrees, pruneOrphanedWorktrees } from "./worktree.js";
import { setTokenResolver, resolveGitHubTokenFromSources, hasEnvGitHubToken, getRateLimitState } from "./exec.js";
import {
  enableRawMode,
  registerHotkeys,
  setNextPollTime,
  clearCountdown,
  setStatus,
  setProcessing,
  cleanup as cleanupTerminal,
} from "./terminal.js";
import { startServer, updateRepos, updatePollState, sseBroadcast, setConfigSavedHandler, loadPersistedFixJobResults } from "./server.js";
import { initPush, processPolledData, startReviewReminder, sendTestPush } from "./push.js";
import { buildPullSidebarLists } from "./api.js";
import { discoverRepos, type RepoInfo } from "./discovery.js";
import { filterRepoPathsWithPushAccess, loadCachedPushAccess } from "./github-batching.js";
import { loadConfig, saveConfig, configExists, type Config } from "./config.js";
import { computeEffectivePollIntervalMs, estimatePollRequestCount } from "./poll-rate-budget.js";
import { recordPollOutcomes, selectReposToPoll } from "./repo-poll-schedule.js";

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

// In dev mode, use cached push-access results to avoid GitHub API calls on every hot reload
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
  } else {
    console.log(`  Dev mode: no push-access cache — polling all ${repos.length} repos. Press 'd' to discover and cache.`);
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
  try {
    const state = loadState();
    const allRepoPaths = repos.map((r) => r.repo);
    const staleDays = config.repoPollStaleAfterDays ?? 7;
    const useAdaptive = !flags.repo && staleDays > 0;
    const reposToPoll = useAdaptive
      ? selectReposToPoll(allRepoPaths, Date.now(), {
          staleAfterDays: staleDays,
          coldIntervalMinutes: config.repoPollColdIntervalMinutes ?? 60,
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
    sseBroadcast("poll", { ok: true, at: Date.now() });
    // Feed poll data to push notification module
    try {
      const lists = await buildPullSidebarLists(repos);
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
  schedulePoll(reposPolledCount);
}

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
// In dev mode, skip the initial poll to avoid burning GitHub API quota on every hot reload
if (isDev) {
  console.log("  Dev mode: skipping initial poll (press 'r' to poll manually)");
  schedulePoll(repos.length);
} else {
  await poll();
}
enableRawMode();
