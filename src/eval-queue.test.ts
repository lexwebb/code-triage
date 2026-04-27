import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStateDatabase, getStateDir } from "./db/client.js";
import { loadState, markCommentWithEvaluation, saveState } from "./state.js";
import { enqueueEvaluation, getQueueDepth, dequeueItems, markInFlight, completeItem, failItem, recoverQueue, drainOnce } from "./eval-queue.js";
import type { CrComment } from "./types.js";

// Mock actioner and server to avoid real Claude calls and SSE
vi.mock("./actioner.js", () => ({
  evaluateComment: vi.fn().mockResolvedValue({ action: "reply", summary: "ok", reply: "hi" }),
  clampEvalConcurrency: (n: number) => Math.min(8, Math.max(1, n)),
  resolveThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./server.js", () => ({
  updateClaudeStats: vi.fn(),
  sseBroadcast: vi.fn(),
  broadcastPollStatus: vi.fn(),
}));
const mockLoadConfig = vi.fn(() => ({ evalConcurrency: 2, autoResolveOnEvaluation: false }));
vi.mock("./config.js", () => ({
  loadConfig: () => mockLoadConfig(),
}));

let testRoot: string;

function makeComment(id: number, prNumber = 1): CrComment {
  return { id, prNumber, path: "src/foo.ts", line: 10, diffHunk: "@@ -1,3 +1,3 @@", body: "fix this", inReplyToId: null };
}

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "eval-queue-"));
  process.env.CODE_TRIAGE_STATE_DIR = testRoot;
});

afterAll(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  mockLoadConfig.mockReset();
  mockLoadConfig.mockReturnValue({ evalConcurrency: 2, autoResolveOnEvaluation: false });
  closeStateDatabase();
  const dir = getStateDir();
  mkdirSync(dir, { recursive: true });
  for (const f of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
    const p = join(dir, f);
    if (existsSync(p)) rmSync(p);
  }
});

describe("eval-queue", () => {
  it("enqueueEvaluation returns 'queued' for new comment", () => {
    const state = loadState();
    const result = enqueueEvaluation(makeComment(1), 1, "o/r", state);
    expect(result).toBe("queued");
    expect(state.comments["o/r:1"]?.status).toBe("evaluating");
  });

  it("enqueueEvaluation returns 'already-evaluated' for comment with evaluation", () => {
    const state = loadState();
    markCommentWithEvaluation(state, 2, "pending", 1, { action: "reply", summary: "ok", reply: "hi" }, "o/r");
    saveState(state);
    const result = enqueueEvaluation(makeComment(2), 1, "o/r", state);
    expect(result).toBe("already-evaluated");
  });

  it("enqueueEvaluation returns 'already-queued' for duplicate enqueue", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(3), 1, "o/r", state);
    saveState(state);
    const result = enqueueEvaluation(makeComment(3), 1, "o/r", state);
    expect(result).toBe("already-queued");
  });

  it("dequeueItems returns queued items up to limit", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(10), 1, "o/r", state);
    enqueueEvaluation(makeComment(11), 1, "o/r", state);
    enqueueEvaluation(makeComment(12), 1, "o/r", state);
    saveState(state);
    const items = dequeueItems(2);
    expect(items).toHaveLength(2);
    expect(items[0].commentId).toBe(10);
    expect(items[1].commentId).toBe(11);
  });

  it("markInFlight transitions queued to in_flight", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(20), 1, "o/r", state);
    saveState(state);
    const items = dequeueItems(1);
    markInFlight(items[0].commentKey);
    const depth = getQueueDepth();
    expect(depth.inFlight).toBe(1);
    expect(depth.queued).toBe(0);
  });

  it("completeItem removes from queue", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(30), 1, "o/r", state);
    saveState(state);
    completeItem("o/r:30");
    const depth = getQueueDepth();
    expect(depth.queued).toBe(0);
    expect(depth.inFlight).toBe(0);
  });

  it("failItem increments attempts and resets to queued", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(40), 1, "o/r", state);
    saveState(state);
    failItem("o/r:40");
    const items = dequeueItems(1);
    expect(items[0].attempts).toBe(1);
  });

  it("failItem with attempts >= 3 removes from queue", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(50), 1, "o/r", state);
    saveState(state);
    failItem("o/r:50");
    failItem("o/r:50");
    failItem("o/r:50");
    const depth = getQueueDepth();
    expect(depth.queued).toBe(0);
  });

  it("recoverQueue resets in_flight to queued", () => {
    const state = loadState();
    enqueueEvaluation(makeComment(60), 1, "o/r", state);
    saveState(state);
    markInFlight("o/r:60");
    recoverQueue();
    const depth = getQueueDepth();
    expect(depth.queued).toBe(1);
    expect(depth.inFlight).toBe(0);
  });
});

describe("eval-queue worker", () => {
  it("drainOnce evaluates queued items and stores results", async () => {
    const state = loadState();
    enqueueEvaluation(makeComment(70), 1, "o/r", state);
    saveState(state);

    await drainOnce(2);

    const depth = getQueueDepth();
    expect(depth.queued).toBe(0);
    expect(depth.inFlight).toBe(0);

    const updated = loadState();
    expect(updated.comments["o/r:70"]?.status).toBe("pending");
    expect(updated.comments["o/r:70"]?.evaluation?.action).toBe("reply");
  });

  it("drainOnce handles evaluation failure with retry", async () => {
    const { evaluateComment } = await import("./actioner.js");
    (evaluateComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Claude unavailable"));

    const state = loadState();
    enqueueEvaluation(makeComment(80), 1, "o/r", state);
    saveState(state);

    await drainOnce(2);

    const items = dequeueItems(10);
    expect(items).toHaveLength(1);
    expect(items[0].attempts).toBe(1);
  });

  it("auto-resolves when evaluation action is resolve and config is enabled", async () => {
    const { evaluateComment, resolveThread } = await import("./actioner.js");
    (evaluateComment as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: "resolve",
      summary: "already addressed",
      reply: "Resolved automatically",
    });
    mockLoadConfig.mockReturnValue({ evalConcurrency: 2, autoResolveOnEvaluation: true });

    const state = loadState();
    enqueueEvaluation(makeComment(90), 1, "o/r", state);
    saveState(state);

    await drainOnce(2);

    expect(resolveThread as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      "o/r",
      90,
      1,
      "Resolved automatically",
    );
    const updated = loadState();
    expect(updated.comments["o/r:90"]?.status).toBe("replied");
    expect(updated.comments["o/r:90"]?.evaluation?.action).toBe("resolve");
  });
});
