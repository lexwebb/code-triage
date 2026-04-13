import { addRoute, json, getRepos, getBody, getPollState, setFixJobStatus, clearFixJobStatus } from "./server.js";
import { loadState, markComment, saveState, addFixJob as addFixJobState, removeFixJob as removeFixJobState, getFixJobs } from "./state.js";
import { postReply, resolveThread, applyFixWithClaude } from "./actioner.js";
import { createWorktree, getWorktreePath, getDiffInWorktree, removeWorktree, commitAndPushWorktree } from "./worktree.js";
import { ghAsync, ghGraphQL, ghPost } from "./exec.js";

async function getResolvedCommentIds(repoPath: string, prNumber: number): Promise<Set<number>> {
  const [owner, repo] = repoPath.split("/");

  const data = await ghGraphQL<{
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: Array<{
            isResolved: boolean;
            comments: { nodes: Array<{ databaseId: number }> };
          }> };
        };
      };
    };
  }>(
    `query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              isResolved
              comments(first: 100) {
                nodes { databaseId }
              }
            }
          }
        }
      }
    }`,
    { owner, repo, prNumber },
  );

  const threads = data.data.repository.pullRequest.reviewThreads.nodes;
  const resolvedIds = new Set<number>();
  for (const thread of threads) {
    if (thread.isResolved) {
      for (const comment of thread.comments.nodes) {
        resolvedIds.add(comment.databaseId);
      }
    }
  }
  return resolvedIds;
}

async function getUsername(): Promise<string> {
  const user = await ghAsync<{ login: string }>("/user");
  return user.login;
}

function requireRepo(query: URLSearchParams): string {
  const repo = query.get("repo");
  if (!repo) throw new Error("Missing required ?repo= query parameter");
  const repos = getRepos();
  if (!repos.some((r) => r.repo === repo)) {
    throw new Error(`Repo "${repo}" is not tracked`);
  }
  return repo;
}

interface GhPull {
  number: number;
  title: string;
  user: { login: string; avatar_url: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  requested_reviewers: Array<{ login: string; avatar_url: string }>;
  mergeable_state: string;
}

interface GhCombinedStatus {
  state: "success" | "failure" | "pending" | "error";
}

async function getPrStatus(repoPath: string, sha: string): Promise<"success" | "failure" | "pending"> {
  try {
    const status = await ghAsync<GhCombinedStatus>(`/repos/${repoPath}/commits/${sha}/status`);
    if (status.state === "success") return "success";
    if (status.state === "failure" || status.state === "error") return "failure";
  } catch { /* ignore */ }
  return "pending";
}

async function getOpenCommentCount(repoPath: string, prNumber: number): Promise<number> {
  const resolvedIds = await getResolvedCommentIds(repoPath, prNumber);
  try {
    interface GhComment { id: number; user: { login: string }; in_reply_to_id: number | null; }
    const comments = await ghAsync<GhComment[]>(`/repos/${repoPath}/pulls/${prNumber}/comments`);
    return comments.filter((c) => c.in_reply_to_id === null && !resolvedIds.has(c.id)).length;
  } catch {
    return 0;
  }
}

export function registerRoutes(): void {

  // GET /api/user
  addRoute("GET", "/api/user", async (_req, res) => {
    const user = await ghAsync<{ login: string; avatar_url: string; html_url: string }>("/user");
    json(res, { login: user.login, avatarUrl: user.avatar_url, url: user.html_url });
  });

  // GET /api/repos
  addRoute("GET", "/api/repos", (_req, res) => {
    json(res, getRepos());
  });

  // GET /api/pulls?repo=owner/repo (optional — if omitted, returns all)
  addRoute("GET", "/api/pulls", async (_req, res, _params, query) => {
    const username = await getUsername();
    const repoFilter = query.get("repo");
    const targetRepos = repoFilter
      ? getRepos().filter((r) => r.repo === repoFilter)
      : getRepos();

    const allPulls: Array<Record<string, unknown>> = [];

    for (const repoInfo of targetRepos) {
      try {
        const pulls = await ghAsync<GhPull[]>(`/repos/${repoInfo.repo}/pulls?state=open`);
        const myPulls = pulls.filter((pr) => pr.user.login === username);

        for (const pr of myPulls) {
          const [checksStatus, openComments] = await Promise.all([
            getPrStatus(repoInfo.repo, pr.head.sha),
            getOpenCommentCount(repoInfo.repo, pr.number),
          ]);
          allPulls.push({
            number: pr.number,
            title: pr.title,
            author: pr.user.login,
            authorAvatar: pr.user.avatar_url,
            branch: pr.head.ref,
            baseBranch: pr.base.ref,
            url: pr.html_url,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            draft: pr.draft,
            repo: repoInfo.repo,
            checksStatus,
            openComments,
          });
        }
      } catch {
        // Skip repos that fail (e.g., no access)
      }
    }

    json(res, allPulls);
  });

  // GET /api/pulls/review-requested?repo=owner/repo (optional)
  addRoute("GET", "/api/pulls/review-requested", async (_req, res, _params, query) => {
    const username = await getUsername();
    const repoFilter = query.get("repo");
    const targetRepos = repoFilter
      ? getRepos().filter((r) => r.repo === repoFilter)
      : getRepos();

    const reviewPulls: Array<Record<string, unknown>> = [];

    for (const repoInfo of targetRepos) {
      try {
        const pulls = await ghAsync<GhPull[]>(`/repos/${repoInfo.repo}/pulls?state=open`);
        const needsReview = pulls.filter((pr) =>
          pr.user.login !== username &&
          pr.requested_reviewers.some((r) => r.login === username),
        );

        for (const pr of needsReview) {
          const [checksStatus, openComments] = await Promise.all([
            getPrStatus(repoInfo.repo, pr.head.sha),
            getOpenCommentCount(repoInfo.repo, pr.number),
          ]);
          reviewPulls.push({
            number: pr.number,
            title: pr.title,
            author: pr.user.login,
            authorAvatar: pr.user.avatar_url,
            branch: pr.head.ref,
            baseBranch: pr.base.ref,
            url: pr.html_url,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            draft: pr.draft,
            repo: repoInfo.repo,
            checksStatus,
            openComments,
          });
        }
      } catch {
        // Skip repos that fail
      }
    }

    json(res, reviewPulls);
  });

  // GET /api/pulls/:number?repo=owner/repo
  addRoute("GET", "/api/pulls/:number", async (_req, res, params, query) => {
    const repo = requireRepo(query);
    const prNumber = parseInt(params.number, 10);

    const pr = await ghAsync<{
      number: number;
      title: string;
      body: string;
      user: { login: string; avatar_url: string };
      head: { ref: string };
      base: { ref: string };
      html_url: string;
      created_at: string;
      updated_at: string;
      draft: boolean;
      additions: number;
      deletions: number;
      changed_files: number;
      requested_reviewers: Array<{ login: string; avatar_url: string }>;
    }>(`/repos/${repo}/pulls/${prNumber}`);

    // Fetch reviews to get each reviewer's latest state
    interface GhReview {
      user: { login: string; avatar_url: string };
      state: string;
      submitted_at: string;
    }
    const reviews = await ghAsync<GhReview[]>(`/repos/${repo}/pulls/${prNumber}/reviews`);

    const reviewerMap = new Map<string, { login: string; avatar: string; state: string }>();

    for (const r of pr.requested_reviewers) {
      reviewerMap.set(r.login, { login: r.login, avatar: r.avatar_url, state: "PENDING" });
    }

    for (const r of reviews) {
      if (r.state === "COMMENTED" || r.state === "DISMISSED") {
        if (!reviewerMap.has(r.user.login)) {
          reviewerMap.set(r.user.login, { login: r.user.login, avatar: r.user.avatar_url, state: r.state });
        }
        continue;
      }
      reviewerMap.set(r.user.login, { login: r.user.login, avatar: r.user.avatar_url, state: r.state });
    }

    json(res, {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.user.login,
      authorAvatar: pr.user.avatar_url,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      draft: pr.draft,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      repo,
      reviewers: Array.from(reviewerMap.values()),
    });
  });

  // GET /api/pulls/:number/files?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/files", async (_req, res, params, query) => {
    const repo = requireRepo(query);

    interface GhFile {
      sha: string;
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }

    const files = await ghAsync<GhFile[]>(`/repos/${repo}/pulls/${params.number}/files`);

    json(res, files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || "",
    })));
  });

  // GET /api/pulls/:number/comments?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/comments", async (_req, res, params, query) => {
    const repo = requireRepo(query);
    const prNumber = parseInt(params.number, 10);

    interface GhComment {
      id: number;
      user: { login: string; avatar_url: string };
      path: string;
      line: number | null;
      original_line: number | null;
      diff_hunk: string;
      body: string;
      created_at: string;
      in_reply_to_id: number | null;
    }

    const [comments, resolvedIds] = await Promise.all([
      ghAsync<GhComment[]>(`/repos/${repo}/pulls/${prNumber}/comments`),
      getResolvedCommentIds(repo, prNumber),
    ]);

    const state = loadState();

    json(res, comments.map((c) => {
      const stateKey = `${repo}:${c.id}`;
      const record = state.comments[stateKey];
      return {
        id: c.id,
        author: c.user.login,
        authorAvatar: c.user.avatar_url,
        path: c.path,
        line: c.line || c.original_line || 0,
        diffHunk: c.diff_hunk,
        body: c.body,
        createdAt: c.created_at,
        inReplyToId: c.in_reply_to_id ?? null,
        isResolved: resolvedIds.has(c.id),
        evaluation: record?.evaluation ?? null,
        crStatus: record?.status ?? null,
      };
    }));
  });

  // GET /api/pulls/:number/files/*path?repo=owner/repo (full file content)
  addRoute("GET", "/api/pulls/:number/files/*path", async (_req, res, params, query) => {
    const repo = requireRepo(query);
    const pr = await ghAsync<{ head: { ref: string } }>(`/repos/${repo}/pulls/${params.number}`);
    const filePath = params.path;

    try {
      const file = await ghAsync<{ content: string }>(`/repos/${repo}/contents/${filePath}?ref=${pr.head.ref}`);
      const decoded = Buffer.from(file.content, "base64").toString("utf-8");
      json(res, { content: decoded, path: filePath });
    } catch {
      json(res, { error: "File not found" }, 404);
    }
  });

  // GET /api/state
  addRoute("GET", "/api/state", (_req, res) => {
    json(res, loadState());
  });

  // GET /api/poll-status
  addRoute("GET", "/api/poll-status", (_req, res) => {
    json(res, getPollState());
  });

  // POST /api/actions/reply
  addRoute("POST", "/api/actions/reply", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];

    if (!record?.evaluation?.reply) {
      json(res, { error: "No reply text in evaluation" }, 400);
      return;
    }

    await postReply(body.repo, body.prNumber, body.commentId, record.evaluation.reply);
    await resolveThread(body.repo, body.commentId, body.prNumber, undefined);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "replied" });
  });

  // POST /api/actions/resolve
  addRoute("POST", "/api/actions/resolve", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];

    await resolveThread(body.repo, body.commentId, body.prNumber, record?.evaluation?.reply);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "replied" });
  });

  // POST /api/actions/dismiss
  addRoute("POST", "/api/actions/dismiss", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number }>(req);
    const state = loadState();
    markComment(state, body.commentId, "dismissed", body.prNumber, body.repo);
    saveState(state);
    json(res, { success: true, status: "dismissed" });
  });

  // POST /api/actions/fix — create worktree, run Claude, return diff
  addRoute("POST", "/api/actions/fix", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number; branch: string; comment: { path: string; line: number; body: string; diffHunk: string } }>(req);

    // Prevent concurrent fixes on the same branch
    const state = loadState();
    const existingJob = getFixJobs(state).find((j) => j.branch === body.branch);
    if (existingJob) {
      json(res, { error: `A fix is already in progress on branch ${body.branch} (${existingJob.path})` }, 409);
      return;
    }

    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) {
      json(res, { error: "Repo local path not found" }, 400);
      return;
    }

    let worktreePath: string;
    try {
      worktreePath = createWorktree(body.branch, repoInfo.localPath);
    } catch (err) {
      json(res, { error: `Failed to create worktree: ${(err as Error).message}` }, 500);
      return;
    }

    // Persist job to disk and track in memory
    const jobRecord = {
      commentId: body.commentId,
      repo: body.repo,
      prNumber: body.prNumber,
      branch: body.branch,
      path: body.comment.path,
      worktreePath,
      startedAt: new Date().toISOString(),
    };
    addFixJobState(state, jobRecord);
    saveState(state);

    setFixJobStatus({
      commentId: body.commentId,
      repo: body.repo,
      prNumber: body.prNumber,
      path: body.comment.path,
      startedAt: Date.now(),
      status: "running",
    });

    // Respond immediately — the fix runs async, frontend polls for status
    json(res, { success: true, status: "running", branch: body.branch });

    // Run Claude in background
    try {
      await applyFixWithClaude(worktreePath, body.comment);
      const diff = getDiffInWorktree(worktreePath);

      if (!diff.trim()) {
        removeWorktree(body.branch, repoInfo?.localPath);
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
          path: body.comment.path, startedAt: Date.now(), status: "failed",
          error: "Claude made no changes",
        });
        return;
      }

      // Mark completed with diff — keep worktree for apply/discard
      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        path: body.comment.path, startedAt: Date.now(), status: "completed",
        diff, branch: body.branch,
      });
    } catch (err) {
      removeWorktree(body.branch, repoInfo?.localPath);
      const s = loadState();
      removeFixJobState(s, body.commentId);
      saveState(s);
      setFixJobStatus({
        commentId: body.commentId, repo: body.repo, prNumber: body.prNumber,
        path: body.comment.path, startedAt: Date.now(), status: "failed",
        error: (err as Error).message,
      });
    }
  });

  // POST /api/actions/fix-apply — commit and push worktree changes
  addRoute("POST", "/api/actions/fix-apply", async (req, res) => {
    const body = getBody<{ repo: string; commentId: number; prNumber: number; branch: string }>(req);
    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) {
      json(res, { error: "Repo local path not found" }, 400);
      return;
    }

    try {
      const worktreePath = getWorktreePath(body.branch, repoInfo.localPath);
      const commitMsg = `fix: apply CodeRabbit suggestion for PR #${body.prNumber}`;
      commitAndPushWorktree(worktreePath, commitMsg);
      removeWorktree(body.branch, repoInfo?.localPath);

      const state = loadState();
      markComment(state, body.commentId, "fixed", body.prNumber, body.repo);
      saveState(state);
      clearFixJobStatus(body.commentId);

      json(res, { success: true, status: "fixed" });
    } catch (err) {
      json(res, { error: `Push failed: ${(err as Error).message}` }, 500);
    }
  });

  // POST /api/actions/fix-discard — discard worktree
  addRoute("POST", "/api/actions/fix-discard", async (req, res) => {
    const body = getBody<{ branch: string; repo?: string; commentId?: number }>(req);
    const discardRepoInfo = body.repo ? getRepos().find((r) => r.repo === body.repo) : undefined;
    try {
      removeWorktree(body.branch, discardRepoInfo?.localPath);
    } catch { /* ignore */ }
    if (body.commentId) clearFixJobStatus(body.commentId);
    json(res, { success: true });
  });

  // GET /api/fix-jobs/recover — check for stale fix jobs from a previous session
  addRoute("GET", "/api/fix-jobs/recover", (_req, res) => {
    const state = loadState();
    const staleJobs = getFixJobs(state);
    const results: Array<{ job: typeof staleJobs[0]; hasDiff: boolean; diff?: string }> = [];

    for (const job of staleJobs) {
      try {
        const diff = getDiffInWorktree(job.worktreePath);
        results.push({ job, hasDiff: !!diff.trim(), diff: diff.trim() || undefined });
      } catch {
        // Worktree no longer exists — clean up
        removeFixJobState(state, job.commentId);
      }
    }

    saveState(state);
    json(res, results);
  });

  // POST /api/actions/review — submit a PR review (approve or request changes)
  addRoute("POST", "/api/actions/review", async (req, res) => {
    const body = getBody<{ repo: string; prNumber: number; event: "APPROVE" | "REQUEST_CHANGES"; body?: string }>(req);
    try {
      await ghPost(`/repos/${body.repo}/pulls/${body.prNumber}/reviews`, {
        event: body.event,
        body: body.body || "",
      });
      json(res, { success: true });
    } catch (err) {
      json(res, { error: `Review failed: ${(err as Error).message}` }, 500);
    }
  });
}
