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

// Rate limit state — exported so the API server can surface it
let rateLimitState: { limited: boolean; resetAt: number | null } = { limited: false, resetAt: null };

export function getRateLimitState(): { limited: boolean; resetAt: number | null } {
  return rateLimitState;
}

// tokenResolver can be overridden by multi-account support (see config.ts accounts)

/** True when `GITHUB_TOKEN` or `GH_TOKEN` is set (non-whitespace). */
export function hasEnvGitHubToken(): boolean {
  return Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim());
}

/**
 * Default GitHub API token: `GITHUB_TOKEN` / `GH_TOKEN`, then optional config PAT, then `gh auth token`.
 */
export function resolveGitHubTokenFromSources(configToken?: string): string {
  const env = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (env) return env;
  if (configToken?.trim()) return configToken.trim();
  return execFileSync("gh", ["auth", "token"], {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
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

/** Clears cached PAT and restores default resolution (env → config via `installTokenResolverFromConfig` → `gh auth token`). */
export function resetTokenResolver(): void {
  cachedToken = null;
  tokenResolver = defaultTokenResolver;
}

async function waitForRateLimit(response: Response): Promise<void> {
  const resetHeader = response.headers.get("X-RateLimit-Reset");
  const resetAt = resetHeader ? parseInt(resetHeader, 10) * 1000 : Date.now() + 60_000;
  const waitMs = Math.max(resetAt - Date.now() + 1000, 1000);
  rateLimitState = { limited: true, resetAt };
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  rateLimitState = { limited: false, resetAt: null };
}

/**
 * Fetch passed into Octokit — retries 429 before Octokit sees a failure, so tests can stub `fetch`.
 */
async function githubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response!: Response;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    response = await globalThis.fetch(input, init);
    if (response.status === 429 && attempt < MAX_RETRIES - 1) {
      await waitForRateLimit(response);
      continue;
    }
    break;
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
  const octoResponse = await octokit.request({
    method: "POST",
    url,
    body: Object.keys(body).length ? body : undefined,
  });
  return octoResponse.data as T;
}
