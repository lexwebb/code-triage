import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStateDatabase, getStateDir, getRawSqlite, openStateDatabase } from "./db/client.js";
import { enqueueFix, getFixQueue, dequeueNextFix, removeFromFixQueue, advanceQueue } from "./fix-queue.js";
import { getAllFixJobStatuses, setFixJobStatus, getRepos } from "./server.js";

vi.mock("./server.js", () => {
  const statuses = new Map();
  return {
    sseBroadcast: vi.fn(),
    getActiveFixForBranch: vi.fn(() => undefined),
    getFixJobStatus: vi.fn(),
    setFixJobStatus: vi.fn(),
    getRepos: vi.fn(() => []),
    fixJobStatuses: statuses,
    getAllFixJobStatuses: vi.fn(() => Array.from(statuses.values())),
  };
});

vi.mock("./worktree.js", () => ({
  createWorktree: vi.fn(() => "/tmp/fake-worktree"),
  removeWorktree: vi.fn(),
  getDiffInWorktree: vi.fn(() => ""),
}));

vi.mock("./actioner.js", () => ({
  applyFixWithClaude: vi.fn(),
}));

vi.mock("./state.js", () => ({
  loadState: vi.fn(() => ({ lastPoll: null, comments: {} })),
  saveState: vi.fn(),
  addFixJob: vi.fn(),
  removeFixJob: vi.fn(),
}));

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

let testRoot: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "fix-queue-"));
  process.env.CODE_TRIAGE_STATE_DIR = testRoot;
});

afterAll(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  closeStateDatabase();
  const dir = getStateDir();
  mkdirSync(dir, { recursive: true });
  for (const f of ["state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
    const p = join(dir, f);
    if (existsSync(p)) rmSync(p);
  }
});

describe("fix_queue table", () => {
  it("exists after openStateDatabase", () => {
    openStateDatabase();
    const sqlite = getRawSqlite();
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fix_queue'").all();
    expect(tables).toHaveLength(1);
  });
});

function makeFixRequest(commentId: number, prNumber = 42, repo = "owner/repo") {
  return {
    commentId,
    repo,
    prNumber,
    branch: `pr-${prNumber}`,
    comment: { path: "src/foo.ts", line: 10, body: "fix this", diffHunk: "@@ -1,3 +1,3 @@" },
  };
}

describe("enqueue and getQueue", () => {
  it("enqueues a fix and returns it in getQueue", () => {
    openStateDatabase();
    const req = makeFixRequest(100);
    enqueueFix(req);
    const queue = getFixQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].commentId).toBe(100);
    expect(queue[0].repo).toBe("owner/repo");
    expect(queue[0].prNumber).toBe(42);
    expect(queue[0].path).toBe("src/foo.ts");
  });

  it("rejects duplicate commentId", () => {
    openStateDatabase();
    const req = makeFixRequest(200);
    enqueueFix(req);
    expect(() => enqueueFix(req)).toThrow();
  });

  it("maintains FIFO order across multiple enqueues", () => {
    openStateDatabase();
    enqueueFix(makeFixRequest(301, 10, "a/b"));
    enqueueFix(makeFixRequest(302, 20, "c/d"));
    enqueueFix(makeFixRequest(303, 10, "a/b"));
    const queue = getFixQueue();
    expect(queue.map((q) => q.commentId)).toEqual([301, 302, 303]);
  });
});

describe("dequeueNextFix", () => {
  it("returns the first item and removes it", () => {
    openStateDatabase();
    enqueueFix(makeFixRequest(400));
    enqueueFix(makeFixRequest(401));
    const item = dequeueNextFix();
    expect(item?.commentId).toBe(400);
    expect(getFixQueue()).toHaveLength(1);
    expect(getFixQueue()[0].commentId).toBe(401);
  });

  it("returns null when queue is empty", () => {
    openStateDatabase();
    expect(dequeueNextFix()).toBeNull();
  });
});

describe("removeFromFixQueue", () => {
  it("removes a specific item by commentId", () => {
    openStateDatabase();
    enqueueFix(makeFixRequest(500));
    enqueueFix(makeFixRequest(501));
    const removed = removeFromFixQueue(500);
    expect(removed).toBe(true);
    expect(getFixQueue().map((q) => q.commentId)).toEqual([501]);
  });

  it("returns false for non-existent item", () => {
    openStateDatabase();
    expect(removeFromFixQueue(999)).toBe(false);
  });
});

describe("advanceQueue", () => {
  it("does nothing when a fix is running", () => {
    openStateDatabase();
    enqueueFix(makeFixRequest(600));
    vi.mocked(getAllFixJobStatuses).mockReturnValue([
      { commentId: 99, repo: "a/b", prNumber: 1, path: "x.ts", startedAt: Date.now(), status: "running" },
    ]);
    advanceQueue();
    expect(getFixQueue()).toHaveLength(1);
  });

  it("does nothing when a completed fix awaits review", () => {
    openStateDatabase();
    enqueueFix(makeFixRequest(601));
    vi.mocked(getAllFixJobStatuses).mockReturnValue([
      { commentId: 99, repo: "a/b", prNumber: 1, path: "x.ts", startedAt: Date.now(), status: "completed", diff: "..." },
    ]);
    advanceQueue();
    expect(getFixQueue()).toHaveLength(1);
  });

  it("advances past failed/awaiting_response jobs and starts next fix", () => {
    openStateDatabase();
    enqueueFix(makeFixRequest(602));
    vi.mocked(getAllFixJobStatuses).mockReturnValue([
      { commentId: 99, repo: "a/b", prNumber: 1, path: "x.ts", startedAt: Date.now(), status: "failed", error: "boom" },
    ]);
    vi.mocked(getRepos).mockReturnValue([{ repo: "owner/repo", localPath: "/tmp/repo" } as unknown as ReturnType<typeof getRepos>[0]]);
    advanceQueue();
    expect(getFixQueue()).toHaveLength(0);
    expect(setFixJobStatus).toHaveBeenCalledWith(expect.objectContaining({ commentId: 602, status: "running" }));
  });

  it("does nothing when queue is empty", () => {
    openStateDatabase();
    vi.mocked(getAllFixJobStatuses).mockReturnValue([]);
    advanceQueue();
    expect(getFixQueue()).toHaveLength(0);
  });
});
