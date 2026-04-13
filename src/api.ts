import { execFileSync } from "child_process";
import { addRoute, json } from "./server.js";
import { loadState } from "./state.js";

let repoPath = "";

function gh<T>(endpoint: string): T {
  const result = execFileSync("gh", ["api", endpoint, "--paginate"], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return JSON.parse(result) as T;
}

export function registerRoutes(repo: string): void {
  repoPath = repo;

  // GET /api/user
  addRoute("GET", "/api/user", (_req, res) => {
    const result = execFileSync("gh", ["api", "/user"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const user = JSON.parse(result) as { login: string; avatar_url: string; html_url: string };
    json(res, { login: user.login, avatarUrl: user.avatar_url, url: user.html_url });
  });

  // GET /api/pulls
  addRoute("GET", "/api/pulls", (_req, res) => {
    const username = execFileSync("gh", ["api", "/user", "--jq", ".login"], {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    interface GhPull {
      number: number;
      title: string;
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
    }

    const pulls = gh<GhPull[]>(`/repos/${repoPath}/pulls?state=open`);
    const myPulls = pulls.filter((pr) => pr.user.login === username);

    const result = myPulls.map((pr) => ({
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
    }));

    json(res, result);
  });

  // GET /api/pulls/:number
  addRoute("GET", "/api/pulls/:number", (_req, res, params) => {
    const pr = gh<{
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
    }>(`/repos/${repoPath}/pulls/${params.number}`);

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
    });
  });

  // GET /api/pulls/:number/files
  addRoute("GET", "/api/pulls/:number/files", (_req, res, params) => {
    interface GhFile {
      sha: string;
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }

    const files = gh<GhFile[]>(`/repos/${repoPath}/pulls/${params.number}/files`);

    json(res, files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || "",
    })));
  });

  // GET /api/pulls/:number/comments
  addRoute("GET", "/api/pulls/:number/comments", (_req, res, params) => {
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

    const comments = gh<GhComment[]>(`/repos/${repoPath}/pulls/${params.number}/comments`);

    json(res, comments.map((c) => ({
      id: c.id,
      author: c.user.login,
      authorAvatar: c.user.avatar_url,
      path: c.path,
      line: c.line || c.original_line || 0,
      diffHunk: c.diff_hunk,
      body: c.body,
      createdAt: c.created_at,
      inReplyToId: c.in_reply_to_id,
    })));
  });

  // GET /api/pulls/:number/files/*path (full file content)
  addRoute("GET", "/api/pulls/:number/files/*path", (_req, res, params) => {
    const pr = gh<{ head: { ref: string } }>(`/repos/${repoPath}/pulls/${params.number}`);
    const filePath = params.path;

    try {
      const content = execFileSync(
        "gh",
        ["api", `/repos/${repoPath}/contents/${filePath}?ref=${pr.head.ref}`, "--jq", ".content"],
        { encoding: "utf-8", timeout: 15000 },
      ).trim();

      const decoded = Buffer.from(content, "base64").toString("utf-8");
      json(res, { content: decoded, path: filePath });
    } catch {
      json(res, { error: "File not found" }, 404);
    }
  });

  // GET /api/state
  addRoute("GET", "/api/state", (_req, res) => {
    json(res, loadState());
  });
}
