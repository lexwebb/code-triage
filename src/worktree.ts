import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execGitSync, formatGitExecError, gitBinary } from "./git-exec.js";

const WORKTREE_DIR = ".cr-worktrees";

function getRepoRoot(cwd?: string): string {
  return execGitSync(["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    cwd,
  }).trim();
}

export function getWorktreePath(branch: string, repoDir?: string): string {
  const root = repoDir ? getRepoRoot(repoDir) : getRepoRoot();
  const safeName = branch.replace(/[^a-zA-Z0-9_-]/g, "-");
  return join(root, WORKTREE_DIR, safeName);
}

/**
 * Apply a unified diff (as produced by `git diff` in the worktree) after recreating the worktree.
 * Tries `git apply`, then `git apply --3way` if the branch has moved slightly.
 */
export function applyPatchInWorktree(worktreePath: string, patch: string): void {
  const trimmed = patch.trim();
  if (!trimmed) {
    throw new Error("Cannot apply empty patch");
  }
  const text = trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  const dir = mkdtempSync(join(tmpdir(), "ct-apply-"));
  const patchFile = join(dir, "fix.patch");
  try {
    writeFileSync(patchFile, text, "utf8");
    try {
      execGitSync(["apply", "--verbose", patchFile], { encoding: "utf-8", cwd: worktreePath });
    } catch (first) {
      try {
        execGitSync(["apply", "--3way", "--verbose", patchFile], { encoding: "utf-8", cwd: worktreePath });
      } catch {
        throw first;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function removeWorktree(branch: string, repoDir?: string): void {
  const worktreePath = getWorktreePath(branch, repoDir);
  if (!existsSync(worktreePath)) return;

  const cwd = repoDir ? getRepoRoot(repoDir) : undefined;
  // removing worktree silently
  try {
    execGitSync(["worktree", "remove", worktreePath, "--force"], {
      encoding: "utf-8",
      stdio: "pipe",
      cwd,
    });
  } catch {
    // Force remove the directory and prune
    rmSync(worktreePath, { recursive: true, force: true });
    execGitSync(["worktree", "prune"], {
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
    execGitSync(["worktree", "add", worktreePath, branch], {
      encoding: "utf-8",
      stdio: "pipe",
      cwd,
    });
  } catch {
    // Branch may already be checked out — use detached HEAD at the branch tip
    execGitSync(["worktree", "add", "--detach", worktreePath, branch], {
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
  execGitSync(["worktree", "prune"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
}

/**
 * Remove dirs under `.cr-worktrees` that are not in `protectedPaths`.
 * `protectedPaths` must include every worktree that still needs to exist on disk (in-flight fixes and completed fixes waiting for Apply — those are removed from `state.fixJobs` but stay in
 * `getAllFixJobStatuses()` until the user applies or discards).
 */
export function pruneOrphanedWorktrees(repoLocalPath: string, protectedPaths: Set<string>): void {
  let root: string;
  try {
    root = getRepoRoot(repoLocalPath);
  } catch {
    return;
  }
  const dir = join(root, WORKTREE_DIR);
  if (!existsSync(dir)) return;

  const activePaths = protectedPaths;
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
    execGitSync(["worktree", "prune"], { encoding: "utf-8", stdio: "pipe", cwd: root });
  } catch {
    // ignore
  }
}

export function getDiffInWorktree(worktreePath: string): string {
  return execGitSync(["diff"], {
    encoding: "utf-8",
    cwd: worktreePath,
  });
}

function gitStep(step: string, worktreePath: string, args: string[]): void {
  try {
    execGitSync(args, { encoding: "utf-8", cwd: worktreePath });
  } catch (err) {
    const bin = gitBinary();
    const quoted = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
    console.error(`[git] ${step} failed\n  ${bin} ${quoted}\n  cwd: ${worktreePath}\n  ${formatGitExecError(err)}`);
    const o = err as NodeJS.ErrnoException;
    if (o.code === "ENOENT" && !existsSync(worktreePath)) {
      throw new Error(
        `Fix worktree directory is missing: ${worktreePath}. Node reports missing cwd as spawnSync ENOENT on git. Recreate the fix or re-run 'Fix with Claude'.`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * `execFileSync(..., { cwd })` uses ENOENT for both 'git not found' and 'cwd does not exist'.
 * Validate early so Apply failures are actionable.
 */
function assertWorktreeDirForApply(worktreePath: string): void {
  if (!existsSync(worktreePath)) {
    throw new Error(
      `Fix worktree directory is missing: ${worktreePath}. Apply cannot run git here. Re-run 'Fix with Claude' or check .cr-worktrees.`,
    );
  }
  if (!statSync(worktreePath).isDirectory()) {
    throw new Error(`Fix worktree path is not a directory: ${worktreePath}`);
  }
}

export function commitAndPushWorktree(worktreePath: string, message: string, branch?: string): void {
  assertWorktreeDirForApply(worktreePath);
  gitStep("add", worktreePath, ["add", "-A"]);
  gitStep("commit", worktreePath, ["commit", "--no-verify", "-m", message]);
  // Pull --rebase before pushing so the fix commit lands on top of any new remote commits
  try {
    execGitSync(["pull", "--rebase", "origin", branch ?? "HEAD"], {
      encoding: "utf-8",
      cwd: worktreePath,
    });
  } catch (err) {
    console.error(
      `[git] pull --rebase (continuing to push anyway)\n  cwd: ${worktreePath}\n  ${formatGitExecError(err)}`,
    );
  }
  const pushArgs = branch ? ["push", "origin", `HEAD:${branch}`] : ["push"];
  gitStep("push", worktreePath, pushArgs);
}
