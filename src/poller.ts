import { execFileSync } from "child_process";
import type { CrComment, PrInfo, PollResult } from "./types.js";
import { execAsync, ghAsync, ghGraphQL } from "./exec.js";

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

export function getRepoFromGit(): string {
  // This one stays sync — only called once at startup
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf-8",
  }).trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitHub repo from remote: ${remote}`);
  return match[1];
}

async function getCurrentUser(): Promise<string> {
  const result = await execAsync("gh", ["api", "/user", "--jq", ".login"], { timeout: 10000 });
  return result.trim();
}

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

const IGNORED_BOTS = new Set([
  "vercel[bot]", "netlify[bot]", "codecov[bot]", "codecov-commenter",
  "sonarcloud[bot]", "sonarqube[bot]", "dependabot[bot]", "renovate[bot]",
  "github-actions[bot]", "sentry-io[bot]", "changeset-bot[bot]",
  "gitpod-io[bot]", "stale[bot]", "linear[bot]",
]);

export async function fetchNewComments(
  repo: string | undefined,
  isNewComment: (id: number) => boolean,
): Promise<PollResult> {
  const repoPath = repo || getRepoFromGit();
  const username = await getCurrentUser();

  const pulls = await ghAsync<GhPull[]>(`/repos/${repoPath}/pulls?state=open`);
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

    const [comments, resolvedIds] = await Promise.all([
      ghAsync<GhComment[]>(`/repos/${repoPath}/pulls/${pr.number}/comments`),
      getResolvedCommentIds(repoPath, pr.number),
    ]);

    const relevantComments = comments.filter(
      (c) => !IGNORED_BOTS.has(c.user.login) && isNewComment(c.id) && !resolvedIds.has(c.id),
    );

    for (const comment of relevantComments) {
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
