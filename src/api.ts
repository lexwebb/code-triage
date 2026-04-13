import { execFileSync } from "child_process";
import { addRoute, json, getRepos } from "./server.js";
import { loadState } from "./state.js";

function gh<T>(endpoint: string): T {
  const result = execFileSync("gh", ["api", endpoint, "--paginate"], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return JSON.parse(result) as T;
}

function getUsername(): string {
  return execFileSync("gh", ["api", "/user", "--jq", ".login"], {
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
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

export function registerRoutes(): void {

  // GET /api/user
  addRoute("GET", "/api/user", (_req, res) => {
    const result = execFileSync("gh", ["api", "/user"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const user = JSON.parse(result) as { login: string; avatar_url: string; html_url: string };
    json(res, { login: user.login, avatarUrl: user.avatar_url, url: user.html_url });
  });

  // GET /api/repos
  addRoute("GET", "/api/repos", (_req, res) => {
    json(res, getRepos());
  });

  // GET /api/pulls?repo=owner/repo (optional — if omitted, returns all)
  addRoute("GET", "/api/pulls", (_req, res, _params, query) => {
    const username = getUsername();
    const repoFilter = query.get("repo");
    const targetRepos = repoFilter
      ? getRepos().filter((r) => r.repo === repoFilter)
      : getRepos();

    const allPulls: Array<Record<string, unknown>> = [];

    for (const repoInfo of targetRepos) {
      try {
        const pulls = gh<GhPull[]>(`/repos/${repoInfo.repo}/pulls?state=open`);
        const myPulls = pulls.filter((pr) => pr.user.login === username);

        for (const pr of myPulls) {
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
          });
        }
      } catch {
        // Skip repos that fail (e.g., no access)
      }
    }

    json(res, allPulls);
  });

  // GET /api/pulls/:number?repo=owner/repo
  addRoute("GET", "/api/pulls/:number", (_req, res, params, query) => {
    const repo = requireRepo(query);
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
    }>(`/repos/${repo}/pulls/${params.number}`);

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
    });
  });

  // GET /api/pulls/:number/files?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/files", (_req, res, params, query) => {
    const repo = requireRepo(query);

    interface GhFile {
      sha: string;
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }

    const files = gh<GhFile[]>(`/repos/${repo}/pulls/${params.number}/files`);

    json(res, files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || "",
    })));
  });

  // GET /api/pulls/:number/comments?repo=owner/repo
  addRoute("GET", "/api/pulls/:number/comments", (_req, res, params, query) => {
    const repo = requireRepo(query);

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

    const comments = gh<GhComment[]>(`/repos/${repo}/pulls/${params.number}/comments`);

    json(res, comments.map((c) => ({
      id: c.id,
      author: c.user.login,
      authorAvatar: c.user.avatar_url,
      path: c.path,
      line: c.line || c.original_line || 0,
      diffHunk: c.diff_hunk,
      body: c.body,
      createdAt: c.created_at,
      inReplyToId: c.in_reply_to_id ?? null,
    })));
  });

  // GET /api/pulls/:number/files/*path?repo=owner/repo (full file content)
  addRoute("GET", "/api/pulls/:number/files/*path", (_req, res, params, query) => {
    const repo = requireRepo(query);
    const pr = gh<{ head: { ref: string } }>(`/repos/${repo}/pulls/${params.number}`);
    const filePath = params.path;

    try {
      const content = execFileSync(
        "gh",
        ["api", `/repos/${repo}/contents/${filePath}?ref=${pr.head.ref}`, "--jq", ".content"],
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
