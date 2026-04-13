import { execFileSync } from "child_process";
import type { CrComment, PrInfo, PollResult } from "./types.js";
import { ghAsync } from "./exec.js";
import { loadConfig } from "./config.js";
import {
  batchPullPollData,
  batchPullPollDataForRepos,
  fetchOpenPullRequestsForRepos,
  type OpenPull,
  type PullPollData,
} from "./github-batching.js";

/** PRs to scan for new review comments: yours when `pollReviewRequested` is off; yours plus review-requested when on. */
export function selectPollPulls(pulls: OpenPull[], username: string, pollReviewRequested: boolean): OpenPull[] {
  const authored = pulls.filter((pr) => pr.user.login === username);
  if (!pollReviewRequested) {
    return authored;
  }
  const reviewRequested = pulls.filter(
    (pr) =>
      pr.user.login !== username &&
      (pr.requested_reviewers ?? []).some((r) => r.login === username),
  );
  const byNum = new Map<number, OpenPull>();
  for (const pr of authored) {
    byNum.set(pr.number, pr);
  }
  for (const pr of reviewRequested) {
    byNum.set(pr.number, pr);
  }
  return Array.from(byNum.values());
}

export function getRepoFromGit(): string {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf-8",
  }).trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) throw new Error(`Cannot parse GitHub repo from remote: ${remote}`);
  return match[1];
}

/** One GET /user — call once per poll cycle and pass into `fetchNewComments` / batch flows. */
export async function getGitHubLogin(): Promise<string> {
  const user = await ghAsync<{ login: string }>("/user");
  return user.login;
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

function buildPollResultForRepo(
  repoPath: string,
  targetPulls: OpenPull[],
  pollByPr: Map<number, PullPollData>,
  ignoredBots: Set<string>,
  isNewComment: (repo: string, commentId: number) => boolean,
): PollResult {
  const allNewComments: CrComment[] = [];
  const pullsByNumber: Record<number, PrInfo> = {};

  for (const pr of targetPulls) {
    pullsByNumber[pr.number] = {
      number: pr.number,
      title: pr.title,
      branch: pr.head.ref,
      url: pr.html_url,
    };

    const poll = pollByPr.get(pr.number);
    const comments = poll?.comments ?? [];
    const resolvedIds = poll?.resolvedIds ?? new Set<number>();
    const relevantComments = filterCommentsForPoll(comments, resolvedIds, ignoredBots, (id) =>
      isNewComment(repoPath, id),
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

/**
 * Poll all tracked repos with batched GraphQL (open PRs + review thread data). Falls back to per-repo REST
 * or single-repo GraphQL if a batch fails.
 */
export async function fetchNewCommentsBatch(
  repoPaths: string[],
  isNewComment: (repo: string, commentId: number) => boolean,
  pollReviewRequested: boolean,
  githubLogin?: string,
): Promise<Map<string, PollResult>> {
  const username = githubLogin ?? (await getGitHubLogin());
  const config = loadConfig();
  const ignoredBots = buildIgnoredBotSet(config.ignoredBots);

  let pullsByRepo: Map<string, OpenPull[]>;
  try {
    pullsByRepo = (await fetchOpenPullRequestsForRepos(repoPaths)).pullsByRepo;
  } catch (e) {
    console.error("\n  Batched open-PR GraphQL failed, using per-repo REST:", (e as Error).message);
    pullsByRepo = new Map();
    for (const rp of repoPaths) {
      try {
        pullsByRepo.set(rp, await ghAsync<OpenPull[]>(`/repos/${rp}/pulls?state=open`, rp));
      } catch {
        pullsByRepo.set(rp, []);
      }
    }
  }

  const targetByRepo = new Map<string, OpenPull[]>();
  const pollEntries: Array<{ repoPath: string; prNumbers: number[] }> = [];

  for (const repoPath of repoPaths) {
    const pulls = pullsByRepo.get(repoPath) ?? [];
    const targetPulls = selectPollPulls(pulls, username, pollReviewRequested);
    targetByRepo.set(repoPath, targetPulls);
    if (targetPulls.length > 0) {
      pollEntries.push({ repoPath, prNumbers: targetPulls.map((p) => p.number) });
    }
  }

  let pollData: Map<string, Map<number, PullPollData>>;
  try {
    pollData = pollEntries.length === 0 ? new Map() : await batchPullPollDataForRepos(pollEntries);
  } catch (e) {
    console.error("\n  Batched PR review GraphQL failed, using per-repo requests:", (e as Error).message);
    pollData = new Map();
    for (const pe of pollEntries) {
      try {
        pollData.set(pe.repoPath, await batchPullPollData(pe.repoPath, pe.prNumbers));
      } catch {
        const empty = new Map<number, PullPollData>();
        for (const n of pe.prNumbers) {
          empty.set(n, { resolvedIds: new Set(), comments: [], hasHumanApproval: false });
        }
        pollData.set(pe.repoPath, empty);
      }
    }
  }

  const out = new Map<string, PollResult>();
  for (const repoPath of repoPaths) {
    const targetPulls = targetByRepo.get(repoPath) ?? [];
    const pollByPr = pollData.get(repoPath) ?? new Map();
    out.set(
      repoPath,
      buildPollResultForRepo(repoPath, targetPulls, pollByPr, ignoredBots, isNewComment),
    );
  }
  return out;
}

/**
 * @param githubLogin — pass from `getGitHubLogin()` once per poll so multi-repo runs do not call GET /user per repo.
 */
export async function fetchNewComments(
  repo: string | undefined,
  isNewComment: (id: number) => boolean,
  pollReviewRequested = false,
  githubLogin?: string,
): Promise<PollResult> {
  const repoPath = repo || getRepoFromGit();
  const m = await fetchNewCommentsBatch(
    [repoPath],
    (r, id) => r === repoPath && isNewComment(id),
    pollReviewRequested,
    githubLogin,
  );
  return m.get(repoPath) ?? { comments: [], pullsByNumber: {} };
}
