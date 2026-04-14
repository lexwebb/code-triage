import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeStateDatabase, getStateDir, getRawSqlite, openStateDatabase } from "./db/client.js";

vi.mock("./server.js", () => ({
  sseBroadcast: vi.fn(),
  getActiveFixForBranch: vi.fn(),
  fixJobStatuses: new Map(),
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
