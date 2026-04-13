import { execFileSync } from "child_process";
import type { CrComment, PrInfo, PollResult } from "./types.js";
import { ghAsync, ghGraphQL } from "./exec.js";
import { loadConfig } from "./config.js";

interface GhPull {
  number: number;
  title: string;
  user: { login: string };
  head: { ref: string };
  html_url: string;
  requested_reviewers: Array<{ login: string }>;
}

/** PRs to scan for new review comments: yours when `pollReviewRequested` is off; yours plus review-requested when on. */
export function selectPollPulls(pulls: GhPull[], username: string, pollReviewRequested: boolean): GhPull[] {
  const authored = pulls.filter((pr) => pr.user.login === username);
  if (!pollReviewRequested) {
    return authored;
  }
  const reviewRequested = pulls.filter(
    (pr) =>
      pr.user.login !== username &&
      (pr.requested_reviewers ?? []).some((r) => r.login === username),
  );
  const byNum = new Map<number, GhPull>();
  for (const pr of authored) {
    byNum.set(pr.number, pr);
  }
  for (const pr of reviewRequested) {
    byNum.set(pr.number, pr);
  }
  return Array.from(byNum.values());
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
  const user = await ghAsync<{ login: string }>("/user");
  return user.login;
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

/** Built-in ignored bots plus optional config entries (for tests and `fetchNewComments`). */
export function buildIgnoredBotSet(configIgnored?: string[]): Set<string> {
  return new Set([...IGNORED_BOTS, ...(configIgnored ?? [])]);
}

/** Pure filter: new top-level review comments worth triaging. */
export function filterCommentsForPoll<T extends { id: number; user: { login: string } }>(
  comments: T[],
  resolvedIds: Set<number>,
  ignoredBots: Set<string>,
  isNewComment: (id: number) => boolean,
): T[] {
  return comments.filter(
    (c) => !ignoredBots.has(c.user.login) && isNewComment(c.id) && !resolvedIds.has(c.id),
  );
}

export async function fetchNewComments(
  repo: string | undefined,
  isNewComment: (id: number) => boolean,
  pollReviewRequested = false,
): Promise<PollResult> {
  const repoPath = repo || getRepoFromGit();
  const username = await getCurrentUser();

  const pulls = await ghAsync<GhPull[]>(`/repos/${repoPath}/pulls?state=open`);
  const targetPulls = selectPollPulls(pulls, username, pollReviewRequested);

  if (targetPulls.length === 0) {
    return { comments: [], pullsByNumber: {} };
  }

  const allNewComments: CrComment[] = [];
  const pullsByNumber: Record<number, PrInfo> = {};

  for (const pr of targetPulls) {
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

    const config = loadConfig();
    const ignoredBots = buildIgnoredBotSet(config.ignoredBots);
    const relevantComments = filterCommentsForPoll(comments, resolvedIds, ignoredBots, isNewComment);

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
