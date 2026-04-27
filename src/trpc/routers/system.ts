import { getRepos, getPollState, triggerManualPoll } from "../../server.js";
import { getFixQueue } from "../../fix-queue.js";
import { clearRepoPollSchedule } from "../../repo-poll-schedule.js";
import { trpc } from "../trpc.js";

export const systemProcedures = {
  repos: trpc.procedure.query(() => getRepos()),
  pollStatus: trpc.procedure.query(() => getPollState()),
  fixQueue: trpc.procedure.query(() =>
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
  pollNow: trpc.procedure.mutation(() => {
    return { ok: triggerManualPoll() };
  }),
  clearRepoPollSchedule: trpc.procedure.mutation(async () => {
    await clearRepoPollSchedule();
    return { ok: true };
  }),
};
