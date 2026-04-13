import { startServer, addRoute, clearRoutes, json, subscribeSse } from "./server.js";
import type { RepoInfo } from "./discovery.js";

const DEMO_REPOS: RepoInfo[] = [
  { repo: "acme-corp/web-app", localPath: "/Users/demo/src/web-app" },
  { repo: "acme-corp/api-server", localPath: "/Users/demo/src/api-server" },
  { repo: "acme-corp/mobile-app", localPath: "/Users/demo/src/mobile-app" },
];

const DEMO_USER = { login: "lexwebb", avatarUrl: "https://avatars.githubusercontent.com/u/5765602?v=4", url: "https://github.com/lexwebb" };

const DEMO_PULLS = [
  {
    number: 142, title: "Add user authentication with OAuth2", author: "lexwebb",
    authorAvatar: DEMO_USER.avatarUrl, branch: "feat/oauth2-auth", baseBranch: "main",
    url: "https://github.com/acme-corp/web-app/pull/142",
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 3600000).toISOString(),
    draft: false, repo: "acme-corp/web-app",
    checksStatus: "success", openComments: 3, hasHumanApproval: false,
  },
  {
    number: 87, title: "Migrate database to PostgreSQL 16", author: "lexwebb",
    authorAvatar: DEMO_USER.avatarUrl, branch: "feat/pg16-migration", baseBranch: "main",
    url: "https://github.com/acme-corp/api-server/pull/87",
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 7200000).toISOString(),
    draft: false, repo: "acme-corp/api-server",
    checksStatus: "success", openComments: 0, hasHumanApproval: true,
  },
  {
    number: 215, title: "Fix race condition in WebSocket reconnection", author: "lexwebb",
    authorAvatar: DEMO_USER.avatarUrl, branch: "fix/ws-reconnect", baseBranch: "main",
    url: "https://github.com/acme-corp/web-app/pull/215",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 1800000).toISOString(),
    draft: false, repo: "acme-corp/web-app",
    checksStatus: "failure", openComments: 1, hasHumanApproval: false,
  },
];

const DEMO_REVIEW_PULLS = [
  {
    number: 56, title: "Add rate limiting middleware", author: "sarahdev",
    authorAvatar: "https://i.pravatar.cc/40?u=sarah", branch: "feat/rate-limit", baseBranch: "main",
    url: "https://github.com/acme-corp/api-server/pull/56",
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 5400000).toISOString(),
    draft: false, repo: "acme-corp/api-server",
    checksStatus: "success", openComments: 2, hasHumanApproval: false,
  },
];

const DEMO_PR_DETAIL = {
  ...DEMO_PULLS[0],
  body: "Implements OAuth2 authentication flow with support for Google and GitHub providers.\n\n## Changes\n- Add OAuth2 provider abstraction\n- Implement Google OAuth2 flow\n- Implement GitHub OAuth2 flow\n- Add session management\n- Add tests",
  additions: 847, deletions: 123, changedFiles: 12,
  reviewers: [
    { login: "sarahdev", avatar: "https://i.pravatar.cc/40?u=sarah", state: "CHANGES_REQUESTED" },
    { login: "mikecode", avatar: "https://i.pravatar.cc/40?u=mike", state: "PENDING" },
  ],
};

const DEMO_FILES = [
  { filename: "src/auth/oauth2.ts", status: "added", additions: 245, deletions: 0, patch: `@@ -0,0 +1,245 @@\n+import { OAuth2Client } from './client';\n+import { TokenStore } from './store';\n+import type { AuthProvider, AuthToken } from './types';\n+\n+export class OAuth2Provider implements AuthProvider {\n+  private client: OAuth2Client;\n+  private store: TokenStore;\n+\n+  constructor(config: OAuth2Config) {\n+    this.client = new OAuth2Client(config);\n+    this.store = new TokenStore();\n+  }\n+\n+  async authenticate(code: string): Promise<AuthToken> {\n+    const token = await this.client.exchangeCode(code);\n+    await this.store.save(token);\n+    return token;\n+  }\n+\n+  async refresh(token: AuthToken): Promise<AuthToken> {\n+    if (!token.refreshToken) {\n+      throw new Error('No refresh token available');\n+    }\n+    const newToken = await this.client.refresh(token.refreshToken);\n+    await this.store.save(newToken);\n+    return newToken;\n+  }\n+\n+  async revoke(token: AuthToken): Promise<void> {\n+    await this.client.revoke(token.accessToken);\n+    await this.store.delete(token.id);\n+  }\n+}` },
  { filename: "src/auth/session.ts", status: "added", additions: 89, deletions: 0, patch: `@@ -0,0 +1,89 @@\n+import { randomBytes } from 'crypto';\n+import type { Session, SessionStore } from './types';\n+\n+export class SessionManager {\n+  private store: SessionStore;\n+  private ttl: number;\n+\n+  constructor(store: SessionStore, ttlMs = 86400000) {\n+    this.store = store;\n+    this.ttl = ttlMs;\n+  }\n+\n+  async create(userId: string): Promise<Session> {\n+    const session: Session = {\n+      id: randomBytes(32).toString('hex'),\n+      userId,\n+      createdAt: Date.now(),\n+      expiresAt: Date.now() + this.ttl,\n+    };\n+    await this.store.set(session.id, session);\n+    return session;\n+  }\n+}` },
  { filename: "src/auth/middleware.ts", status: "added", additions: 67, deletions: 0, patch: `@@ -0,0 +1,67 @@\n+import type { Request, Response, NextFunction } from 'express';\n+import { SessionManager } from './session';\n+\n+export function authMiddleware(sessions: SessionManager) {\n+  return async (req: Request, res: Response, next: NextFunction) => {\n+    const token = req.headers.authorization?.replace('Bearer ', '');\n+    if (!token) {\n+      res.status(401).json({ error: 'Missing authorization header' });\n+      return;\n+    }\n+\n+    const session = await sessions.validate(token);\n+    if (!session) {\n+      res.status(401).json({ error: 'Invalid or expired session' });\n+      return;\n+    }\n+\n+    req.user = session.userId;\n+    next();\n+  };\n+}` },
  { filename: "src/auth/types.ts", status: "added", additions: 34, deletions: 0, patch: `@@ -0,0 +1,34 @@\n+export interface AuthToken {\n+  id: string;\n+  accessToken: string;\n+  refreshToken?: string;\n+  expiresAt: number;\n+  provider: string;\n+}\n+\n+export interface AuthProvider {\n+  authenticate(code: string): Promise<AuthToken>;\n+  refresh(token: AuthToken): Promise<AuthToken>;\n+  revoke(token: AuthToken): Promise<void>;\n+}` },
  { filename: "tests/auth/oauth2.test.ts", status: "added", additions: 156, deletions: 0, patch: `@@ -0,0 +1,156 @@\n+import { describe, it, expect, vi } from 'vitest';\n+import { OAuth2Provider } from '../../src/auth/oauth2';\n+\n+describe('OAuth2Provider', () => {\n+  it('should exchange code for token', async () => {\n+    const provider = new OAuth2Provider(mockConfig);\n+    const token = await provider.authenticate('test-code');\n+    expect(token.accessToken).toBeDefined();\n+  });\n+});` },
];

const DEMO_COMMENTS = [
  {
    id: 1001, author: "coderabbitai[bot]",
    authorAvatar: "https://avatars.githubusercontent.com/in/347564?v=4",
    path: "src/auth/oauth2.ts", line: 18,
    diffHunk: `@@ -0,0 +1,245 @@\n+  async authenticate(code: string): Promise<AuthToken> {\n+    const token = await this.client.exchangeCode(code);\n+    await this.store.save(token);\n+    return token;\n+  }`,
    body: "**\u26a0\ufe0f Potential issue**\n\nThe `authenticate` method doesn't validate the authorization code before exchanging it. Consider adding input validation to prevent empty or malformed codes from reaching the OAuth provider.\n\n```typescript\nasync authenticate(code: string): Promise<AuthToken> {\n  if (!code || code.length < 10) {\n    throw new Error('Invalid authorization code');\n  }\n  const token = await this.client.exchangeCode(code);\n  await this.store.save(token);\n  return token;\n}\n```",
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    inReplyToId: null, isResolved: false,
    evaluation: { action: "fix" as const, summary: "Valid concern — add input validation for the auth code" },
    crStatus: "pending" as const,
  },
  {
    id: 1002, author: "coderabbitai[bot]",
    authorAvatar: "https://avatars.githubusercontent.com/in/347564?v=4",
    path: "src/auth/session.ts", line: 14,
    diffHunk: `@@ -0,0 +1,89 @@\n+  async create(userId: string): Promise<Session> {\n+    const session: Session = {\n+      id: randomBytes(32).toString('hex'),\n+      userId,\n+      createdAt: Date.now(),\n+      expiresAt: Date.now() + this.ttl,\n+    };`,
    body: "**\ud83d\udca1 Suggestion**\n\nConsider using `crypto.randomUUID()` instead of `randomBytes(32).toString('hex')` for session IDs. It's more readable and produces standard UUIDs.\n\n```diff\n- id: randomBytes(32).toString('hex'),\n+ id: crypto.randomUUID(),\n```",
    createdAt: new Date(Date.now() - 5400000).toISOString(),
    inReplyToId: null, isResolved: false,
    evaluation: { action: "reply" as const, summary: "Style preference — randomBytes is fine for session IDs", reply: "Thanks for the suggestion! We're using `randomBytes` here intentionally as it produces a longer, more entropy-dense ID compared to UUID v4. For session tokens, the extra entropy is preferred." },
    crStatus: "pending" as const,
  },
  {
    id: 1003, author: "coderabbitai[bot]",
    authorAvatar: "https://avatars.githubusercontent.com/in/347564?v=4",
    path: "src/auth/middleware.ts", line: 7,
    diffHunk: `@@ -0,0 +1,67 @@\n+export function authMiddleware(sessions: SessionManager) {\n+  return async (req: Request, res: Response, next: NextFunction) => {\n+    const token = req.headers.authorization?.replace('Bearer ', '');`,
    body: "**\ud83d\udd34 Critical**\n\n<details>\n<summary>\ud83e\udde9 Analysis chain</summary>\n\nThe `replace('Bearer ', '')` only removes the first occurrence and doesn't validate the format. A malicious header like `Bearer Bearer malicious` would pass `Bearer malicious` as the token.\n\n</details>\n\nUse a regex or proper parsing:\n\n```typescript\nconst match = req.headers.authorization?.match(/^Bearer\\s+(.+)$/);\nconst token = match?.[1];\n```",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    inReplyToId: null, isResolved: false,
    evaluation: { action: "fix" as const, summary: "Security fix — improper Bearer token parsing could allow injection" },
    crStatus: "pending" as const,
  },
  {
    id: 1004, author: "sarahdev",
    authorAvatar: "https://i.pravatar.cc/40?u=sarah",
    path: "src/auth/oauth2.ts", line: 28,
    diffHunk: `@@ -0,0 +1,245 @@\n+  async revoke(token: AuthToken): Promise<void> {\n+    await this.client.revoke(token.accessToken);\n+    await this.store.delete(token.id);\n+  }`,
    body: "Should we also revoke the refresh token here? If only the access token is revoked, the refresh token could still be used to get a new access token.",
    createdAt: new Date(Date.now() - 1800000).toISOString(),
    inReplyToId: null, isResolved: false,
    evaluation: { action: "fix" as const, summary: "Good catch — revoke should also invalidate the refresh token" },
    crStatus: "pending" as const,
  },
  {
    id: 1005, author: "coderabbitai[bot]",
    authorAvatar: "https://avatars.githubusercontent.com/in/347564?v=4",
    path: "tests/auth/oauth2.test.ts", line: 5,
    diffHunk: `@@ -0,0 +1,156 @@\n+describe('OAuth2Provider', () => {\n+  it('should exchange code for token', async () => {`,
    body: "**\u2705 Good job**\n\nTest coverage looks solid for the happy path. Consider adding tests for error cases (expired code, network failure, invalid response).",
    createdAt: new Date(Date.now() - 900000).toISOString(),
    inReplyToId: null, isResolved: true,
    evaluation: { action: "resolve" as const, summary: "Informational — no action needed", reply: "Thanks! Will add error case tests in a follow-up." },
    crStatus: "replied" as const,
  },
];

const DEMO_FIX_JOBS = [
  {
    commentId: 1003, repo: "acme-corp/web-app", prNumber: 142,
    path: "src/auth/middleware.ts", startedAt: Date.now() - 45000,
    status: "completed" as const, branch: "feat/oauth2-auth",
    diff: `diff --git a/src/auth/middleware.ts b/src/auth/middleware.ts\nindex 1234567..abcdefg 100644\n--- a/src/auth/middleware.ts\n+++ b/src/auth/middleware.ts\n@@ -4,7 +4,8 @@ import { SessionManager } from './session';\n export function authMiddleware(sessions: SessionManager) {\n   return async (req: Request, res: Response, next: NextFunction) => {\n-    const token = req.headers.authorization?.replace('Bearer ', '');\n+    const match = req.headers.authorization?.match(/^Bearer\\s+(.+)$/);\n+    const token = match?.[1];\n     if (!token) {\n       res.status(401).json({ error: 'Missing authorization header' });\n       return;`,
    claudeOutput: "I've updated the Bearer token parsing in the auth middleware to use a regex match instead of string replace. This prevents malformed headers from passing through.",
  },
];

export function startDemoServer(port: number): void {
  // Start server (registers real routes + static serving)
  startServer(port, DEMO_REPOS);

  // Clear real routes and register demo data routes
  clearRoutes();
  addRoute("GET", "/api/user", (_req, res) => {
    json(res, DEMO_USER);
  });

  addRoute("GET", "/api/repos", (_req, res) => {
    json(res, DEMO_REPOS);
  });

  addRoute("GET", "/api/pulls", (_req, res) => {
    json(res, DEMO_PULLS);
  });

  addRoute("GET", "/api/pulls/review-requested", (_req, res) => {
    json(res, DEMO_REVIEW_PULLS);
  });

  addRoute("GET", "/api/pulls/:number", (_req, res, params) => {
    const num = parseInt(params.number, 10);
    const pr = DEMO_PULLS.find((p) => p.number === num);
    if (pr) {
      json(res, { ...DEMO_PR_DETAIL, ...pr });
    } else {
      json(res, { error: "Not found" }, 404);
    }
  });

  addRoute("GET", "/api/pulls/:number/files", (_req, res) => {
    json(res, DEMO_FILES);
  });

  addRoute("GET", "/api/pulls/:number/comments", (_req, res) => {
    json(res, DEMO_COMMENTS);
  });

  addRoute("GET", "/api/state", (_req, res) => {
    json(res, { lastPoll: new Date().toISOString(), comments: {} });
  });

  addRoute("GET", "/api/health", (_req, res) => {
    json(res, {
      status: "ok",
      uptimeMs: 60_000,
      repos: DEMO_REPOS.length,
      polling: false,
      lastPollWallClockMs: Date.now() - 30_000,
      nextPoll: Date.now() + 30_000,
      intervalMs: 60_000,
      lastPollError: null,
      rateLimit: { limited: false, resetAt: null },
      fixJobsRunning: 0,
      persistedLastPoll: new Date().toISOString(),
    });
  });

  addRoute("GET", "/api/events", (req, res) => {
    subscribeSse(req, res);
  });

  addRoute("GET", "/api/poll-status", (_req, res) => {
    json(res, {
      lastPoll: Date.now() - 30000,
      nextPoll: Date.now() + 30000,
      intervalMs: 60000,
      polling: false,
      fixJobs: DEMO_FIX_JOBS,
    });
  });

  // No-op action endpoints for demo
  addRoute("POST", "/api/actions/reply", (_req, res) => { json(res, { success: true, status: "replied" }); });
  addRoute("POST", "/api/actions/resolve", (_req, res) => { json(res, { success: true, status: "replied" }); });
  addRoute("POST", "/api/actions/dismiss", (_req, res) => { json(res, { success: true, status: "dismissed" }); });
  addRoute("POST", "/api/actions/fix", (_req, res) => { json(res, { success: true, status: "running", branch: "demo" }); });
  addRoute("POST", "/api/actions/fix-apply", (_req, res) => { json(res, { success: true, status: "fixed" }); });
  addRoute("POST", "/api/actions/fix-discard", (_req, res) => { json(res, { success: true }); });
  addRoute("POST", "/api/actions/review", (_req, res) => { json(res, { success: true }); });
}
