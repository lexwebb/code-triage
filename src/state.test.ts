import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeStateDatabase, getStateDir } from "./db/client.js";
import { compactCommentHistory, isNewComment, loadState, markComment, markCommentWithEvaluation, needsEvaluation, markEvaluating, markEvalFailed, patchCommentTriage, saveState } from "./state.js";

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

  it("patchCommentTriage upserts pending row and markComment keeps triage fields", () => {
    let s = loadState();
    patchCommentTriage(s, 99, "o/r", 3, { triageNote: "later", priority: 2, snoozeUntil: "2099-01-01T00:00:00.000Z" });
    saveState(s);
    s = loadState();
    expect(s.comments["o/r:99"]?.status).toBe("pending");
    expect(s.comments["o/r:99"]?.triageNote).toBe("later");
    expect(s.comments["o/r:99"]?.priority).toBe(2);

    markComment(s, 99, "replied", 3, "o/r");
    saveState(s);
    s = loadState();
    expect(s.comments["o/r:99"]?.status).toBe("replied");
    expect(s.comments["o/r:99"]?.triageNote).toBe("later");
    expect(s.comments["o/r:99"]?.priority).toBe(2);
  });
});

describe("evaluation state helpers", () => {
  it("needsEvaluation returns true for comments without evaluation", () => {
    const s = loadState();
    expect(needsEvaluation(s, 100, "o/r")).toBe(true);
    markComment(s, 100, "pending", 1, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 100, "o/r")).toBe(true);
  });

  it("needsEvaluation returns false for comments with evaluation", () => {
    const s = loadState();
    markCommentWithEvaluation(s, 200, "pending", 1, { action: "reply", summary: "ok", reply: "hi" }, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 200, "o/r")).toBe(false);
  });

  it("needsEvaluation returns false for evaluating status", () => {
    const s = loadState();
    markEvaluating(s, 300, 1, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 300, "o/r")).toBe(false);
  });

  it("needsEvaluation returns false for acted-on comments", () => {
    const s = loadState();
    markComment(s, 400, "replied", 1, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 400, "o/r")).toBe(false);
  });

  it("needsEvaluation returns false for dead-lettered (evalFailed) comments", () => {
    const s = loadState();
    markEvaluating(s, 700, 1, "o/r");
    markEvalFailed(s, 700, "o/r");
    saveState(s);
    expect(needsEvaluation(loadState(), 700, "o/r")).toBe(false);
  });

  it("markEvaluating sets status to evaluating", () => {
    const s = loadState();
    markEvaluating(s, 500, 1, "o/r");
    saveState(s);
    const loaded = loadState();
    expect(loaded.comments["o/r:500"]?.status).toBe("evaluating");
  });

  it("markEvalFailed sets evalFailed and pending status", () => {
    const s = loadState();
    markEvaluating(s, 600, 1, "o/r");
    markEvalFailed(s, 600, "o/r");
    saveState(s);
    const loaded = loadState();
    expect(loaded.comments["o/r:600"]?.status).toBe("pending");
    expect(loaded.comments["o/r:600"]?.evalFailed).toBe(true);
  });
});
