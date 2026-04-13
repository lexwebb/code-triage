import { execFile as execFileCb, execFileSync } from "child_process";

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

// --- GitHub API via direct fetch (no gh CLI overhead) ---

const GH_API_BASE = "https://api.github.com";
const MAX_RETRIES = 3;

let cachedToken: string | null = null;

// Rate limit state — exported so the API server can surface it
let rateLimitState: { limited: boolean; resetAt: number | null } = { limited: false, resetAt: null };

export function getRateLimitState(): { limited: boolean; resetAt: number | null } {
  return rateLimitState;
}

// tokenResolver can be overridden by multi-account support (see config.ts accounts)
let tokenResolver: (repo?: string) => string = () => {
  if (cachedToken) return cachedToken;
  cachedToken = execFileSync("gh", ["auth", "token"], {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  return cachedToken;
};

export function setTokenResolver(fn: (repo?: string) => string): void {
  tokenResolver = fn;
}

function ghHeaders(repo?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${tokenResolver(repo)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "code-triage",
  };
}

async function waitForRateLimit(response: Response): Promise<void> {
  const resetHeader = response.headers.get("X-RateLimit-Reset");
  const resetAt = resetHeader ? parseInt(resetHeader, 10) * 1000 : Date.now() + 60_000;
  const waitMs = Math.max(resetAt - Date.now() + 1000, 1000);
  rateLimitState = { limited: true, resetAt };
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  rateLimitState = { limited: false, resetAt: null };
}

export async function ghAsync<T>(endpoint: string, repo?: string): Promise<T> {
  // Handle pagination — GitHub returns Link header with rel="next"
  const url = endpoint.startsWith("http") ? endpoint : `${GH_API_BASE}${endpoint}`;
  let allResults: unknown[] | null = null;
  let nextUrl: string | null = url;

  while (nextUrl) {
    let response!: Response;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      response = await fetch(nextUrl, { headers: ghHeaders(repo) });
      if (response.status === 429) {
        if (attempt < MAX_RETRIES - 1) {
          await waitForRateLimit(response);
          continue;
        }
      }
      break;
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`GitHub API ${response.status}: ${errBody.slice(0, 300)}`);
    }

    const data: unknown = await response.json();

    // If the response is an array, paginate
    if (Array.isArray(data)) {
      if (!allResults) allResults = [];
      allResults.push(...data);
    } else {
      // Non-array response (single object) — return immediately
      return data as T;
    }

    // Check for next page
    const linkHeader: string | null = response.headers.get("link");
    nextUrl = null;
    if (linkHeader) {
      const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) nextUrl = nextMatch[1];
    }
  }

  return (allResults ?? []) as T;
}

export async function ghGraphQL<T>(query: string, variables: Record<string, unknown>, repo?: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(`${GH_API_BASE}/graphql`, {
      method: "POST",
      headers: {
        ...ghHeaders(repo),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429 && attempt < MAX_RETRIES - 1) {
      await waitForRateLimit(res);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub GraphQL ${res.status}: ${body.slice(0, 300)}`);
    }

    return await res.json() as T;
  }
  throw new Error("GitHub GraphQL: exceeded retry limit");
}

export async function ghPost<T>(endpoint: string, body: Record<string, unknown>, repo?: string): Promise<T> {
  const url = endpoint.startsWith("http") ? endpoint : `${GH_API_BASE}${endpoint}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...ghHeaders(repo),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < MAX_RETRIES - 1) {
      await waitForRateLimit(res);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub API POST ${res.status}: ${text.slice(0, 300)}`);
    }

    return await res.json() as T;
  }
  throw new Error("GitHub API POST: exceeded retry limit");
}
