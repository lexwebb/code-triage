import { execFile as execFileCb, execFileSync } from "child_process";
import { Octokit } from "@octokit/rest";

// --- Process exec (still needed for claude CLI, git, etc.) ---

interface ExecOptions {
  cwd?: string;
  timeout?: number;
  input?: string;
}

export function execAsync(cmd: string, args: string[], options: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFileCb(cmd, args, {
      encoding: "utf-8",
      timeout: options.timeout ?? 30000,
      cwd: options.cwd,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${stderr?.slice(0, 500) || err.message}`));
      } else {
        resolve(stdout);
      }
    });

    if (options.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

// --- GitHub API via Octokit (REST + GraphQL); custom fetch keeps 429 retry + test stubs ---

const GH_API_BASE = "https://api.github.com";
const MAX_RETRIES = 3;

let cachedToken: string | null = null;

/** Snapshot from latest GitHub REST/GraphQL response `X-RateLimit-*` headers (see `applyRateLimitFromResponse`). */
export interface GitHubRateLimitSnapshot {
  /** True when quota is exhausted or HTTP 429. */
  limited: boolean;
  /** Wall-clock ms (UTC) when the current window resets. */
  resetAt: number | null;
  remaining: number | null;
  limit: number | null;
  /** e.g. `core`, `graphql` — when GitHub sends `X-RateLimit-Resource`. */
  resource: string | null;
  updatedAt: number;
}

const emptyRateLimitSnapshot = (): GitHubRateLimitSnapshot => ({
  limited: false,
  resetAt: null,
  remaining: null,
  limit: null,
  resource: null,
  updatedAt: 0,
});

let rateLimitSnapshot: GitHubRateLimitSnapshot = emptyRateLimitSnapshot();

export function getRateLimitState(): GitHubRateLimitSnapshot {
  return { ...rateLimitSnapshot };
}

/** Vitest: reset between tests so snapshots do not leak. */
export function resetRateLimitStateForTests(): void {
  rateLimitSnapshot = emptyRateLimitSnapshot();
}

function applyRateLimitFromResponse(response: Response): void {
  const remainingH = response.headers.get("X-RateLimit-Remaining");
  const limitH = response.headers.get("X-RateLimit-Limit");
  const resetH = response.headers.get("X-RateLimit-Reset");
  const resourceH = response.headers.get("X-RateLimit-Resource");
  if (remainingH == null && limitH == null && resetH == null) {
    return;
  }

  const remaining =
    remainingH != null && remainingH !== "" && !Number.isNaN(parseInt(remainingH, 10))
      ? parseInt(remainingH, 10)
      : null;
  const limit =
    limitH != null && limitH !== "" && !Number.isNaN(parseInt(limitH, 10)) ? parseInt(limitH, 10) : null;
  const resetAt =
    resetH != null && resetH !== "" && !Number.isNaN(parseInt(resetH, 10))
      ? parseInt(resetH, 10) * 1000
      : null;

  const limited =
    response.status === 429 ||
    (response.status === 403 && remaining === 0) ||
    (remaining !== null && remaining <= 0);

  rateLimitSnapshot = {
    limited,
    resetAt,
    remaining,
    limit,
    resource: resourceH?.trim() || null,
    updatedAt: Date.now(),
  };
}

// tokenResolver can be overridden by multi-account support (see config.ts accounts)

/** True when `GITHUB_TOKEN` or `GH_TOKEN` is set (non-whitespace). */
export function hasEnvGitHubToken(): boolean {
  return Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim());
}

/** True in `yarn dev`, `NODE_ENV=development`, or `CODE_TRIAGE_LOG_GITHUB=1`. Off under Vitest (`NODE_ENV=test`). */
function shouldLogGitHubRequests(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  return (
    process.env.NODE_ENV === "development" ||
    process.env.npm_lifecycle_event === "dev" ||
    process.env.CODE_TRIAGE_LOG_GITHUB === "1"
  );
}

function formatGithubRequestUrl(input: RequestInfo | URL): string {
  try {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
  } catch {
    return String(input);
  }
}

/**
 * Default GitHub API token: `GITHUB_TOKEN` / `GH_TOKEN`, then optional config PAT, then `gh auth token`.
 */
export function resolveGitHubTokenFromSources(configToken?: string): string {
  const env = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (env) return env;
  if (configToken?.trim()) return configToken.trim();
  const log = shouldLogGitHubRequests();
  const t0 = log ? performance.now() : 0;
  const token = execFileSync("gh", ["auth", "token"], {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  if (log) {
    console.error(`[github-cli] gh auth token ${Math.round(performance.now() - t0)}ms`);
  }
  return token;
}

function defaultTokenResolver(_repo?: string): string {
  if (cachedToken) return cachedToken;
  cachedToken = resolveGitHubTokenFromSources();
  return cachedToken;
}

let tokenResolver: (repo?: string) => string = defaultTokenResolver;

export function setTokenResolver(fn: (repo?: string) => string): void {
  tokenResolver = fn;
}

/**
 * Group repo paths that share the same resolved token so batched GraphQL never mixes PATs
 * (see multi-account `config.accounts`).
 */
export function partitionRepoPathsByToken(repoPaths: string[]): string[][] {
  const buckets = new Map<string, string[]>();
  for (const rp of repoPaths) {
    const token = tokenResolver(rp);
    const list = buckets.get(token);
    if (list) list.push(rp);
    else buckets.set(token, [rp]);
  }
  return Array.from(buckets.values());
}

/** Like `partitionRepoPathsByToken` but for flat `{ repoPath }` entries (e.g. per-PR rows). */
export function partitionEntriesByToken<T extends { repoPath: string }>(entries: T[]): T[][] {
  const buckets = new Map<string, T[]>();
  for (const e of entries) {
    const token = tokenResolver(e.repoPath);
    const list = buckets.get(token);
    if (list) list.push(e);
    else buckets.set(token, [e]);
  }
  return Array.from(buckets.values());
}

/** Clears cached PAT and restores default resolution (env → config via `installTokenResolverFromConfig` → `gh auth token`). */
export function resetTokenResolver(): void {
  cachedToken = null;
  tokenResolver = defaultTokenResolver;
}

async function sleepUntilRateLimitReset(response: Response): Promise<void> {
  const resetHeader = response.headers.get("X-RateLimit-Reset");
  const resetAt = resetHeader ? parseInt(resetHeader, 10) * 1000 : Date.now() + 60_000;
  const waitMs = Math.max(resetAt - Date.now() + 1000, 1000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

/**
 * Fetch passed into Octokit — retries 429 before Octokit sees a failure, so tests can stub `fetch`.
 * Records `X-RateLimit-*` on every response so the UI can show quota / reset (including 403 rate limits).
 */
async function githubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const log = shouldLogGitHubRequests();
  const t0 = log ? performance.now() : 0;
  const urlStr = formatGithubRequestUrl(input);
  const method = (init?.method ?? "GET").toUpperCase();

  let response!: Response;
  let attempts = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    attempts = attempt + 1;
    response = await globalThis.fetch(input, init);
    applyRateLimitFromResponse(response);
    if (response.status === 429 && attempt < MAX_RETRIES - 1) {
      await sleepUntilRateLimitReset(response);
      continue;
    }
    break;
  }
  if (log) {
    const ms = Math.round(performance.now() - t0);
    const retryNote = attempts > 1 ? ` (${attempts} HTTP attempts)` : "";
    console.error(`[github-api] ${method} ${urlStr} → ${response.status} ${ms}ms${retryNote}`);
  }
  return response;
}

function createOctokit(repo?: string): Octokit {
  return new Octokit({
    auth: tokenResolver(repo),
    userAgent: "code-triage",
    request: { fetch: githubFetch },
  });
}

/** Octokit instance using the same auth and 429-aware fetch as `ghAsync` / `ghPost` / `ghGraphQL`. */
export function createGitHubOctokit(repo?: string): Octokit {
  return createOctokit(repo);
}

export async function ghAsync<T>(endpoint: string, repo?: string): Promise<T> {
  const octokit = createOctokit(repo);
  const url = endpoint.startsWith("http") ? endpoint : `${GH_API_BASE}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  let allResults: unknown[] | null = null;
  let nextUrl: string | null = url;

  while (nextUrl) {
    const octoResponse = (await octokit.request({
      method: "GET",
      url: nextUrl,
    })) as { data: unknown; headers: { link?: string } };

    const data: unknown = octoResponse.data;
    const linkHeader: string | undefined = octoResponse.headers.link;

    if (Array.isArray(data)) {
      if (!allResults) allResults = [];
      allResults.push(...data);
    } else {
      return data as T;
    }

    nextUrl = null;
    if (linkHeader) {
      const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) nextUrl = nextMatch[1];
    }
  }

  return (allResults ?? []) as T;
}

export async function ghGraphQL<T>(query: string, variables: Record<string, unknown>, repo?: string): Promise<T> {
  const octokit = createOctokit(repo);
  const result = await octokit.graphql(query, variables);
  return result as T;
}

export async function ghPost<T>(endpoint: string, body: Record<string, unknown>, repo?: string): Promise<T> {
  const octokit = createOctokit(repo);
  const url = endpoint.startsWith("http") ? endpoint : `${GH_API_BASE}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  // Use `data`, not `body`: @octokit/endpoint treats a top-level `body` option as the JSON payload
  // but merges it wrong (nested under a `body` key). `data` maps directly to the HTTP JSON body.
  const octoResponse = await octokit.request({
    method: "POST",
    url,
    data: Object.keys(body).length ? body : undefined,
  });
  return octoResponse.data as T;
}
