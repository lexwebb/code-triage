import { existsSync } from "fs";
import { loadState, saveState, removeFixJob, getFixJobs } from "./state.js";
import { getAllFixJobStatuses, setFixJobStatus, getRepos } from "./server.js";
import { removeWorktree } from "./worktree.js";
import { advanceQueue } from "./fix-queue.js";

const INTERRUPTED_RUNNING =
  "Fix interrupted when the app closed while Claude was still running. Start Fix with Claude again.";
const INTERRUPTED_QA =
  "Fix Q&A was interrupted when the app closed. Start Fix with Claude again to continue.";
const INTERRUPTED_NO_RECORD =
  "Fix state was incomplete after restart. Start Fix with Claude again.";

/**
 * After `loadPersistedFixJobResults()`, in-memory jobs may still be `running` or `awaiting_response`
 * even though no Claude child exists. That blocks `advanceQueue` and confuses the web UI.
 * Mark those jobs failed, remove SQLite worktree rows, and drop worktrees when safe.
 */
export function reconcileOrphanInFlightFixJobs(): void {
  const inFlight = getAllFixJobStatuses().filter(
    (j) => j.status === "running" || j.status === "awaiting_response",
  );
  if (inFlight.length === 0) return;

  const state = loadState();
  const byComment = new Map(getFixJobs(state).map((r) => [r.commentId, r]));
  let stateDirty = false;

  for (const job of inFlight) {
    const record = byComment.get(job.commentId);
    const repoInfo = getRepos().find((r) => r.repo === job.repo);
    const msg = job.status === "awaiting_response" ? INTERRUPTED_QA : INTERRUPTED_RUNNING;

    if (!record || !job.branch) {
      setFixJobStatus({
        ...job,
        status: "failed",
        error: INTERRUPTED_NO_RECORD,
      });
      continue;
    }

    const wt = record.worktreePath;
    if (!wt || !existsSync(wt)) {
      removeFixJob(state, job.commentId);
      stateDirty = true;
      setFixJobStatus({
        ...job,
        status: "failed",
        error: msg,
      });
      continue;
    }

    try {
      if (repoInfo?.localPath) {
        removeWorktree(job.branch, repoInfo.localPath);
      }
    } catch {
      /* best effort — worktree may already be broken */
    }
    removeFixJob(state, job.commentId);
    stateDirty = true;
    setFixJobStatus({
      ...job,
      status: "failed",
      error: msg,
    });
  }

  if (stateDirty) {
    saveState(state);
  }
  advanceQueue();
}
