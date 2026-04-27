import { existsSync } from "fs";
import { z } from "zod";
import { removeFromFixQueue, getFixQueue, advanceQueue, isInFixQueue, enqueueFix } from "../../fix-queue.js";
import { getRepos, getFixJobStatusForComment, clearFixJobStatus, setFixJobStatus, getFixJobStatus, getAllFixJobStatuses, getActiveFixForBranch } from "../../server.js";
import { getWorktreePath, createWorktree, applyPatchInWorktree, commitAndPushWorktree, removeWorktree, getDiffInWorktree } from "../../worktree.js";
import { formatGitExecError } from "../../git-exec.js";
import { addFixJob as addFixJobState, getFixJobs, loadState, markComment, removeFixJob as removeFixJobState, saveState } from "../../state.js";
import { postReply, resolveThread, applyFixWithClaude, applyBatchFixWithClaude } from "../../actioner.js";
import { loadConfig } from "../../config.js";
import { trpc } from "../trpc.js";

const fixQueueCancelSchema = z.object({
  commentId: z.number().int().positive(),
});

const fixApplySchema = z.object({
  repo: z.string(),
  commentId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  branch: z.string(),
});

const fixDiscardSchema = z.object({
  branch: z.string(),
  repo: z.string().optional(),
  commentId: z.number().int().positive().optional(),
});

const fixReplySchema = z.object({
  repo: z.string(),
  commentId: z.number().int().positive(),
  message: z.string(),
});

const fixReplyResolveSchema = z.object({
  repo: z.string(),
  commentId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  replyBody: z.string(),
});
const fixStartSchema = z.object({
  repo: z.string(),
  commentId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
  branch: z.string(),
  comment: z.object({
    path: z.string(),
    line: z.number(),
    body: z.string(),
    diffHunk: z.string(),
  }),
  userInstructions: z.string().optional(),
});
const batchFixSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  branch: z.string(),
  threads: z.array(z.object({
    commentId: z.number().int().positive(),
    path: z.string(),
    line: z.number(),
    body: z.string(),
    diffHunk: z.string(),
  })),
  userInstructions: z.string().optional(),
});

export const fixProcedures = {
  actionFix: trpc.procedure.input(fixStartSchema).mutation(async (opts) => {
    const body = opts.input;
    if (isInFixQueue(body.commentId)) throw new Error("already queued");
    const existingStatus = getFixJobStatus(body.commentId);
    if (existingStatus && (existingStatus.status === "running" || existingStatus.status === "completed" || existingStatus.status === "awaiting_response")) {
      throw new Error("already active");
    }
    const activeBranch = getActiveFixForBranch(body.branch);
    if (activeBranch && activeBranch.commentId !== body.commentId) {
      throw new Error(`A fix is already running on branch ${body.branch} (${activeBranch.path})`);
    }
    const allStatuses = getAllFixJobStatuses();
    if (allStatuses.some((j) => j.status === "running" || j.status === "completed")) {
      const item = enqueueFix({
        commentId: body.commentId,
        repo: body.repo,
        prNumber: body.prNumber,
        branch: body.branch,
        comment: body.comment,
        userInstructions: body.userInstructions,
      });
      return { success: true, status: "queued" as const, position: item.position };
    }
    const state = loadState();
    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) throw new Error("Repo local path not found");
    const worktreePath = createWorktree(body.branch, repoInfo.localPath);
    addFixJobState(state, {
      commentId: body.commentId,
      repo: body.repo,
      prNumber: body.prNumber,
      branch: body.branch,
      path: body.comment.path,
      worktreePath,
      startedAt: new Date().toISOString(),
    });
    saveState(state);
    setFixJobStatus({
      commentId: body.commentId,
      repo: body.repo,
      prNumber: body.prNumber,
      path: body.comment.path,
      startedAt: Date.now(),
      status: "running",
    });
    const sessionId = crypto.randomUUID();
    void (async () => {
      try {
        const result = await applyFixWithClaude(worktreePath, body.comment, body.userInstructions, { sessionId });
        if (result.action === "questions") {
          const conversation = [{ role: "claude" as const, message: result.message }];
          const s = loadState();
          const existingJob = getFixJobs(s).find((j) => j.commentId === body.commentId);
          if (existingJob) {
            existingJob.sessionId = sessionId;
            existingJob.conversation = conversation;
            saveState(s);
          }
          setFixJobStatus({
            commentId: body.commentId,
            repo: body.repo,
            prNumber: body.prNumber,
            path: body.comment.path,
            startedAt: Date.now(),
            status: "awaiting_response",
            branch: body.branch,
            claudeOutput: result.rawOutput,
            sessionId,
            conversation,
          });
          advanceQueue();
          return;
        }
        const diff = getDiffInWorktree(worktreePath);
        if (!diff.trim()) {
          removeWorktree(body.branch, repoInfo.localPath);
          const s = loadState();
          removeFixJobState(s, body.commentId);
          saveState(s);
          setFixJobStatus({
            commentId: body.commentId,
            repo: body.repo,
            prNumber: body.prNumber,
            path: body.comment.path,
            startedAt: Date.now(),
            status: "no_changes",
            suggestedReply: result.message,
            claudeOutput: result.message,
          });
          advanceQueue();
          return;
        }
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          commentId: body.commentId,
          repo: body.repo,
          prNumber: body.prNumber,
          path: body.comment.path,
          startedAt: Date.now(),
          status: "completed",
          diff,
          branch: body.branch,
          claudeOutput: result.message,
          conversation: [{ role: "claude", message: result.message }],
        });
      } catch (err) {
        removeWorktree(body.branch, repoInfo.localPath);
        const s = loadState();
        removeFixJobState(s, body.commentId);
        saveState(s);
        setFixJobStatus({
          commentId: body.commentId,
          repo: body.repo,
          prNumber: body.prNumber,
          path: body.comment.path,
          startedAt: Date.now(),
          status: "failed",
          error: (err as Error).message,
        });
        advanceQueue();
      }
    })();
    return { success: true, status: "running" as const, branch: body.branch };
  }),
  actionBatchFix: trpc.procedure.input(batchFixSchema).mutation(async (opts) => {
    const body = opts.input;
    const MIN_BATCH_FIX_THREADS = 2;
    const MAX_BATCH_FIX_THREADS = 12;
    if (!Array.isArray(body.threads) || body.threads.length < MIN_BATCH_FIX_THREADS) throw new Error(`batch-fix requires at least ${MIN_BATCH_FIX_THREADS} threads`);
    if (body.threads.length > MAX_BATCH_FIX_THREADS) throw new Error(`batch-fix allows at most ${MAX_BATCH_FIX_THREADS} threads`);
    const seen = new Set<number>();
    const threads: Array<{ commentId: number; path: string; line: number; body: string; diffHunk: string }> = [];
    for (const t of body.threads) {
      if (typeof t.commentId !== "number" || !Number.isFinite(t.commentId) || seen.has(t.commentId)) continue;
      if (typeof t.path !== "string" || !t.path.trim()) continue;
      seen.add(t.commentId);
      threads.push({ commentId: t.commentId, path: t.path, line: typeof t.line === "number" ? t.line : Number(t.line), body: typeof t.body === "string" ? t.body : "", diffHunk: typeof t.diffHunk === "string" ? t.diffHunk : "" });
    }
    if (threads.length < MIN_BATCH_FIX_THREADS) throw new Error("batch-fix needs at least two valid distinct commentIds");
    threads.sort((a, b) => a.commentId - b.commentId);
    const batchCommentIds = threads.map((t) => t.commentId);
    const primaryCommentId = batchCommentIds[0]!;
    const uniquePaths = threads.map((t) => t.path).filter((p, i, a) => a.indexOf(p) === i);
    const displayPath = `${threads.length} threads (${uniquePaths.slice(0, 2).join(", ")}${uniquePaths.length > 2 ? ", …" : ""})`;
    for (const t of threads) {
      if (isInFixQueue(t.commentId)) throw new Error(`Comment ${t.commentId} is already in the fix queue`);
      const st = getFixJobStatusForComment(t.commentId);
      if (st && (st.status === "running" || st.status === "completed" || st.status === "awaiting_response")) throw new Error(`Comment ${t.commentId} already has an active fix`);
    }
    if (getActiveFixForBranch(body.branch)) throw new Error(`A fix is already running on branch ${body.branch}`);
    const allStatuses = getAllFixJobStatuses();
    if (allStatuses.some((j) => j.status === "running" || j.status === "completed" || j.status === "awaiting_response")) {
      throw new Error("Another fix is in progress or waiting for apply. Finish or discard it before starting a batch fix.");
    }
    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) throw new Error("Repo local path not found");
    const worktreePath = createWorktree(body.branch, repoInfo.localPath);
    const state = loadState();
    addFixJobState(state, {
      commentId: primaryCommentId,
      repo: body.repo,
      prNumber: body.prNumber,
      branch: body.branch,
      path: threads[0]!.path,
      worktreePath,
      startedAt: new Date().toISOString(),
    });
    saveState(state);
    setFixJobStatus({
      commentId: primaryCommentId,
      batchCommentIds,
      repo: body.repo,
      prNumber: body.prNumber,
      path: displayPath,
      startedAt: Date.now(),
      status: "running",
    });
    const sessionId = crypto.randomUUID();
    void (async () => {
      try {
        const result = await applyBatchFixWithClaude(worktreePath, threads, body.userInstructions, { sessionId });
        if (result.action === "questions") {
          const conversation = [{ role: "claude" as const, message: result.message }];
          const s = loadState();
          const existingJob = getFixJobs(s).find((j) => j.commentId === primaryCommentId);
          if (existingJob) {
            existingJob.sessionId = sessionId;
            existingJob.conversation = conversation;
            saveState(s);
          }
          setFixJobStatus({
            commentId: primaryCommentId,
            batchCommentIds,
            repo: body.repo,
            prNumber: body.prNumber,
            path: displayPath,
            startedAt: Date.now(),
            status: "awaiting_response",
            branch: body.branch,
            claudeOutput: result.rawOutput,
            sessionId,
            conversation,
          });
          advanceQueue();
          return;
        }
        const diff = getDiffInWorktree(worktreePath);
        if (!diff.trim()) {
          removeWorktree(body.branch, repoInfo.localPath);
          const s = loadState();
          removeFixJobState(s, primaryCommentId);
          saveState(s);
          setFixJobStatus({
            commentId: primaryCommentId,
            batchCommentIds,
            repo: body.repo,
            prNumber: body.prNumber,
            path: displayPath,
            startedAt: Date.now(),
            status: "no_changes",
            suggestedReply: result.message,
            claudeOutput: result.message,
          });
          advanceQueue();
          return;
        }
        const s = loadState();
        removeFixJobState(s, primaryCommentId);
        saveState(s);
        setFixJobStatus({
          commentId: primaryCommentId,
          batchCommentIds,
          repo: body.repo,
          prNumber: body.prNumber,
          path: displayPath,
          startedAt: Date.now(),
          status: "completed",
          diff,
          branch: body.branch,
          claudeOutput: result.message,
          conversation: [{ role: "claude", message: result.message }],
        });
      } catch (err) {
        removeWorktree(body.branch, repoInfo.localPath);
        const s = loadState();
        removeFixJobState(s, primaryCommentId);
        saveState(s);
        setFixJobStatus({
          commentId: primaryCommentId,
          batchCommentIds,
          repo: body.repo,
          prNumber: body.prNumber,
          path: displayPath,
          startedAt: Date.now(),
          status: "failed",
          error: (err as Error).message,
        });
        advanceQueue();
      }
    })();
    return { success: true, status: "running" as const, branch: body.branch };
  }),
  fixQueueList: trpc.procedure.query(() =>
    getFixQueue().map((q) => ({
      commentId: q.commentId,
      repo: q.repo,
      prNumber: q.prNumber,
      path: q.path,
      branch: q.branch,
      position: q.position,
      queuedAt: q.queuedAt,
    })),
  ),
  fixQueueCancel: trpc.procedure.input(fixQueueCancelSchema).mutation((opts) => {
    const { commentId } = opts.input;
    const removed = removeFromFixQueue(commentId);
    if (!removed) throw new Error("Item not found in queue");
    return { success: true };
  }),
  actionFixApply: trpc.procedure.input(fixApplySchema).mutation((opts) => {
    const body = opts.input;
    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) throw new Error("Repo local path not found");
    let primaryId = body.commentId;
    try {
      const worktreePath = getWorktreePath(body.branch, repoInfo.localPath);
      let recoveredWorktree = false;
      if (!existsSync(worktreePath)) {
        const job = getFixJobStatusForComment(body.commentId);
        if (!job || job.status !== "completed" || !job.diff?.trim()) {
          throw new Error("Fix worktree is missing and cannot be restored without the saved diff. Re-run 'Fix with Claude', then apply again.");
        }
        createWorktree(body.branch, repoInfo.localPath);
        applyPatchInWorktree(worktreePath, job.diff);
        recoveredWorktree = true;
      }
      const preApplyJob = getFixJobStatusForComment(body.commentId);
      primaryId = preApplyJob?.commentId ?? body.commentId;
      const batchCount = preApplyJob?.batchCommentIds?.length ?? 0;
      const commitMsg =
        batchCount > 1
          ? `fix: address ${batchCount} review threads for PR #${body.prNumber}`
          : `fix: apply CodeRabbit suggestion for PR #${body.prNumber}`;
      commitAndPushWorktree(worktreePath, commitMsg, body.branch);
      removeWorktree(body.branch, repoInfo.localPath);
      const state = loadState();
      const batchIds = preApplyJob?.batchCommentIds;
      if (batchIds && batchIds.length > 0) {
        for (const cid of batchIds) markComment(state, cid, "fixed", body.prNumber, body.repo);
      } else {
        markComment(state, primaryId, "fixed", body.prNumber, body.repo);
      }
      saveState(state);
      clearFixJobStatus(primaryId);
      advanceQueue();
      return { success: true, status: "fixed" as const, ...(recoveredWorktree ? { recoveredWorktree: true } : {}) };
    } catch (err) {
      console.error(`[fix-apply] repo=${body.repo} pr=#${body.prNumber} commentId=${primaryId} branch=${body.branch}`);
      console.error(`[fix-apply] ${formatGitExecError(err)}`);
      throw new Error(`Push failed: ${(err as Error).message}`, { cause: err });
    }
  }),
  actionFixDiscard: trpc.procedure.input(fixDiscardSchema).mutation((opts) => {
    const body = opts.input;
    const discardRepoInfo = body.repo ? getRepos().find((r) => r.repo === body.repo) : undefined;
    try {
      removeWorktree(body.branch, discardRepoInfo?.localPath);
    } catch {
      /* ignore */
    }
    if (body.commentId != null) {
      const j = getFixJobStatusForComment(body.commentId);
      clearFixJobStatus(j?.commentId ?? body.commentId);
    }
    advanceQueue();
    return { success: true };
  }),
  actionFixReplyAndResolve: trpc.procedure.input(fixReplyResolveSchema).mutation(async (opts) => {
    const body = opts.input;
    await postReply(body.repo, body.prNumber, body.commentId, body.replyBody);
    await resolveThread(body.repo, body.commentId, body.prNumber, undefined);
    const state = loadState();
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    const fixJob = getFixJobStatusForComment(body.commentId);
    clearFixJobStatus(fixJob?.commentId ?? body.commentId);
    advanceQueue();
    return { success: true };
  }),
  actionFixReply: trpc.procedure.input(fixReplySchema).mutation(async (opts) => {
    const body = opts.input;
    const job = getFixJobStatusForComment(body.commentId);
    if (!job || job.status !== "awaiting_response") {
      throw new Error("No fix job awaiting response for this comment");
    }
    const primaryCommentId = job.commentId;
    if (!job.sessionId || !job.branch) throw new Error("Fix job missing session or branch info");
    const repoInfo = getRepos().find((r) => r.repo === body.repo);
    if (!repoInfo?.localPath) throw new Error("Repo local path not found");
    const worktreePath = getWorktreePath(job.branch, repoInfo.localPath);
    const conversation = [...(job.conversation ?? []), { role: "user" as const, message: body.message }];
    const config = loadConfig();
    const maxTurns = config.fixConversationMaxTurns ?? 5;
    const claudeTurnCount = conversation.filter((m) => m.role === "claude").length;
    const isLastTurn = maxTurns > 0 && claudeTurnCount >= maxTurns - 1;
    setFixJobStatus({ ...job, status: "running", conversation });
    void (async () => {
      try {
        const result = await applyFixWithClaude(
          worktreePath,
          { path: job.path, line: 0, body: "", diffHunk: "" },
          body.message,
          { resumeSessionId: job.sessionId, isLastTurn },
        );
        const updatedConversation = [...conversation, { role: "claude" as const, message: result.message }];
        if (result.action === "questions" && !isLastTurn) {
          const s = loadState();
          const persistedJob = getFixJobs(s).find((j) => j.commentId === primaryCommentId);
          if (persistedJob) {
            persistedJob.conversation = updatedConversation;
            saveState(s);
          }
          setFixJobStatus({
            ...job,
            status: "awaiting_response",
            conversation: updatedConversation,
            claudeOutput: result.rawOutput,
          });
          advanceQueue();
          return;
        }
        const diff = getDiffInWorktree(worktreePath);
        if (!diff.trim()) {
          removeWorktree(job.branch!, repoInfo.localPath);
          const s = loadState();
          removeFixJobState(s, primaryCommentId);
          saveState(s);
          setFixJobStatus({
            ...job,
            status: "failed",
            error: isLastTurn && result.action === "questions"
              ? "Claude could not complete the fix within the turn limit"
              : "Claude made no changes",
            conversation: updatedConversation,
            claudeOutput: result.rawOutput,
          });
          advanceQueue();
          return;
        }
        const s = loadState();
        removeFixJobState(s, primaryCommentId);
        saveState(s);
        setFixJobStatus({
          ...job,
          status: "completed",
          diff,
          conversation: updatedConversation,
          claudeOutput: result.rawOutput,
        });
      } catch (err) {
        removeWorktree(job.branch!, repoInfo.localPath);
        const s = loadState();
        removeFixJobState(s, primaryCommentId);
        saveState(s);
        setFixJobStatus({
          ...job,
          status: "failed",
          error: (err as Error).message,
          conversation,
        });
        advanceQueue();
      }
    })();
    return { success: true, status: "running" as const };
  }),
  fixJobsRecover: trpc.procedure.query(() => {
    const state = loadState();
    const staleJobs = getFixJobs(state);
    const results: Array<{ job: (typeof staleJobs)[number]; hasDiff: boolean; diff?: string }> = [];
    for (const job of staleJobs) {
      try {
        const diff = getDiffInWorktree(job.worktreePath);
        results.push({ job, hasDiff: !!diff.trim(), diff: diff.trim() || undefined });
      } catch {
        removeFixJobState(state, job.commentId);
      }
    }
    saveState(state);
    return results;
  }),
};
