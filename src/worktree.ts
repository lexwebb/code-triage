import { execFileSync } from "child_process";
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import type { FixJobRecord } from "./types.js";

const WORKTREE_DIR = ".cr-worktrees";

function getRepoRoot(cwd?: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    cwd,
  }).trim();
}

export function getWorktreePath(branch: string, repoDir?: string): string {
  const root = repoDir ? getRepoRoot(repoDir) : getRepoRoot();
  const safeName = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
  return join(root, WORKTREE_DIR, safeName);
}

export function removeWorktree(branch: string, repoDir?: string): void {
  const worktreePath = getWorktreePath(branch, repoDir);
  if (!existsSync(worktreePath)) return;

  const cwd = repoDir ? getRepoRoot(repoDir) : undefined;
  // removing worktree silently
  try {
    execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
      encoding: "utf-8",
      stdio: "pipe",
      cwd,
    });
  } catch {
    // Force remove the directory and prune
    rmSync(worktreePath, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], {
      encoding: "utf-8",
      stdio: "pipe",
      cwd,
    });
  }
}

export function createWorktree(branch: string, repoDir?: string): string {
  const worktreePath = getWorktreePath(branch, repoDir);

  if (existsSync(worktreePath)) {
    removeWorktree(branch, repoDir);
  }

  const cwd = repoDir ? getRepoRoot(repoDir) : undefined;
  try {
    execFileSync("git", ["worktree", "add", worktreePath, branch], {
      encoding: "utf-8",
      stdio: "pipe",
      cwd,
    });
  } catch {
    // Branch may already be checked out — use detached HEAD at the branch tip
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, branch], {
      encoding: "utf-8",
      stdio: "pipe",
      cwd,
    });
  }

  return worktreePath;
}

export function cleanupAllWorktrees(): void {
  const root = getRepoRoot();
  const dir = join(root, WORKTREE_DIR);

  if (!existsSync(dir)) return;

  rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["worktree", "prune"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

/** Remove any worktree dirs that are not referenced by an active fix job. Called at startup. */
export function pruneOrphanedWorktrees(repoLocalPath: string, activeJobs: FixJobRecord[]): void {
  let root: string;
  try {
    root = getRepoRoot(repoLocalPath);
  } catch {
    return;
  }
  const dir = join(root, WORKTREE_DIR);
  if (!existsSync(dir)) return;

  const activePaths = new Set(activeJobs.map((j) => j.worktreePath));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (!activePaths.has(fullPath)) {
      try {
        rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
  try {
    execFileSync("git", ["worktree", "prune"], { encoding: "utf-8", stdio: "pipe", cwd: root });
  } catch {
    // ignore
  }
}

export function getDiffInWorktree(worktreePath: string): string {
  return execFileSync("git", ["diff"], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
}

export function commitAndPushWorktree(worktreePath: string, message: string, branch?: string): void {
  execFileSync("git", ["add", "-A"], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
  execFileSync("git", ["commit", "--no-verify", "-m", message], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
  const pushArgs = branch ? ["push", "origin", `HEAD:${branch}`] : ["push"];
  execFileSync("git", pushArgs, {
    encoding: "utf-8",
    cwd: worktreePath,
  });
}
