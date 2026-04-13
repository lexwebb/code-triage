import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeStateDatabase, getStateDir } from "./db/client.js";
import { compactCommentHistory, isNewComment, loadState, markComment, markCommentWithEvaluation, saveState } from "./state.js";

let testRoot: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "code-triage-"));
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
    if (existsSync(p)) {
      rmSync(p);
    }
  }
});

describe("state persistence", () => {
  it("roundtrips comments and lastPoll through SQLite", () => {
    const s = loadState();
    markComment(s, 42, "pending", 7, "owner/repo");
    s.lastPoll = "2026-04-13T12:00:00.000Z";
    saveState(s);

    const again = loadState();
    expect(again.lastPoll).toBe("2026-04-13T12:00:00.000Z");
    expect(again.comments["owner/repo:42"]?.status).toBe("pending");
    expect(again.comments["owner/repo:42"]?.prNumber).toBe(7);
  });

  it("isNewComment matches prefixed keys and legacy numeric keys", () => {
    let s = loadState();
    expect(isNewComment(s, 10, "a/b")).toBe(true);
    markComment(s, 10, "pending", 1, "a/b");
    saveState(s);
    s = loadState();
    expect(isNewComment(s, 10, "a/b")).toBe(false);
    expect(isNewComment(s, 10)).toBe(true);
    markComment(s, 10, "pending", 1);
    saveState(s);
    s = loadState();
    expect(isNewComment(s, 10)).toBe(false);
  });

  it("compactCommentHistory removes only old terminal statuses", () => {
    let s = loadState();
    const old = "2020-01-01T00:00:00.000Z";
    markCommentWithEvaluation(
      s,
      1,
      "replied",
      1,
      { action: "reply", summary: "x", reply: "y" },
      "o/r",
    );
    s.comments["o/r:1"]!.timestamp = old;
    markComment(s, 2, "pending", 1, "o/r");
    s.comments["o/r:2"]!.timestamp = old;
    saveState(s);

    const removed = compactCommentHistory(30);
    expect(removed).toBe(1);
    s = loadState();
    expect(s.comments["o/r:1"]).toBeUndefined();
    expect(s.comments["o/r:2"]?.status).toBe("pending");
  });
});
