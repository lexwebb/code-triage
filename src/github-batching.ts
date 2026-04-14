import { ghGraphQL, partitionEntriesByToken, partitionRepoPathsByToken } from "./exec.js";
import { getRawSqlite, openStateDatabase } from "./db/client.js";

/** Open PRs per repo in one GraphQL round-trip chunk. */
const REPO_LIST_CHUNK = 8;
/** Max pull-request poll subgraphs per GraphQL request (complexity budget). */
const GLOBAL_PR_CHUNK = 6;

function parseRepoPath(repoPath: string): { owner: string; name: string } {
  const [owner, name] = repoPath.split("/");
  if (!owner || !name || name.includes("/")) {
    throw new Error(`Invalid repo path: ${repoPath}`);
  }
  if (!/^[\w.-]+$/i.test(owner) || !/^[\w.-]+$/i.test(name)) {
    throw new Error(`Invalid repo path: ${repoPath}`);
  }
  return { owner, name };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** GitHub GraphQL `RepositoryPermission` values that imply push (write) access. */
export function isRepositoryWritePermission(permission: string | null | undefined): boolean {
  return permission === "ADMIN" || permission === "MAINTAIN" || permission === "WRITE";
}

/** Same shape as REST `GET /repos/.../pulls?state=open` (used by poller). */
export interface OpenPull {
  number: number;
  title: string;
  user: { login: string };
  head: { ref: string };
  html_url: string;
  requested_reviewers: Array<{ login: string }>;
}

/** Result of open-PR listing; `writableRepoPaths` is repos where the token may push. */
export interface FetchOpenPullsResult {
  pullsByRepo: Map<string, OpenPull[]>;
  writableRepoPaths: Set<string>;
}

let openPullsCache: { key: string; at: number; result: FetchOpenPullsResult } | null = null;
/**
 * Dedupes overlapping open-PR GraphQL: (1) exact key match, (2) superset reuse — discovery/filter
 * often fetches all repos, then the poller asks for an adaptive subset (different cache key) seconds later.
 */
const OPEN_PULLS_CACHE_TTL_MS = 60_000;

export function sliceOpenPullsResult(full: FetchOpenPullsResult, repoPaths: string[]): FetchOpenPullsResult {
  const pullsByRepo = new Map<string, OpenPull[]>();
  const writableRepoPaths = new Set<string>();
  for (const rp of repoPaths) {
    pullsByRepo.set(rp, full.pullsByRepo.get(rp) ?? []);
    if (full.writableRepoPaths.has(rp)) writableRepoPaths.add(rp);
  }
  return { pullsByRepo, writableRepoPaths };
}

function cacheCoversRepos(cached: FetchOpenPullsResult, repoPaths: string[]): boolean {
  return repoPaths.length > 0 && repoPaths.every((rp) => cached.pullsByRepo.has(rp));
}

/** Vitest: avoid leaking cached GraphQL results across tests. */
export function resetOpenPullsCacheForTests(): void {
  openPullsCache = null;
}

/**
 * Keeps only repos the authenticated token may push to (excludes read-only forks, public clones
 * without collaborator access, etc.). Uses the same batched GraphQL as `fetchOpenPullRequestsForRepos`
 * (viewerPermission + open PRs in one request per chunk).
 */
export async function filterRepoPathsWithPushAccess(repoPaths: string[]): Promise<string[]> {
  const { writableRepoPaths } = await fetchOpenPullRequestsForRepos(repoPaths);
  savePushAccessCache(repoPaths, writableRepoPaths);
  return repoPaths.filter((rp) => writableRepoPaths.has(rp));
}

const PUSH_ACCESS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Reads cached push-access results from SQLite. Returns the filtered repo list if ALL
 * requested repos have a non-expired cache entry, or `null` on cache miss (any repo
 * missing or expired).
 */
export function loadCachedPushAccess(repoPaths: string[]): string[] | null {
  if (repoPaths.length === 0) return [];
  openStateDatabase();
  const sqlite = getRawSqlite();
  const stmt = sqlite.prepare("SELECT has_push, checked_at FROM repo_access WHERE repo = ?");
  const now = Date.now();
  const allowed: string[] = [];
  for (const rp of repoPaths) {
    const row = stmt.get(rp) as { has_push: number; checked_at: number } | undefined;
    if (!row || now - row.checked_at > PUSH_ACCESS_CACHE_TTL_MS) {
      return null; // cache miss — at least one repo is missing or expired
    }
    if (row.has_push) allowed.push(rp);
  }
  return allowed;
}

/** Persists push-access results so dev-mode restarts can skip the GitHub API call. */
export function savePushAccessCache(repoPaths: string[], writableSet: Set<string>): void {
  openStateDatabase();
  const sqlite = getRawSqlite();
  const upsert = sqlite.prepare(
    "INSERT INTO repo_access (repo, has_push, checked_at) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET has_push = excluded.has_push, checked_at = excluded.checked_at",
  );
  const now = Date.now();
  const run = sqlite.transaction(() => {
    for (const rp of repoPaths) {
      upsert.run(rp, writableSet.has(rp) ? 1 : 0, now);
    }
  });
  run();
}

type GqlOpenPullNode = {
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  headRefName: string;
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login?: string } | null }>;
  } | null;
};

function gqlOpenPullToOpenPull(node: GqlOpenPullNode): OpenPull {
  const reviewers: Array<{ login: string }> = [];
  for (const rn of node.reviewRequests?.nodes ?? []) {
    const login = rn.requestedReviewer?.login;
    if (login) reviewers.push({ login });
  }
  return {
    number: node.number,
    title: node.title,
    user: { login: node.author?.login ?? "ghost" },
    head: { ref: node.headRefName },
    html_url: node.url,
    requested_reviewers: reviewers,
  };
}

async function fetchOpenPullRequestsForReposUncached(repoPaths: string[]): Promise<FetchOpenPullsResult> {
  const pullsByRepo = new Map<string, OpenPull[]>();
  const writableRepoPaths = new Set<string>();
  if (repoPaths.length === 0) return { pullsByRepo, writableRepoPaths };

  const pathGroups = partitionRepoPathsByToken(repoPaths);
  for (const group of pathGroups) {
    const tokenRepo = group[0];
    for (let off = 0; off < group.length; off += REPO_LIST_CHUNK) {
      const chunk = group.slice(off, off + REPO_LIST_CHUNK);
      const layout: Array<{ alias: string; repoPath: string }> = [];
      const blocks: string[] = [];
      chunk.forEach((rp, j) => {
        const { owner, name } = parseRepoPath(rp);
        const alias = `o${j}`;
        layout.push({ alias, repoPath: rp });
        blocks.push(`${alias}: repository(owner: "${owner}", name: "${name}") {
          viewerPermission
          pullRequests(states: OPEN, first: 100) {
            nodes {
              number
              title
              url
              author { login }
              headRefName
              reviewRequests(first: 40) {
                nodes {
                  requestedReviewer {
                    ... on User { login }
                  }
                }
              }
            }
          }
        }`);
      });
      const query = `query { ${blocks.join("\n")} }`;
      const data = await ghGraphQL<
        Record<
          string,
          | {
              viewerPermission?: string;
              pullRequests: { nodes: GqlOpenPullNode[] } | null;
            }
          | null
        >
      >(query, {}, tokenRepo);

      for (const { alias, repoPath } of layout) {
        const node = data[alias];
        if (!node || !isRepositoryWritePermission(node.viewerPermission)) {
          pullsByRepo.set(repoPath, []);
          continue;
        }
        writableRepoPaths.add(repoPath);
        const nodes = node.pullRequests?.nodes ?? [];
        pullsByRepo.set(repoPath, nodes.map(gqlOpenPullToOpenPull));
      }
    }
  }
  return { pullsByRepo, writableRepoPaths };
}

/**
 * Lists open pull requests for many repos via batched GraphQL (replaces N REST `GET .../pulls?state=open`).
 * Includes `viewerPermission` so the same request powers push-access filtering without a second round trip.
 * TTL + superset slicing avoid a second identical GraphQL batch when adaptive polling requests a subset
 * right after discovery (or any recent full-repo fetch).
 */
export async function fetchOpenPullRequestsForRepos(repoPaths: string[]): Promise<FetchOpenPullsResult> {
  if (repoPaths.length === 0) {
    return { pullsByRepo: new Map(), writableRepoPaths: new Set() };
  }
  const key = [...repoPaths].sort().join("\0");
  const now = Date.now();
  if (
    openPullsCache &&
    openPullsCache.key === key &&
    now - openPullsCache.at < OPEN_PULLS_CACHE_TTL_MS
  ) {
    return {
      pullsByRepo: new Map(openPullsCache.result.pullsByRepo),
      writableRepoPaths: new Set(openPullsCache.result.writableRepoPaths),
    };
  }
  if (
    openPullsCache &&
    now - openPullsCache.at < OPEN_PULLS_CACHE_TTL_MS &&
    cacheCoversRepos(openPullsCache.result, repoPaths)
  ) {
    return sliceOpenPullsResult(openPullsCache.result, repoPaths);
  }
  const result = await fetchOpenPullRequestsForReposUncached(repoPaths);
  openPullsCache = {
    key,
    at: now,
    result: {
      pullsByRepo: new Map(result.pullsByRepo),
      writableRepoPaths: new Set(result.writableRepoPaths),
    },
  };
  return {
    pullsByRepo: new Map(result.pullsByRepo),
    writableRepoPaths: new Set(result.writableRepoPaths),
  };
}

/** REST-shaped review comment (poller + web API). */
export interface PullReviewCommentRow {
  id: number;
  user: { login: string; avatar_url?: string };
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  body: string;
  in_reply_to_id: number | null;
  html_url?: string;
  created_at?: string;
}

type GqlComment = {
  databaseId: number;
  author: { login: string; avatarUrl?: string } | null;
  body: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffHunk: string;
  replyTo: { databaseId: number } | null;
  createdAt: string;
  url: string;
};

function gqlCommentToRow(c: GqlComment): PullReviewCommentRow {
  return {
    id: c.databaseId,
    user: {
      login: c.author?.login ?? "ghost",
      avatar_url: c.author?.avatarUrl,
    },
    path: c.path,
    line: c.line,
    original_line: c.originalLine,
    diff_hunk: c.diffHunk,
    body: c.body,
    in_reply_to_id: c.replyTo?.databaseId ?? null,
    html_url: c.url,
    created_at: c.createdAt,
  };
}

export type PullPollData = {
  resolvedIds: Set<number>;
  comments: PullReviewCommentRow[];
  hasHumanApproval: boolean;
};

type PrPollNode = {
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      comments: { nodes: GqlComment[] };
    }>;
  } | null;
  reviews: { nodes: Array<{ state: string; author: { login: string } | null }> } | null;
};

const PULL_POLL_FIELDS = `
  reviewThreads(first: 100) {
    nodes {
      isResolved
      comments(first: 100) {
        nodes {
          databaseId
          author {
            login
            ... on User { avatarUrl }
          }
          body
          path
          line
          originalLine
          diffHunk
          replyTo { databaseId }
          createdAt
          url
        }
      }
    }
  }
  reviews(first: 100) {
    nodes { state author { login } }
  }
`;

function mergePrPollIntoMap(
  entry: PullPollData,
  pr: PrPollNode | null | undefined,
): void {
  if (!pr) return;
  const threads = pr.reviewThreads?.nodes ?? [];
  for (const thread of threads) {
    const nodes = thread.comments?.nodes ?? [];
    for (const c of nodes) {
      entry.comments.push(gqlCommentToRow(c));
      if (thread.isResolved) {
        entry.resolvedIds.add(c.databaseId);
      }
    }
  }
  const reviewNodes = pr.reviews?.nodes ?? [];
  entry.hasHumanApproval = reviewNodes.some(
    (r) => r.state === "APPROVED" && r.author && !r.author.login.includes("[bot]"),
  );
}

/**
 * For many repos: resolved review-comment IDs, comments, and human approval — batched GraphQL
 * (multiple repos and PRs per request when possible).
 */
export async function batchPullPollDataForRepos(
  pollEntries: Array<{ repoPath: string; prNumbers: number[] }>,
): Promise<Map<string, Map<number, PullPollData>>> {
  const out = new Map<string, Map<number, PullPollData>>();
  for (const { repoPath, prNumbers } of pollEntries) {
    const m = new Map<number, PullPollData>();
    for (const n of prNumbers) {
      m.set(n, {
        resolvedIds: new Set<number>(),
        comments: [],
        hasHumanApproval: false,
      });
    }
    out.set(repoPath, m);
  }

  const flat: Array<{ repoPath: string; prNumber: number }> = [];
  for (const { repoPath, prNumbers } of pollEntries) {
    for (const n of prNumbers) flat.push({ repoPath, prNumber: n });
  }
  if (flat.length === 0) return out;

  const tokenGroups = partitionEntriesByToken(flat);
  for (const tg of tokenGroups) {
    const tokenRepo = tg[0].repoPath;
    for (const sub of chunkArray(tg, GLOBAL_PR_CHUNK)) {
      const byRepo = new Map<string, number[]>();
      for (const { repoPath, prNumber } of sub) {
        const arr = byRepo.get(repoPath) ?? [];
        arr.push(prNumber);
        byRepo.set(repoPath, arr);
      }

      const layout: Array<{
        repoAlias: string;
        repoPath: string;
        prs: Array<{ prAlias: string; prNumber: number }>;
      }> = [];
      const repoBlocks: string[] = [];
      let ri = 0;
      for (const [repoPath, prNumbers] of byRepo) {
        const { owner, name } = parseRepoPath(repoPath);
        const repoAlias = `r${ri}`;
        const prs: Array<{ prAlias: string; prNumber: number }> = [];
        const prBlocks = prNumbers
          .map((num, pi) => {
            const prAlias = `p${pi}`;
            prs.push({ prAlias, prNumber: num });
            return `${prAlias}: pullRequest(number: ${num}) { ${PULL_POLL_FIELDS} }`;
          })
          .join("\n");
        layout.push({ repoAlias, repoPath, prs });
        repoBlocks.push(`${repoAlias}: repository(owner: "${owner}", name: "${name}") { ${prBlocks} }`);
        ri++;
      }

      const query = `query { ${repoBlocks.join("\n")} }`;
      const data = await ghGraphQL<Record<string, Record<string, PrPollNode | null> | null>>(query, {}, tokenRepo);

      for (const block of layout) {
        const repoNode = data[block.repoAlias];
        if (!repoNode) continue;
        const repoMap = out.get(block.repoPath);
        if (!repoMap) continue;
        for (const { prAlias, prNumber } of block.prs) {
          const entry = repoMap.get(prNumber);
          const pr = repoNode[prAlias];
          if (entry) mergePrPollIntoMap(entry, pr ?? null);
        }
      }
    }
  }

  return out;
}

export async function batchPullPollData(
  repoPath: string,
  prNumbers: number[],
): Promise<Map<number, PullPollData>> {
  if (prNumbers.length === 0) return new Map();
  const nested = await batchPullPollDataForRepos([{ repoPath, prNumbers }]);
  return nested.get(repoPath) ?? new Map();
}
