import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { registerRoutes } from "./api.js";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import type { RepoInfo } from "./discovery.js";
import { getRateLimitState } from "./exec.js";

declare module "http" {
  interface IncomingMessage {
    __body?: unknown;
  }
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));

type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, query: URLSearchParams) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function clearRoutes(): void {
  routes.length = 0;
}

function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  }).replace(/\*(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "(.+)";
  });
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  const ext = extname(filePath);
  const contentType = mimeTypes[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  res.end(readFileSync(filePath));
  return true;
}

let currentRepos: RepoInfo[] = [];

export function updateRepos(repos: RepoInfo[]): void {
  currentRepos = repos;
}

export function getRepos(): RepoInfo[] {
  return currentRepos;
}

const serverStartedAt = Date.now();

const pollState = {
  lastPoll: 0,
  nextPoll: 0,
  intervalMs: 0,
  polling: false,
  /** Last top-level poll failure (outer catch in `cli.ts`); cleared on success. */
  lastPollError: null as string | null,
};
let testNotificationPending = false;

export function triggerTestNotification(): void {
  testNotificationPending = true;
}

export function consumeTestNotification(): boolean {
  if (testNotificationPending) {
    testNotificationPending = false;
    return true;
  }
  return false;
}

export function updatePollState(state: {
  lastPoll?: number;
  nextPoll?: number;
  intervalMs?: number;
  polling?: boolean;
  lastPollError?: string | null;
}): void {
  Object.assign(pollState, state);
}

export interface FixJobStatus {
  commentId: number;
  repo: string;
  prNumber: number;
  path: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  error?: string;
  diff?: string;
  branch?: string;
  claudeOutput?: string;
}

const fixJobStatuses = new Map<number, FixJobStatus>();

export function setFixJobStatus(job: FixJobStatus): void {
  fixJobStatuses.set(job.commentId, job);
}

export function getActiveFixForBranch(branch: string): FixJobStatus | undefined {
  for (const job of fixJobStatuses.values()) {
    if (job.branch === branch && job.status === "running") return job;
  }
  return undefined;
}

export function getActiveFixForPR(repo: string, prNumber: number): FixJobStatus | undefined {
  for (const job of fixJobStatuses.values()) {
    if (job.repo === repo && job.prNumber === prNumber && job.status === "running") return job;
  }
  return undefined;
}

export function clearFixJobStatus(commentId: number): void {
  fixJobStatuses.delete(commentId);
}

export interface HealthPayload {
  status: "ok";
  uptimeMs: number;
  repos: number;
  polling: boolean;
  lastPollWallClockMs: number;
  nextPoll: number;
  intervalMs: number;
  lastPollError: string | null;
  rateLimit: { limited: boolean; resetAt: number | null };
  fixJobsRunning: number;
}

export function getPollState(options?: { consumeTestNotification?: boolean }) {
  const consume = options?.consumeTestNotification !== false;
  return {
    ...pollState,
    fixJobs: Array.from(fixJobStatuses.values()),
    testNotification: consume ? consumeTestNotification() : false,
    rateLimited: getRateLimitState().limited,
    rateLimitResetAt: getRateLimitState().resetAt,
  };
}

/** Snapshot for `GET /api/health` — does not consume the one-shot test-notification flag. */
export function getHealthPayload(): HealthPayload {
  const ps = getPollState({ consumeTestNotification: false });
  return {
    status: "ok",
    uptimeMs: Date.now() - serverStartedAt,
    repos: getRepos().length,
    polling: ps.polling,
    lastPollWallClockMs: ps.lastPoll,
    nextPoll: ps.nextPoll,
    intervalMs: ps.intervalMs,
    lastPollError: pollState.lastPollError,
    rateLimit: { limited: ps.rateLimited, resetAt: ps.rateLimitResetAt },
    fixJobsRunning: ps.fixJobs.filter((j) => j.status === "running").length,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function startServer(port: number, repos: RepoInfo[]): void {
  currentRepos = repos;
  registerRoutes();
  const webDist = join(__dirname, "..", "web", "dist");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;
    const query = url.searchParams;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    // API routes
    for (const route of routes) {
      if (req.method !== route.method) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      try {
        if (req.method === "POST") {
          const bodyStr = await readBody(req);
          req.__body = bodyStr ? JSON.parse(bodyStr) : {};
        }
        await route.handler(req, res, params, query);
      } catch (err) {
        json(res, { error: (err as Error).message }, 500);
      }
      return;
    }

    // Static file serving (production)
    if (existsSync(webDist)) {
      const filePath = join(webDist, pathname === "/" ? "index.html" : pathname);
      if (serveStatic(res, filePath)) return;
      // SPA fallback
      if (!pathname.startsWith("/api")) {
        serveStatic(res, join(webDist, "index.html"));
        return;
      }
    }

    json(res, { error: "Not found" }, 404);
  });

  server.listen(port, () => {
    console.log(`  WebUI: http://localhost:${port}\n`);
  });
}

export function getBody<T>(req: IncomingMessage): T {
  return req.__body as T;
}

export { addRoute, clearRoutes, json };
