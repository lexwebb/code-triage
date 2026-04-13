#!/usr/bin/env node
import { parseArgs } from "util";
import { execSync } from "child_process";
import { loadState, saveState, isNewComment, getCommentsByStatus, compactCommentHistory } from "./state.js";
import { fetchNewComments } from "./poller.js";
import { notifyNewComments } from "./notifier.js";
import { analyzeComments, clampEvalConcurrency, killAllChildren } from "./actioner.js";
import { cleanupAllWorktrees, pruneOrphanedWorktrees } from "./worktree.js";
import { setTokenResolver, resolveGitHubTokenFromSources, hasEnvGitHubToken } from "./exec.js";
import {
  enableRawMode,
  registerHotkeys,
  setNextPollTime,
  clearCountdown,
  setStatus,
  setProcessing,
  cleanup as cleanupTerminal,
} from "./terminal.js";
import { startServer, updateRepos, updatePollState, triggerTestNotification, sseBroadcast, setConfigSavedHandler } from "./server.js";
import { discoverRepos, type RepoInfo } from "./discovery.js";
import { loadConfig, saveConfig, configExists, type Config } from "./config.js";

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

// Check required CLI tools
function checkDependency(cmd: string, helpUrl: string): void {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
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

// CLI flags override config
const port = flags.port ? parseInt(flags.port, 10) : config.port;
let intervalMs = (flags.interval ? parseInt(flags.interval, 10) : config.interval) * 60 * 1000;
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

function openBrowser(): void {
  const url = `http://localhost:${port}`;
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
console.log(`  Repos: ${repos.length}`);
for (const r of repos) {
  console.log(`    ${r.repo}`);
}
console.log(`  Interval: ${intervalMs / 60000}m`);
console.log(`  Dry run: ${dryRun}`);
console.log(`  Eval concurrency: ${evalConcurrency}`);
console.log(`  Poll review-requested PRs: ${pollReviewRequested}`);
if (Number.isFinite(commentRetentionDays) && commentRetentionDays > 0) {
  console.log(`  Comment retention: ${commentRetentionDays} days (replied/dismissed/fixed)`);
}
console.log(`  WebUI: http://localhost:${port}\n`);

startServer(port, repos);

// Prune any orphaned worktrees from previous crashed sessions
{
  const state = loadState();
  const activeJobs = state.fixJobs ?? [];
  for (const r of repos) {
    if (r.localPath) pruneOrphanedWorktrees(r.localPath, activeJobs);
  }
}

let running = false;
let shuttingDown = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  setNextPollTime(intervalMs);
  const nextPoll = Date.now() + intervalMs;
  updatePollState({ nextPoll, intervalMs });
  pollTimer = setTimeout(poll, intervalMs);
}

function applyConfigReload(): void {
  config = loadConfig();
  intervalMs = config.interval * 60 * 1000;
  evalConcurrency = clampEvalConcurrency(config.evalConcurrency ?? 2);
  pollReviewRequested = config.pollReviewRequested === true;
  commentRetentionDays = config.commentRetentionDays ?? 0;
  installTokenResolverFromConfig(config);
  if (!flags.repo) {
    const rootPath = getRoot();
    console.log(`\n  Re-discovering repos under ${rootPath}...`);
    repos = discoverRepos(rootPath);
    console.log(`  Found ${repos.length} repo(s).`);
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
  schedulePoll();
}

setConfigSavedHandler(applyConfigReload);

async function poll(): Promise<void> {
  if (running || shuttingDown) return;
  running = true;
  setProcessing(true);
  updatePollState({ polling: true });

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  clearCountdown();

  try {
    const state = loadState();
    setStatus(`Polling ${repos.length} repo(s)...`);

    for (const repoInfo of repos) {
      try {
        const { comments, pullsByNumber } = await fetchNewComments(
          repoInfo.repo,
          (id) => isNewComment(state, id, repoInfo.repo),
          pollReviewRequested,
        );

        if (comments.length > 0) {
          notifyNewComments(comments, pullsByNumber);
          await analyzeComments(comments, pullsByNumber, state, repoInfo.repo, dryRun, evalConcurrency);
        }
      } catch (err) {
        console.error(`\n  Error polling ${repoInfo.repo}: ${(err as Error).message}`);
      }
    }

    state.lastPoll = new Date().toISOString();
    saveState(state);

    const now = new Date().toLocaleTimeString();
    setStatus(`[${now}] Analyzed ${repos.length} repo(s).`);
    updatePollState({ lastPoll: Date.now(), polling: false, lastPollError: null });
    sseBroadcast("poll", { ok: true, at: Date.now() });
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
  schedulePoll();
}

async function listPRs(): Promise<void> {
  if (running) return;
  running = true;
  setProcessing(true);

  try {
    for (const repoInfo of repos) {
      const state = loadState();
      const { comments, pullsByNumber } = await fetchNewComments(
        repoInfo.repo,
        (id) => isNewComment(state, id, repoInfo.repo),
        pollReviewRequested,
      );

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

function rediscover(): void {
  if (flags.repo) {
    console.log("\n  Single-repo mode, skipping discovery.\n");
    return;
  }
  config = loadConfig();
  const rootPath = getRoot();
  console.log("\n  Re-discovering repos...");
  repos = discoverRepos(rootPath);
  console.log(`  Found ${repos.length} repo(s).`);
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
  if (pollTimer) clearTimeout(pollTimer);
  killAllChildren();
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
  { key: "d", label: "Discover", handler: rediscover },
  { key: "c", label: "Clear state", handler: clearState },
  { key: "s", label: "Status", handler: () => { printStatus(); } },
  { key: "p", label: "List PRs", handler: () => { listPRs(); } },
  { key: "n", label: "Test notif", handler: () => { triggerTestNotification(); console.log("\n  Test notification triggered.\n"); } },
  { key: "q", label: "Quit", handler: shutdown },
]);

// Initial poll, then enter interactive mode
await poll();
enableRawMode();
