import { execFileSync } from "child_process";
import type { CrComment, PrInfo, PollResult } from "./types.js";

interface GhPull {
  number: number;
  title: string;
  user: { login: string };
  head: { ref: string };
  html_url: string;
}

interface GhComment {
  id: number;
  user: { login: string };
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  body: string;
  in_reply_to_id: number | null;
}

interface GhThreadNode {
  isResolved: boolean;
  comments: {
    nodes: Array<{ databaseId: number }>;
  };
}

function ghApi<T>(endpoint: string): T {
  const result = execFileSync("gh", ["api", endpoint, "--paginate"], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return JSON.parse(result) as T;
}

export function getRepoFromGit(): string {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf-8",
  }).trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitHub repo from remote: ${remote}`);
  return match[1];
}

function getCurrentUser(): string {
  return execFileSync("gh", ["api", "/user", "--jq", ".login"], {
    encoding: "utf-8",
    timeout: 10000,
  }).trim();
}

function getResolvedCommentIds(repoPath: string, prNumber: number): Set<number> {
  const [owner, repo] = repoPath.split("/");
  const query = JSON.stringify({
    query: `query($owner: String!, $repo: String!, $prNumber: Int!) {
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
    variables: { owner, repo, prNumber },
  });

  const result = execFileSync("gh", ["api", "graphql", "--input", "-"], {
    encoding: "utf-8",
    timeout: 30000,
    input: query,
  });

  const data = JSON.parse(result) as {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: GhThreadNode[] };
        };
      };
    };
  };

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

export async function fetchNewComments(
  repo: string | undefined,
  isNewComment: (id: number) => boolean,
): Promise<PollResult> {
  const repoPath = repo || getRepoFromGit();
  const username = getCurrentUser();

  const pulls = ghApi<GhPull[]>(`/repos/${repoPath}/pulls?state=open`);
  const myPulls = pulls.filter((pr) => pr.user.login === username);

  if (myPulls.length === 0) {
    return { comments: [], pullsByNumber: {} };
  }

  const allNewComments: CrComment[] = [];
  const pullsByNumber: Record<number, PrInfo> = {};

  for (const pr of myPulls) {
    pullsByNumber[pr.number] = {
      number: pr.number,
      title: pr.title,
      branch: pr.head.ref,
      url: pr.html_url,
    };

    const comments = ghApi<GhComment[]>(`/repos/${repoPath}/pulls/${pr.number}/comments`);
    const resolvedIds = getResolvedCommentIds(repoPath, pr.number);

    const crComments = comments.filter(
      (c) => c.user.login === "coderabbitai[bot]" && isNewComment(c.id) && !resolvedIds.has(c.id),
    );

    for (const comment of crComments) {
      allNewComments.push({
        id: comment.id,
        prNumber: pr.number,
        path: comment.path,
        line: comment.line || comment.original_line || 0,
        diffHunk: comment.diff_hunk,
        body: comment.body,
        inReplyToId: comment.in_reply_to_id,
      });
    }
  }

  return { comments: allNewComments, pullsByNumber };
}
