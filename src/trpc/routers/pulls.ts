import { z } from "zod";
import { getRepos } from "../../server.js";
import { buildPullSidebarLists, filterPullSidebarResponse } from "../../api.js";
import { ghAsync } from "../../exec.js";
import { batchPullPollData } from "../../github-batching.js";
import { buildIgnoredBotSet } from "../../poller.js";
import { loadConfig } from "../../config.js";
import { loadState, needsEvaluation, saveState } from "../../state.js";
import { enqueueEvaluation, drainOnce } from "../../eval-queue.js";
import { trpc } from "../trpc.js";

const repoFilterSchema = z.object({
  repo: z.string().optional(),
});
const pullRepoInputSchema = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
});
const pullCommentsInputSchema = pullRepoInputSchema.extend({
  autoEvaluate: z.boolean().optional(),
});
const pullChecksInputSchema = pullRepoInputSchema.extend({
  sha: z.string().optional(),
});

export const pullProcedures = {
  pullsBundle: trpc.procedure.input(repoFilterSchema.optional()).query(async (opts) => {
    const repoFilter = opts.input?.repo ?? null;
    const targetRepos = repoFilter ? getRepos().filter((r) => r.repo === repoFilter) : getRepos();
    const lists = await buildPullSidebarLists(targetRepos);
    filterPullSidebarResponse(lists, repoFilter);
    return lists;
  }),
  pulls: trpc.procedure.input(repoFilterSchema.optional()).query(async (opts) => {
    const repoFilter = opts.input?.repo ?? null;
    const targetRepos = repoFilter ? getRepos().filter((r) => r.repo === repoFilter) : getRepos();
    const lists = await buildPullSidebarLists(targetRepos);
    filterPullSidebarResponse(lists, repoFilter);
    return lists.authored;
  }),
  reviewRequested: trpc.procedure.input(repoFilterSchema.optional()).query(async (opts) => {
    const repoFilter = opts.input?.repo ?? null;
    const targetRepos = repoFilter ? getRepos().filter((r) => r.repo === repoFilter) : getRepos();
    const lists = await buildPullSidebarLists(targetRepos);
    filterPullSidebarResponse(lists, repoFilter);
    return lists.reviewRequested;
  }),
  pullDetail: trpc.procedure.input(pullRepoInputSchema).query(async (opts) => {
    const { repo, number: prNumber } = opts.input;
    type ReviewerState = "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
    function toReviewerState(raw: string): ReviewerState {
      if (raw === "APPROVED" || raw === "CHANGES_REQUESTED" || raw === "COMMENTED" || raw === "DISMISSED") return raw;
      return "PENDING";
    }
    const pr = await ghAsync<{
      number: number; title: string; body: string; user: { login: string; avatar_url: string };
      head: { ref: string; sha: string }; base: { ref: string }; html_url: string; created_at: string; updated_at: string;
      draft: boolean; additions: number; deletions: number; changed_files: number; requested_reviewers: Array<{ login: string; avatar_url: string }>;
    }>(`/repos/${repo}/pulls/${prNumber}`);
    const reviews = await ghAsync<Array<{ user: { login: string; avatar_url: string }; state: string; submitted_at: string }>>(`/repos/${repo}/pulls/${prNumber}/reviews`);
    const reviewerMap = new Map<string, { login: string; avatar: string; state: ReviewerState }>();
    for (const r of pr.requested_reviewers) reviewerMap.set(r.login, { login: r.login, avatar: r.avatar_url, state: "PENDING" });
    for (const r of reviews) {
      if (r.state === "COMMENTED" || r.state === "DISMISSED") {
        if (!reviewerMap.has(r.user.login)) reviewerMap.set(r.user.login, { login: r.user.login, avatar: r.user.avatar_url, state: toReviewerState(r.state) });
        continue;
      }
      reviewerMap.set(r.user.login, { login: r.user.login, avatar: r.user.avatar_url, state: toReviewerState(r.state) });
    }
    return {
      number: pr.number, title: pr.title, body: pr.body, author: pr.user.login, authorAvatar: pr.user.avatar_url,
      branch: pr.head.ref, headSha: pr.head.sha, baseBranch: pr.base.ref, url: pr.html_url,
      createdAt: pr.created_at, updatedAt: pr.updated_at, draft: pr.draft, additions: pr.additions, deletions: pr.deletions,
      changedFiles: pr.changed_files, repo, reviewers: Array.from(reviewerMap.values()),
      checksSummary: null, checksStatus: "pending" as const, openComments: 0, hasHumanApproval: false,
    };
  }),
  pullFiles: trpc.procedure.input(pullRepoInputSchema).query(async (opts) => {
    const { repo, number } = opts.input;
    const files = await ghAsync<Array<{ sha: string; filename: string; status: string; additions: number; deletions: number; patch?: string }>>(`/repos/${repo}/pulls/${number}/files`);
    return files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch || "" }));
  }),
  pullComments: trpc.procedure.input(pullCommentsInputSchema).query(async (opts) => {
    const { repo, number: prNumber, autoEvaluate } = opts.input;
    const pollByPr = await batchPullPollData(repo, [prNumber]);
    const poll = pollByPr.get(prNumber);
    const comments = poll?.comments ?? [];
    const resolvedIds = poll?.resolvedIds ?? new Set<number>();
    const state = loadState();
    const ignoredBots = buildIgnoredBotSet(loadConfig().ignoredBots);
    if (autoEvaluate !== false) {
      let enqueued = 0;
      for (const c of comments) {
        if (ignoredBots.has(c.user.login) || !needsEvaluation(state, c.id, repo)) continue;
        const result = enqueueEvaluation({
          id: c.id, prNumber, path: c.path, line: c.line || c.original_line || 0, diffHunk: c.diff_hunk, body: c.body, inReplyToId: c.in_reply_to_id ?? null,
        }, prNumber, repo, state);
        if (result === "queued") enqueued++;
      }
      if (enqueued > 0) {
        saveState(state);
        void drainOnce();
      }
    }
    return comments.map((c) => {
      const record = state.comments[`${repo}:${c.id}`];
      return {
        id: c.id, htmlUrl: c.html_url ?? "", author: c.user.login, authorAvatar: c.user.avatar_url ?? "",
        isBot: c.user.type === "Bot" || c.user.login.endsWith("[bot]"), path: c.path, line: c.line || c.original_line || 0,
        diffHunk: c.diff_hunk, body: c.body, createdAt: c.created_at ?? "", inReplyToId: c.in_reply_to_id ?? null,
        isResolved: resolvedIds.has(c.id), evaluation: record?.evaluation ?? null, crStatus: record?.status ?? null,
        snoozeUntil: record?.snoozeUntil ?? null, priority: record?.priority ?? null, triageNote: record?.triageNote ?? null, evalFailed: record?.evalFailed ?? false,
      };
    });
  }),
  pullChecks: trpc.procedure.input(pullChecksInputSchema).query(async (opts) => {
    const { repo, number: prNumber } = opts.input;
    let sha = opts.input.sha ?? "";
    if (!sha) sha = (await ghAsync<{ head: { sha: string } }>(`/repos/${repo}/pulls/${prNumber}`)).head.sha;
    type GhCommitStatus = { id: number; state: "success" | "failure" | "pending" | "error"; context: string; target_url: string | null; created_at: string; updated_at: string };
    type GhCombinedStatus = { statuses: GhCommitStatus[] };
    type GhCheckSuitesResponse = { check_suites: Array<{ id: number; app?: { name?: string } }> };
    type GhCheckRunFull = { id: number; name: string; status: "queued" | "in_progress" | "completed"; conclusion: string | null; started_at: string | null; completed_at: string | null; html_url: string; check_suite: { id: number }; output: { annotations_count: number } };
    type GhCheckRunsFullResponse = { check_runs: GhCheckRunFull[] };
    type GhAnnotation = { path: string; start_line: number; end_line: number; annotation_level: "notice" | "warning" | "failure"; message: string; title: string | null };
    const [suitesData, runsData, statusData] = await Promise.all([
      ghAsync<GhCheckSuitesResponse>(`/repos/${repo}/commits/${sha}/check-suites?per_page=100`),
      ghAsync<GhCheckRunsFullResponse>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
      ghAsync<GhCombinedStatus>(`/repos/${repo}/commits/${sha}/status`).catch(() => null),
    ]);
    const suiteNameMap = new Map<number, string>();
    for (const s of suitesData.check_suites) suiteNameMap.set(s.id, s.app?.name ?? "Unknown");
    const latestByKey = new Map<string, GhCheckRunFull>();
    for (const run of runsData.check_runs) {
      const key = `${run.check_suite.id}:${run.name}`;
      const existing = latestByKey.get(key);
      if (!existing || run.id > existing.id) latestByKey.set(key, run);
    }
    const dedupedRuns = Array.from(latestByKey.values());
    const failedRuns = dedupedRuns.filter((r) => r.status === "completed" && (r.conclusion === "failure" || r.conclusion === "timed_out"));
    const annotationsByRunId = new Map<number, GhAnnotation[]>();
    await Promise.all(failedRuns.map(async (run) => {
      if (run.output.annotations_count === 0) return;
      try { annotationsByRunId.set(run.id, await ghAsync<GhAnnotation[]>(`/repos/${repo}/check-runs/${run.id}/annotations`)); } catch { /* ignore */ }
    }));
    function sortOrder(run: GhCheckRunFull): number {
      if (run.status !== "completed") return 1;
      if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "action_required") return 0;
      return 2;
    }
    const suiteRunsMap = new Map<number, GhCheckRunFull[]>();
    for (const run of dedupedRuns) {
      const suiteId = run.check_suite.id;
      if (!suiteRunsMap.has(suiteId)) suiteRunsMap.set(suiteId, []);
      suiteRunsMap.get(suiteId)!.push(run);
    }
    const suites = Array.from(suiteRunsMap.entries()).map(([suiteId, runs]) => {
      runs.sort((a, b) => sortOrder(a) - sortOrder(b));
      const hasFailure = runs.some((r) => sortOrder(r) === 0);
      const hasPending = runs.some((r) => r.status !== "completed");
      return {
        id: suiteId, name: suiteNameMap.get(suiteId) ?? "Unknown", conclusion: hasFailure ? "failure" : hasPending ? null : "success",
        runs: runs.map((r) => {
          const annotations = (annotationsByRunId.get(r.id) ?? []).map((a) => ({ path: a.path, startLine: a.start_line, endLine: a.end_line, level: a.annotation_level, message: a.message, title: a.title }));
          const startMs = r.started_at ? new Date(r.started_at).getTime() : null;
          const endMs = r.completed_at ? new Date(r.completed_at).getTime() : null;
          return { id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, startedAt: r.started_at, completedAt: r.completed_at, durationMs: startMs && endMs ? endMs - startMs : null, htmlUrl: r.html_url, annotations };
        }),
      };
    });
    if (statusData?.statuses?.length) {
      const latestByContext = new Map<string, GhCommitStatus>();
      for (const s of statusData.statuses) {
        const existing = latestByContext.get(s.context);
        if (!existing || s.id > existing.id) latestByContext.set(s.context, s);
      }
      const statusRuns = Array.from(latestByContext.values());
      const hasFailure = statusRuns.some((s) => s.state === "failure" || s.state === "error");
      const hasPending = statusRuns.some((s) => s.state === "pending");
      function statusSortOrder(s: GhCommitStatus): number {
        if (s.state === "failure" || s.state === "error") return 0;
        if (s.state === "pending") return 1;
        return 2;
      }
      statusRuns.sort((a, b) => statusSortOrder(a) - statusSortOrder(b));
      suites.push({
        id: -1, name: "Commit Statuses", conclusion: hasFailure ? "failure" : hasPending ? null : "success",
        runs: statusRuns.map((s) => ({
          id: s.id, name: s.context, status: s.state === "pending" ? ("in_progress" as const) : ("completed" as const),
          conclusion: s.state === "pending" ? null : s.state === "error" ? "failure" : s.state,
          startedAt: s.created_at, completedAt: s.state !== "pending" ? s.updated_at : null, durationMs: null, htmlUrl: s.target_url ?? "", annotations: [],
        })),
      });
    }
    suites.sort((a, b) => {
      const order = (c: string | null) => (c === "failure" ? 0 : c === null ? 1 : 2);
      return order(a.conclusion) - order(b.conclusion);
    });
    return suites;
  }),
};
