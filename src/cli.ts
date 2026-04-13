#!/usr/bin/env node
import { parseArgs } from "util";
import { loadState, saveState, isNewComment, getCommentsByStatus } from "./state.js";
import { fetchNewComments } from "./poller.js";
import { notifyNewComments } from "./notifier.js";
import { analyzeComments, killAllChildren } from "./actioner.js";
import { cleanupAllWorktrees } from "./worktree.js";
import {
  enableRawMode,
  registerHotkeys,
  setNextPollTime,
  clearCountdown,
  setStatus,
  setProcessing,
  cleanup as cleanupTerminal,
} from "./terminal.js";
import { startServer, updateRepos, updatePollState } from "./server.js";
import { discoverRepos, type RepoInfo } from "./discovery.js";

const { values: flags } = parseArgs({
  options: {
    interval: { type: "string", default: "1" },
    repo: { type: "string" },
    root: { type: "string", default: "~/src" },
    cleanup: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    port: { type: "string", default: "3100" },
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

const intervalMs = parseInt(flags.interval!, 10) * 60 * 1000;
const dryRun = flags["dry-run"]!;

// Resolve repos: single repo mode or multi-repo discovery
let repos: RepoInfo[];
if (flags.repo) {
  repos = [{ repo: flags.repo, localPath: "" }];
} else {
  console.log(`Discovering repos in ${flags.root}...`);
  repos = discoverRepos(flags.root!);
  if (repos.length === 0) {
    console.error("No GitHub repos found. Use --root to specify a different directory, or --repo for a single repo.");
    process.exit(1);
  }
}

console.log(`code-triage started`);
console.log(`  Repos: ${repos.length}`);
for (const r of repos) {
  console.log(`    ${r.repo}`);
}
console.log(`  Interval: ${flags.interval}m`);
console.log(`  Dry run: ${dryRun}\n`);

startServer(parseInt(flags.port!, 10), repos);

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
        const { comments, pullsByNumber } = await fetchNewComments(repoInfo.repo, (id) =>
          isNewComment(state, id, repoInfo.repo),
        );

        if (comments.length > 0) {
          notifyNewComments(comments, pullsByNumber);
          await analyzeComments(comments, pullsByNumber, state, repoInfo.repo, dryRun);
        }
      } catch (err) {
        console.error(`\n  Error polling ${repoInfo.repo}: ${(err as Error).message}`);
      }
    }

    state.lastPoll = new Date().toISOString();
    saveState(state);

    const now = new Date().toLocaleTimeString();
    setStatus(`[${now}] Analyzed ${repos.length} repo(s).`);
    updatePollState({ lastPoll: Date.now(), polling: false });
  } catch (err) {
    console.error(`\nPoll error: ${(err as Error).message}`);
    setStatus(`Error: ${(err as Error).message}`);
    updatePollState({ polling: false });
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
      const { comments, pullsByNumber } = await fetchNewComments(repoInfo.repo, (id) =>
        isNewComment(state, id, repoInfo.repo),
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
  console.log("\n  Re-discovering repos...");
  repos = discoverRepos(flags.root!);
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
  { key: "d", label: "Discover", handler: rediscover },
  { key: "c", label: "Clear state", handler: clearState },
  { key: "s", label: "Status", handler: () => { printStatus(); } },
  { key: "p", label: "List PRs", handler: () => { listPRs(); } },
  { key: "q", label: "Quit", handler: shutdown },
]);

// Initial poll, then enter interactive mode
await poll();
enableRawMode();
