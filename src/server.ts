import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { notifyFixJobComplete } from "./push.js";
import { registerRoutes } from "./api.js";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";
import type { RepoInfo } from "./discovery.js";
import { getRateLimitState, getGitHubRequestStatsSnapshot } from "./exec.js";
import { getRawSqlite, openStateDatabase } from "./db/client.js";
import { getFixQueue } from "./fix-queue.js";
import type { TicketIssue } from "./tickets/types.js";
import type { LinkMap } from "./tickets/linker.js";
import { getLinearRequestStatsSnapshot } from "./tickets/stats.js";

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

/** Port the HTTP server is listening on (for config UI vs saved `config.port`). */
let listenPort = 3100;

export function getListenPort(): number {
  return listenPort;
}

let onConfigSaved: (() => void | Promise<void>) | null = null;

/** CLI registers this so `POST /api/config` can rediscover repos and reschedule polling. */
export function setConfigSavedHandler(handler: (() => void | Promise<void>) | null): void {
  onConfigSaved = handler;
}

export function notifyConfigSaved(): void {
  void Promise.resolve(onConfigSaved?.()).catch((e) => {
    console.error("Config reload failed:", (e as Error).message);
  });
}

let onManualPoll: (() => void | Promise<void>) | null = null;

/** CLI registers this so the web UI / curl can run the same poll as hotkey [r]. */
export function setManualPollHandler(handler: (() => void | Promise<void>) | null): void {
  onManualPoll = handler;
}

/** Fire one full poll (GitHub + tickets + coherence). @returns false if no handler (e.g. demo server). */
export function triggerManualPoll(): boolean {
  if (!onManualPoll) return false;
  void Promise.resolve(onManualPoll()).catch((e) => {
    console.error("Manual poll failed:", (e as Error).message);
  });
  return true;
}

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
  /** Config floor (minutes → ms); `intervalMs` may be larger when rate-limit aware. */
  baseIntervalMs: 0,
  estimatedPollRequests: 0,
  pollBudgetNote: null as string | null,
  polling: false,
  /** Last top-level poll failure (outer catch in `cli.ts`); cleared on success. */
  lastPollError: null as string | null,
  /** True when poll is paused because >=80% of API quota is consumed. */
  pollPaused: false,
  pollPausedReason: null as string | null,
};

type CounterSample = { at: number; total: number };
type RequestRateSummary = {
  actualRpm: number;
  actualRph: number;
  predictedRpm: number;
  predictedRph: number;
};

const githubCounterHistory: CounterSample[] = [];
const linearCounterHistory: CounterSample[] = [];
const COUNTER_HISTORY_MAX = 30;
const COUNTER_IDLE_SAMPLE_MS = 5_000;

function recordCounterSample(history: CounterSample[], now: number, total: number): void {
  const last = history.length > 0 ? history[history.length - 1] : null;
  if (last && total < last.total) {
    history.length = 0; // process reset / counter reset
  }
  const freshLast = history.length > 0 ? history[history.length - 1] : null;
  if (!freshLast) {
    history.push({ at: now, total });
    return;
  }
  const changed = total !== freshLast.total;
  const idleTick = now - freshLast.at >= COUNTER_IDLE_SAMPLE_MS;
  if (!changed && !idleTick) return;
  history.push({ at: now, total });
  if (history.length > COUNTER_HISTORY_MAX) {
    history.splice(0, history.length - COUNTER_HISTORY_MAX);
  }
}

function summarizeCounterRates(history: CounterSample[]): RequestRateSummary {
  if (history.length < 2) {
    return { actualRpm: 0, actualRph: 0, predictedRpm: 0, predictedRph: 0 };
  }
  const deltas: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!;
    const cur = history[i]!;
    const dt = Math.max(1, cur.at - prev.at);
    const dc = Math.max(0, cur.total - prev.total);
    deltas.push((dc * 60_000) / dt);
  }
  const actualRpm = deltas[deltas.length - 1] ?? 0;
  const recent = deltas.slice(-6);
  const predictedRpm = recent.length > 0
    ? recent.reduce((sum, v) => sum + v, 0) / recent.length
    : 0;
  return {
    actualRpm,
    actualRph: actualRpm * 60,
    predictedRpm,
    predictedRph: predictedRpm * 60,
  };
}

function getRequestStatsSnapshot(now = Date.now()) {
  const githubRequestStats = getGitHubRequestStatsSnapshot();
  const linearRequestStats = getLinearRequestStatsSnapshot();
  recordCounterSample(githubCounterHistory, now, githubRequestStats.total);
  recordCounterSample(linearCounterHistory, now, linearRequestStats.total);
  return {
    at: now,
    githubRequestStats,
    linearRequestStats,
    githubRequestRates: summarizeCounterRates(githubCounterHistory),
    linearRequestRates: summarizeCounterRates(linearCounterHistory),
  };
}

// --- Claude/AI usage tracking ---
let claudeActiveEvals = 0;
let claudeActiveFixJobs = 0;
let claudeEvalConcurrencyCap = 2;
let claudeTotalEvalsThisSession = 0;
let claudeTotalFixesThisSession = 0;

export function updateClaudeStats(stats: {
  activeEvals?: number;
  activeFixJobs?: number;
  evalConcurrencyCap?: number;
  evalStarted?: boolean;
  evalFinished?: boolean;
  fixStarted?: boolean;
  fixFinished?: boolean;
}): void {
  if (stats.activeEvals !== undefined) claudeActiveEvals = stats.activeEvals;
  if (stats.activeFixJobs !== undefined) claudeActiveFixJobs = stats.activeFixJobs;
  if (stats.evalConcurrencyCap !== undefined) claudeEvalConcurrencyCap = stats.evalConcurrencyCap;
  if (stats.evalStarted) { claudeActiveEvals++; claudeTotalEvalsThisSession++; }
  if (stats.evalFinished) { claudeActiveEvals = Math.max(0, claudeActiveEvals - 1); }
  if (stats.fixStarted) { claudeActiveFixJobs++; claudeTotalFixesThisSession++; }
  if (stats.fixFinished) { claudeActiveFixJobs = Math.max(0, claudeActiveFixJobs - 1); }
}

export function getClaudeStats() {
  return {
    activeEvals: claudeActiveEvals,
    activeFixJobs: claudeActiveFixJobs,
    evalConcurrencyCap: claudeEvalConcurrencyCap,
    totalEvalsThisSession: claudeTotalEvalsThisSession,
    totalFixesThisSession: claudeTotalFixesThisSession,
  };
}
/** Push current poll/fix-job snapshot to all SSE clients (see `poll-status` event). */
export function broadcastPollStatus(): void {
  sseBroadcast("poll-status", { status: getPollState() });
}

export function updatePollState(state: {
  lastPoll?: number;
  nextPoll?: number;
  intervalMs?: number;
  baseIntervalMs?: number;
  estimatedPollRequests?: number;
  pollBudgetNote?: string | null;
  polling?: boolean;
  lastPollError?: string | null;
  /** True when poll is paused because >=80% of API quota is consumed. */
  pollPaused?: boolean;
  pollPausedReason?: string | null;
}): void {
  Object.assign(pollState, state);
  broadcastPollStatus();
}

export interface FixJobStatus {
  commentId: number;
  repo: string;
  prNumber: number;
  path: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "no_changes" | "awaiting_response";
  error?: string;
  diff?: string;
  branch?: string;
  claudeOutput?: string;
  sessionId?: string;
  conversation?: Array<{ role: "claude" | "user"; message: string }>;
  suggestedReply?: string;
}

const fixJobStatuses = new Map<number, FixJobStatus>();

interface SseClient {
  res: ServerResponse;
  keepAlive: ReturnType<typeof setInterval>;
}

const sseClients = new Set<SseClient>();

export function sseBroadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      clearInterval(client.keepAlive);
      sseClients.delete(client);
    }
  }
}

// Separate high-frequency telemetry stream for stats UI.
setInterval(() => {
  if (sseClients.size === 0) return;
  sseBroadcast("request-stats", getRequestStatsSnapshot());
}, 5_000);

/** Long-lived SSE stream for instant poll / fix-job hints (browser uses EventSource). */
export function subscribeSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("\n");

  try {
    const snapshot = getPollState();
    res.write(`event: poll-status\ndata: ${JSON.stringify({ status: snapshot })}\n\n`);
  } catch {
    /* connection may have closed immediately */
  }

  const client: SseClient = {
    res,
    keepAlive: setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(client.keepAlive);
        sseClients.delete(client);
      }
    }, 25_000),
  };
  sseClients.add(client);
  // New clients miss prior `ticket-status` broadcasts; nudge them to load ticket sidebar state.
  try {
    res.write(`event: ticket-status\ndata: ${JSON.stringify({ updated: true })}\n\n`);
  } catch {
    clearInterval(client.keepAlive);
    sseClients.delete(client);
  }

  req.on("close", () => {
    clearInterval(client.keepAlive);
    sseClients.delete(client);
  });
}

function persistFixJobResult(job: FixJobStatus): void {
  openStateDatabase();
  const sqlite = getRawSqlite();
  sqlite.prepare(
    `INSERT INTO fix_job_results (comment_id, status_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(comment_id) DO UPDATE SET status_json = excluded.status_json, updated_at = excluded.updated_at`,
  ).run(job.commentId, JSON.stringify(job), new Date().toISOString());
}

function removePersistedFixJobResult(commentId: number): void {
  openStateDatabase();
  const sqlite = getRawSqlite();
  sqlite.prepare("DELETE FROM fix_job_results WHERE comment_id = ?").run(commentId);
}

export function loadPersistedFixJobResults(): void {
  openStateDatabase();
  const sqlite = getRawSqlite();
  const rows = sqlite.prepare("SELECT status_json FROM fix_job_results").all() as Array<{ status_json: string }>;
  for (const row of rows) {
    try {
      const job = JSON.parse(row.status_json) as FixJobStatus;
      fixJobStatuses.set(job.commentId, job);
    } catch { /* ignore corrupt rows */ }
  }
}

export function setFixJobStatus(job: FixJobStatus): void {
  fixJobStatuses.set(job.commentId, job);
  try { persistFixJobResult(job); } catch { /* don't block SSE on DB write failure */ }
  sseBroadcast("fix-job", {
    commentId: job.commentId,
    repo: job.repo,
    prNumber: job.prNumber,
    status: job.status,
    path: job.path,
    error: job.error,
    sessionId: job.sessionId,
    conversation: job.conversation,
    suggestedReply: job.suggestedReply,
    claudeOutput: job.claudeOutput,
  });
  broadcastPollStatus();
  if (job.status === "completed" || job.status === "failed") {
    notifyFixJobComplete({
      repo: job.repo,
      prNumber: job.prNumber,
      commentId: job.commentId,
      path: job.path,
      status: job.status,
      error: job.error,
    });
  }
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
  try { removePersistedFixJobResult(commentId); } catch { /* ignore */ }
  broadcastPollStatus();
}

export function getFixJobStatus(commentId: number): FixJobStatus | undefined {
  return fixJobStatuses.get(commentId);
}

export function getAllFixJobStatuses(): FixJobStatus[] {
  return Array.from(fixJobStatuses.values());
}

interface TicketState {
  myIssues: TicketIssue[];
  repoLinkedIssues: TicketIssue[];
  linkMap: LinkMap;
}

const ticketState: TicketState = {
  myIssues: [],
  repoLinkedIssues: [],
  linkMap: { ticketToPRs: new Map(), prToTickets: new Map() },
};

export function updateTicketState(state: Partial<TicketState>): void {
  Object.assign(ticketState, state);
  sseBroadcast("ticket-status", { updated: true });
}

export function getTicketState(): TicketState {
  return ticketState;
}

export interface HealthPayload {
  status: "ok";
  uptimeMs: number;
  repos: number;
  polling: boolean;
  lastPollWallClockMs: number;
  nextPoll: number;
  intervalMs: number;
  baseIntervalMs: number;
  estimatedPollRequests: number;
  estimatedGithubRequestsPerHour: number;
  pollBudgetNote: string | null;
  lastPollError: string | null;
  rateLimit: {
    limited: boolean;
    resetAt: number | null;
    remaining: number | null;
    limit: number | null;
    resource: string | null;
    updatedAt: number;
  };
  fixJobsRunning: number;
}

export function getPollState() {
  const rl = getRateLimitState();
  const eff = pollState.intervalMs;
  const perPoll = pollState.estimatedPollRequests ?? 0;
  const reqStats = getRequestStatsSnapshot();
  const estimatedGithubRequestsPerHour =
    eff > 0 && perPoll > 0 ? Math.round((3600000 / eff) * perPoll) : 0;
  return {
    ...pollState,
    estimatedGithubRequestsPerHour,
    fixJobs: Array.from(fixJobStatuses.values()),
    fixQueue: getFixQueue().map((q) => ({
      commentId: q.commentId,
      repo: q.repo,
      prNumber: q.prNumber,
      path: q.path,
      branch: q.branch,
      position: q.position,
      queuedAt: q.queuedAt,
    })),
    pollPaused: pollState.pollPaused ?? false,
    pollPausedReason: pollState.pollPausedReason ?? null,
    rateLimited: rl.limited,
    rateLimitResetAt: rl.resetAt,
    rateLimitRemaining: rl.remaining,
    rateLimitLimit: rl.limit,
    rateLimitResource: rl.resource,
    rateLimitUpdatedAt: rl.updatedAt,
    claude: getClaudeStats(),
    githubRequestStats: reqStats.githubRequestStats,
    linearRequestStats: reqStats.linearRequestStats,
    githubRequestRates: reqStats.githubRequestRates,
    linearRequestRates: reqStats.linearRequestRates,
  };
}

/** Snapshot for `GET /api/health` — does not consume the one-shot test-notification flag. */
export function getHealthPayload(): HealthPayload {
  const ps = getPollState();
  return {
    status: "ok",
    uptimeMs: Date.now() - serverStartedAt,
    repos: getRepos().length,
    polling: ps.polling,
    lastPollWallClockMs: ps.lastPoll,
    nextPoll: ps.nextPoll,
    intervalMs: ps.intervalMs,
    baseIntervalMs: ps.baseIntervalMs,
    estimatedPollRequests: ps.estimatedPollRequests,
    estimatedGithubRequestsPerHour: ps.estimatedGithubRequestsPerHour,
    pollBudgetNote: ps.pollBudgetNote,
    lastPollError: pollState.lastPollError,
    rateLimit: {
      limited: ps.rateLimited,
      resetAt: ps.rateLimitResetAt,
      remaining: ps.rateLimitRemaining ?? null,
      limit: ps.rateLimitLimit ?? null,
      resource: ps.rateLimitResource ?? null,
      updatedAt: ps.rateLimitUpdatedAt ?? 0,
    },
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
  listenPort = port;
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
