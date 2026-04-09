#!/usr/bin/env node
import { parseArgs } from "util";
import { loadState, saveState, isNewComment, getCommentsByStatus } from "./state.js";
import { fetchNewComments, getRepoFromGit } from "./poller.js";
import { notifyNewComments } from "./notifier.js";
import { processComments, killAllChildren } from "./actioner.js";
import { cleanupAllWorktrees } from "./worktree.js";

const { values: flags } = parseArgs({
  options: {
    interval: { type: "string", default: "5" },
    repo: { type: "string" },
    cleanup: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    status: { type: "boolean", default: false },
  },
});

if (flags.cleanup) {
  cleanupAllWorktrees();
  process.exit(0);
}

if (flags.status) {
  const state = loadState();
  const seen = getCommentsByStatus(state, "seen");
  const replied = getCommentsByStatus(state, "replied");
  const fixed = getCommentsByStatus(state, "fixed");
  const skipped = getCommentsByStatus(state, "skipped");

  console.log("cr-watch status:");
  console.log(`  Last poll: ${state.lastPoll || "never"}`);
  console.log(`  Comments: ${Object.keys(state.comments).length} total`);
  console.log(`    Pending:  ${seen.length}`);
  console.log(`    Replied:  ${replied.length}`);
  console.log(`    Fixed:    ${fixed.length}`);
  console.log(`    Skipped:  ${skipped.length}`);
  process.exit(0);
}

const intervalMs = parseInt(flags.interval!, 10) * 60 * 1000;
const repoPath = flags.repo || getRepoFromGit();
const dryRun = flags["dry-run"]!;

console.log(`cr-watch started`);
console.log(`  Repo: ${repoPath}`);
console.log(`  Interval: ${flags.interval}m`);
console.log(`  Dry run: ${dryRun}`);
console.log(`  Press Ctrl+C to stop.\n`);

let running = false;
let shuttingDown = false;

async function poll(): Promise<void> {
  if (running || shuttingDown) return;
  running = true;

  try {
    const state = loadState();
    const { comments, pullsByNumber } = await fetchNewComments(repoPath, (id) =>
      isNewComment(state, id),
    );

    state.lastPoll = new Date().toISOString();
    saveState(state);

    if (comments.length === 0) {
      const now = new Date().toLocaleTimeString();
      process.stdout.write(`\r  [${now}] No new comments.`);
      running = false;
      return;
    }

    notifyNewComments(comments, pullsByNumber);
    await processComments(comments, pullsByNumber, state, repoPath, dryRun);
  } catch (err) {
    console.error(`\nPoll error: ${(err as Error).message}`);
  }

  running = false;
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\nShutting down cr-watch...");
  clearInterval(timer);
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

await poll();
const timer = setInterval(poll, intervalMs);
