import { z } from "zod";
import { ghAsync, ghPost } from "../../exec.js";
import { loadState, markComment, patchCommentTriage, saveState } from "../../state.js";
import { enqueueEvaluation, drainOnce } from "../../eval-queue.js";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema.js";
import { openStateDatabase } from "../../db/client.js";
import { postReply, resolveThread } from "../../actioner.js";
import { trpc } from "../trpc.js";

const actionThreadSchema = z.object({
  repo: z.string(),
  commentId: z.number().int().positive(),
  prNumber: z.number().int().positive(),
});
const actionBatchSchema = z.object({
  action: z.enum(["reply", "resolve", "dismiss"]),
  items: z.array(actionThreadSchema),
});
const actionCommentTriageSchema = actionThreadSchema.extend({
  snoozeUntil: z.string().nullable().optional(),
  priority: z.number().nullable().optional(),
  triageNote: z.string().nullable().optional(),
});
const actionReviewSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
  body: z.string().optional(),
});
const actionInlineCommentSchema = z.object({
  repo: z.string(),
  prNumber: z.number().int().positive(),
  commitId: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]),
  body: z.string(),
});

export const actionProcedures = {
  actionReply: trpc.procedure.input(actionThreadSchema).mutation(async (opts) => {
    const body = opts.input;
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];
    if (!record?.evaluation?.reply) throw new Error("No reply text in evaluation");
    await postReply(body.repo, body.prNumber, body.commentId, record.evaluation.reply);
    await resolveThread(body.repo, body.commentId, body.prNumber, undefined);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    return { success: true, status: "replied" as const };
  }),
  actionResolve: trpc.procedure.input(actionThreadSchema).mutation(async (opts) => {
    const body = opts.input;
    const state = loadState();
    const key = `${body.repo}:${body.commentId}`;
    const record = state.comments[key];
    await resolveThread(body.repo, body.commentId, body.prNumber, record?.evaluation?.reply);
    markComment(state, body.commentId, "replied", body.prNumber, body.repo);
    saveState(state);
    return { success: true, status: "replied" as const };
  }),
  actionDismiss: trpc.procedure.input(actionThreadSchema).mutation(async (opts) => {
    const body = opts.input;
    const state = loadState();
    markComment(state, body.commentId, "dismissed", body.prNumber, body.repo);
    saveState(state);
    return { success: true, status: "dismissed" as const };
  }),
  actionBatch: trpc.procedure.input(actionBatchSchema).mutation(async (opts) => {
    const body = opts.input;
    const state = loadState();
    const results: Array<{ commentId: number; success: boolean; error?: string }> = [];
    for (const item of body.items) {
      try {
        const key = `${item.repo}:${item.commentId}`;
        const record = state.comments[key];
        if (body.action === "reply") {
          if (!record?.evaluation?.reply) throw new Error("No reply text in evaluation");
          await postReply(item.repo, item.prNumber, item.commentId, record.evaluation.reply);
          await resolveThread(item.repo, item.commentId, item.prNumber, undefined);
          markComment(state, item.commentId, "replied", item.prNumber, item.repo);
        } else if (body.action === "resolve") {
          await resolveThread(item.repo, item.commentId, item.prNumber, record?.evaluation?.reply);
          markComment(state, item.commentId, "replied", item.prNumber, item.repo);
        } else {
          markComment(state, item.commentId, "dismissed", item.prNumber, item.repo);
        }
        results.push({ commentId: item.commentId, success: true });
      } catch (err) {
        results.push({ commentId: item.commentId, success: false, error: (err as Error).message });
      }
    }
    saveState(state);
    return { results };
  }),
  actionReEvaluate: trpc.procedure.input(actionThreadSchema).mutation(async (opts) => {
    const body = opts.input;
    const state = loadState();
    const ghComment = await ghAsync<{
      id: number;
      path: string;
      line: number | null;
      original_line: number | null;
      diff_hunk: string;
      body: string;
      in_reply_to_id: number | null;
    }>(`/repos/${body.repo}/pulls/comments/${body.commentId}`);
    const comment = {
      id: ghComment.id,
      prNumber: body.prNumber,
      path: ghComment.path,
      line: ghComment.line ?? ghComment.original_line ?? 0,
      diffHunk: ghComment.diff_hunk,
      body: ghComment.body,
      inReplyToId: ghComment.in_reply_to_id ?? null,
    };
    openStateDatabase()
      .delete(schema.evalQueue)
      .where(eq(schema.evalQueue.commentKey, `${body.repo}:${body.commentId}`))
      .run();
    const key = `${body.repo}:${body.commentId}`;
    if (state.comments[key]) {
      delete state.comments[key].evalFailed;
      if (state.comments[key].status === "evaluating") state.comments[key].status = "pending";
      delete state.comments[key].evaluation;
    }
    const result = enqueueEvaluation(comment, body.prNumber, body.repo, state);
    saveState(state);
    if (result === "queued") void drainOnce();
    return { success: true, status: result };
  }),
  actionCommentTriage: trpc.procedure.input(actionCommentTriageSchema).mutation(async (opts) => {
    const body = opts.input;
    const state = loadState();
    patchCommentTriage(state, body.commentId, body.repo, body.prNumber, {
      ...(body.snoozeUntil !== undefined ? { snoozeUntil: body.snoozeUntil } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.triageNote !== undefined ? { triageNote: body.triageNote } : {}),
    });
    saveState(state);
    return { success: true };
  }),
  actionReview: trpc.procedure.input(actionReviewSchema).mutation(async (opts) => {
    const parsed = opts.input;
    const reviewText = typeof parsed.body === "string" ? parsed.body.trim() : "";
    if (parsed.event !== "APPROVE" && reviewText.length === 0) {
      throw new Error("Review comment body is required for this action.");
    }
    const payload: Record<string, unknown> = { event: parsed.event };
    if (reviewText.length > 0) payload.body = reviewText;
    await ghPost(`/repos/${parsed.repo}/pulls/${parsed.prNumber}/reviews`, payload);
    return { success: true };
  }),
  actionComment: trpc.procedure.input(actionInlineCommentSchema).mutation(async (opts) => {
    const body = opts.input;
    await ghPost(`/repos/${body.repo}/pulls/${body.prNumber}/comments`, {
      body: body.body,
      commit_id: body.commitId,
      path: body.path,
      line: body.line,
      side: body.side,
    });
    return { success: true };
  }),
};
