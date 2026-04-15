import { execFileSync, type ExecFileSyncOptions } from "child_process";
import { existsSync } from "fs";

type ExecGitUtf8 = ExecFileSyncOptions & { encoding: BufferEncoding };

let cachedBinary: string | null = null;
let loggedGitBinary = false;

/** Same `git` your login shell would use (PATH from `.zprofile` / `.bash_profile`, etc.). */
function tryResolveGitFromLoginShell(): string | null {
  if (process.platform === "win32") return null;
  const tryShell = (file: string, args: string[]): string | null => {
    if (!existsSync(file)) return null;
    try {
      const out = execFileSync(file, args, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4096,
      });
      const line = out
        .trim()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (line && existsSync(line)) return line;
    } catch {
      /* try next */
    }
    return null;
  };
  const darwinFirst = ["/bin/zsh", "/bin/bash"] as const;
  const linuxFirst = ["/bin/bash", "/bin/zsh"] as const;
  const order = process.platform === "darwin" ? darwinFirst : linuxFirst;
  const args = ["-lc", "command -v git"];
  for (const shell of order) {
    const p = tryShell(shell, args);
    if (p) return p;
  }
  return null;
}

/**
 * PATH for spawning Git: GUI/launchd Node often gets an empty or tiny PATH.
 * Prepend usual install locations (Homebrew before /usr/bin so a real binary wins over stubs).
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const sep = process.platform === "win32" ? ";" : ":";
  const extra =
    process.platform === "win32"
      ? ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\bin"]
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const tail = process.env.PATH ?? "";
  return { ...process.env, PATH: [...extra, tail].filter(Boolean).join(sep) };
}

/**
 * Git executable name or absolute path.
 * Order: `CODE_TRIAGE_GIT` / `GIT_BINARY`, then login-shell `command -v git`, then common paths, else `git`.
 */
export function gitBinary(): string {
  if (cachedBinary !== null) return cachedBinary;
  const fromEnv = process.env.CODE_TRIAGE_GIT?.trim() || process.env.GIT_BINARY?.trim();
  if (fromEnv) {
    cachedBinary = fromEnv;
    return cachedBinary;
  }
  const fromShell = tryResolveGitFromLoginShell();
  if (fromShell) {
    cachedBinary = fromShell;
    return cachedBinary;
  }
  const candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
  for (const p of candidates) {
    if (existsSync(p)) {
      cachedBinary = p;
      return cachedBinary;
    }
  }
  cachedBinary = "git";
  return cachedBinary;
}

/** Run Git with PATH fixed for child_process (fixes ENOENT when `git` is not on the parent PATH). */
export function execGitSync(args: string[], options: ExecGitUtf8): string;
export function execGitSync(args: string[], options?: ExecFileSyncOptions): string | Buffer;
export function execGitSync(args: string[], options?: ExecFileSyncOptions): string | Buffer {
  if (!loggedGitBinary) {
    loggedGitBinary = true;
    console.error(`[code-triage] using git executable: ${gitBinary()}`);
  }
  const env = { ...gitEnv(), ...options?.env };
  return execFileSync(gitBinary(), args, { ...options, env });
}

/** Pretty-print `execFileSync` / `execGitSync` failures (stderr, exit code, errno). */
export function formatGitExecError(err: unknown): string {
  if (err == null) return "unknown error";
  if (typeof err !== "object") return String(err);
  const o = err as NodeJS.ErrnoException & {
    status?: number | null;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };
  const lines: string[] = [o.message || "Error"];
  if (o.code) lines.push(`code=${o.code}`);
  if (o.errno != null) lines.push(`errno=${o.errno}`);
  if (o.status != null && o.status !== 0) lines.push(`exit=${o.status}`);
  const errStr = (x: string | Buffer | undefined): string => {
    if (x == null) return "";
    return typeof x === "string" ? x : x.toString("utf8");
  };
  const se = errStr(o.stderr).trim();
  const so = errStr(o.stdout).trim();
  if (se) lines.push(`stderr: ${se}`);
  if (so) lines.push(`stdout: ${so}`);
  return lines.join("; ");
}

/** For tests: clear memoized binary. */
export function resetGitBinaryCacheForTests(): void {
  cachedBinary = null;
  loggedGitBinary = false;
}
