import { execFileSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";

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
  console.log(`  Removing worktree: ${worktreePath}`);
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
    console.log(`  Cleaning up stale worktree: ${worktreePath}`);
    removeWorktree(branch, repoDir);
  }

  console.log(`  Creating worktree for branch: ${branch}`);
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

  if (!existsSync(dir)) {
    console.log("No worktrees to clean up.");
    return;
  }

  console.log("Cleaning up all cr-watch worktrees...");
  rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["worktree", "prune"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  console.log("Done.");
}

export function getDiffInWorktree(worktreePath: string): string {
  return execFileSync("git", ["diff"], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
}

export function commitAndPushWorktree(worktreePath: string, message: string): void {
  execFileSync("git", ["add", "-A"], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
  execFileSync("git", ["commit", "--no-verify", "-m", message], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
  execFileSync("git", ["push"], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
}
