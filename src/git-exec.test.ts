import { afterEach, describe, expect, it } from "vitest";
import { formatGitExecError, gitBinary, resetGitBinaryCacheForTests } from "./git-exec.js";

describe("gitBinary", () => {
  afterEach(() => {
    delete process.env.CODE_TRIAGE_GIT;
    delete process.env.GIT_BINARY;
    resetGitBinaryCacheForTests();
  });

  it("prefers CODE_TRIAGE_GIT", () => {
    process.env.CODE_TRIAGE_GIT = "/custom/git";
    expect(gitBinary()).toBe("/custom/git");
  });

  it("falls back to GIT_BINARY when CODE_TRIAGE_GIT unset", () => {
    process.env.GIT_BINARY = "/other/git";
    expect(gitBinary()).toBe("/other/git");
  });

  it("memoizes the resolved path", () => {
    process.env.CODE_TRIAGE_GIT = "/first/git";
    expect(gitBinary()).toBe("/first/git");
    process.env.CODE_TRIAGE_GIT = "/second/git";
    expect(gitBinary()).toBe("/first/git");
  });
});

describe("formatGitExecError", () => {
  it("includes stderr and exit status when present", () => {
    const err = Object.assign(new Error("Command failed"), {
      code: "ENOENT",
      errno: -2,
      status: 1,
      stderr: "fatal: not a git repo\n",
    });
    const s = formatGitExecError(err);
    expect(s).toContain("ENOENT");
    expect(s).toContain("exit=1");
    expect(s).toContain("not a git repo");
  });
});
