import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";
import { getWorktreePath } from "./worktree.js";

describe("getWorktreePath", () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it("uses sanitized branch segment under .cr-worktrees", () => {
    vi.mocked(execFileSync).mockReturnValue("/abs/repo/root\n");
    const p = getWorktreePath("feature/foo!bar");
    expect(p).toBe(join("/abs/repo/root", ".cr-worktrees", "feature-foo-bar"));
  });
});
