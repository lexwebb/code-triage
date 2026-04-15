import type { FixJobStatus } from "../api";

/** Find the in-memory fix job for a review thread, including batch jobs stored under the primary comment id. */
export function findJobForComment(jobs: FixJobStatus[], commentId: number): FixJobStatus | undefined {
  return jobs.find(
    (j) => j.commentId === commentId || (j.batchCommentIds?.includes(commentId) ?? false),
  );
}
