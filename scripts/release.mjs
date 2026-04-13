#!/usr/bin/env node
/**
 * Interactive release script for code-triage.
 *
 * Usage:
 *   yarn release                    — Claude picks bump type, prompts to confirm
 *   yarn release patch              — bump patch version
 *   yarn release minor              — bump minor version
 *   yarn release major              — bump major version
 *   yarn release --dry-run          — full preview with no writes, commits, or pushes
 *   yarn release patch --dry-run    — dry-run with explicit bump type
 *
 * What it does:
 *   1. Collects commits since last tag
 *   2. Asks Claude to recommend patch/minor/major (user can override)
 *   3. Calls Claude to generate release notes
 *   4. Shows a preview and asks for confirmation
 *   5. Bumps package.json, commits, tags, pushes  [skipped in dry-run]
 *   6. Creates a GitHub Release via `gh` — triggers the npm publish workflow  [skipped in dry-run]
 */

import { execFileSync, spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr?.on("data", (d) => { err += d; process.stderr.write(d); });
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`)));
    child.on("error", reject);
    // Close stdin immediately so claude doesn't wait for input
    child.stdin?.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const bumpArg = args.find((a) => ["patch", "minor", "major"].includes(a));

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const currentVersion = pkg.version;

if (DRY_RUN) console.log("\n  [dry-run] No files will be written, no commits or pushes made.\n");

// Check for required tools (cross-platform — avoids `which` which fails on Windows)
for (const tool of ["git", "gh", "claude"]) {
  try { run(tool, ["--version"]); } catch {
    console.error(`\n  Error: '${tool}' is not installed or not in PATH.\n`);
    process.exit(1);
  }
}

// Check git is clean (skip in dry-run so you can test mid-development)
if (!DRY_RUN) {
  const gitStatus = run("git", ["status", "--porcelain"]);
  if (gitStatus) {
    console.error("\n  Error: working tree is not clean. Commit or stash changes first.\n");
    process.exit(1);
  }
}

// Check gh is authenticated
try { run("gh", ["auth", "status"]); } catch {
  console.error("\n  Error: GitHub CLI is not authenticated. Run: gh auth login\n");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

try {
  console.log(`\n  code-triage release — current version: ${currentVersion}\n`);

  // ── Step 1: Collect commits since last tag ──────────────────────────────
  let lastTag;
  try {
    lastTag = run("git", ["describe", "--tags", "--abbrev=0"]);
  } catch {
    lastTag = null; // No tags yet
  }

  const logRange = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const logArgs = ["log", logRange, "--pretty=format:%h %s (%an)", "--no-merges"];
  let commitLog;
  try {
    commitLog = run("git", logArgs);
  } catch {
    commitLog = "";
  }

  if (!commitLog) {
    console.log("  No commits since last release. Nothing to release.\n");
    process.exit(0);
  }

  const commitCount = commitLog.split("\n").length;
  console.log(`  Found ${commitCount} commit${commitCount !== 1 ? "s" : ""} since ${lastTag ?? "the beginning"}.\n`);

  // ── Step 2: Determine bump type ──────────────────────────────────────────
  let bumpType = bumpArg;
  if (!["patch", "minor", "major"].includes(bumpType)) {
    // Ask Claude to recommend a bump type based on the commits
    process.stdout.write("  Asking Claude for recommended version bump...");
    const bumpPrompt = `You are a semantic versioning assistant. Given these git commits, decide whether this release should be a "patch", "minor", or "major" version bump.

Rules (semver):
- patch: backwards-compatible bug fixes only
- minor: new backwards-compatible features or improvements
- major: breaking changes, removed commands/flags, incompatible API changes

Commits:
---
${commitLog}
---

Current version: ${currentVersion}

Respond with a JSON object only, no markdown:
{"bump": "patch" | "minor" | "major", "reason": "one sentence explanation"}`;

    let suggested = "patch";
    let reason = "";
    try {
      const raw = await spawnAsync("claude", ["-p", bumpPrompt, "--output-format", "json"]);
      process.stdout.write(" done.\n");
      const parsed = JSON.parse(raw.trim());
      const inner = parsed.result ? JSON.parse(parsed.result) : parsed;
      if (["patch", "minor", "major"].includes(inner.bump)) {
        suggested = inner.bump;
        reason = inner.reason ?? "";
      }
    } catch {
      process.stdout.write(" failed, defaulting to patch.\n");
    }

    console.log(`\n  Claude suggests: ${suggested}${reason ? ` — ${reason}` : ""}`);
    const answer = await ask(rl, `  Bump type (patch / minor / major) [${suggested}]: `);
    bumpType = ["patch", "minor", "major"].includes(answer) ? answer : suggested;
  }

  const newVersion = bumpVersion(currentVersion, bumpType);
  console.log(`\n  ${currentVersion}  →  ${newVersion}\n`);

  // ── Step 3: Generate release notes with Claude ───────────────────────────
  console.log("  Generating release notes with Claude...\n");

  const prompt = `You are writing GitHub release notes for a CLI tool called "code-triage".

code-triage monitors GitHub PR review comments (from CodeRabbit) and lets you action them — reply, resolve, or fix code — via a web dashboard powered by Claude.

Here are the commits in this release:
---
${commitLog}
---

Write GitHub release notes in markdown. Rules:
- One-sentence summary paragraph at the top
- Group changes under bold headings: **New Features**, **Improvements**, **Bug Fixes**, **Internal** (omit any empty group)
- Each item is a concise bullet point, written for end-users (not developers)
- Do not include a version heading — it will be added by GitHub
- Do not wrap in code fences
- Keep it short and scannable

Output only the markdown, nothing else.`;

  let releaseNotes;
  try {
    const raw = await spawnAsync("claude", ["-p", prompt, "--output-format", "json"]);
    // Claude --output-format json wraps the output in {"result": "..."}
    try {
      const parsed = JSON.parse(raw);
      releaseNotes = (parsed.result ?? raw).trim();
    } catch {
      releaseNotes = raw.trim();
    }
  } catch (err) {
    console.error(`\n  Claude failed: ${err.message}\n`);
    const fallback = await ask(rl, "  Enter release notes manually (or Ctrl+C to abort):\n  > ");
    releaseNotes = fallback;
  }

  // ── Step 4: Preview and confirm ──────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log(`  Release v${newVersion}\n`);
  console.log(releaseNotes.split("\n").map((l) => "  " + l).join("\n"));
  console.log("─".repeat(60) + "\n");

  if (DRY_RUN) {
    console.log("  [dry-run] Would run:");
    console.log(`    package.json  version: ${currentVersion} → ${newVersion}`);
    console.log(`    git add package.json && git commit -m "chore: release v${newVersion}"`);
    console.log(`    git tag v${newVersion} && git push && git push --tags`);
    console.log(`    gh release create v${newVersion} --title "v${newVersion}" --notes "..."`);
    console.log("\n  Dry-run complete. No changes made.\n");
    rl.close();
    process.exit(0);
  }

  const confirm = await ask(rl, "  Proceed? (y/N): ");
  if (confirm.toLowerCase() !== "y") {
    console.log("\n  Aborted.\n");
    process.exit(0);
  }

  rl.close();

  // ── Step 5: Bump package.json ────────────────────────────────────────────
  pkg.version = newVersion;
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  console.log(`\n  Bumped package.json to ${newVersion}`);

  // ── Step 6: Commit and tag ───────────────────────────────────────────────
  run("git", ["add", "package.json"]);
  run("git", ["commit", "-m", `chore: release v${newVersion}`]);
  run("git", ["tag", `v${newVersion}`]);
  console.log(`  Created commit and tag v${newVersion}`);

  // ── Step 7: Push ─────────────────────────────────────────────────────────
  console.log("  Pushing to origin...");
  run("git", ["push"]);
  run("git", ["push", "--tags"]);
  console.log("  Pushed.");

  // ── Step 8: Create GitHub Release (triggers npm publish workflow) ─────────
  console.log("  Creating GitHub release...");
  run("gh", [
    "release", "create",
    `v${newVersion}`,
    "--title", `v${newVersion}`,
    "--notes", releaseNotes,
  ]);

  console.log(`\n  ✓ Released v${newVersion}`);
  console.log(`  The npm publish workflow is now running.\n`);
  console.log(`  https://github.com/${run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])}/releases/tag/v${newVersion}\n`);

} catch (err) {
  rl.close();
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
}
