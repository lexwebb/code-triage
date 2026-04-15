import { readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execGitSync } from "./git-exec.js";

export interface RepoInfo {
  repo: string;      // "owner/repo"
  localPath: string;  // absolute path to repo root
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "vendor", "dist", ".cr-worktrees",
  ".cache", ".npm", ".pnpm", "build", "__pycache__",
]);

const MAX_DEPTH = 3;

export function parseGitHubRemote(url: string): string | null {
  // SSH: git@github.com:owner/repo.git
  // HTTPS: https://github.com/owner/repo.git
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function getGitHubRepo(dir: string): string | null {
  try {
    const remote = execGitSync(["remote", "get-url", "origin"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseGitHubRemote(remote);
  } catch {
    return null;
  }
}

function walkDirectory(dir: string, depth: number, results: RepoInfo[]): void {
  if (depth > MAX_DEPTH) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // permission denied, etc.
  }

  // If this directory is a git repo, check for GitHub remote
  if (entries.includes(".git")) {
    const repo = getGitHubRepo(dir);
    if (repo) {
      results.push({ repo, localPath: dir });
    }
    return; // Don't recurse into git repos
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const fullPath = join(dir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        walkDirectory(fullPath, depth + 1, results);
      }
    } catch {
      // permission denied, broken symlink, etc.
    }
  }
}

export function discoverRepos(root: string): RepoInfo[] {
  const expandedRoot = root.replace(/^~/, homedir());
  if (!existsSync(expandedRoot)) {
    console.error(`  Root directory not found: ${expandedRoot}`);
    return [];
  }
  const results: RepoInfo[] = [];
  walkDirectory(expandedRoot, 0, results);
  results.sort((a, b) => a.repo.localeCompare(b.repo));
  return results;
}
