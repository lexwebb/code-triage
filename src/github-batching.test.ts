import { describe, expect, it } from "vitest";
import { summarizeChecksFromSuites } from "./github-batching.js";

describe("summarizeChecksFromSuites", () => {
  it("ignores suite-level pending when no check runs exist", () => {
    const summary = summarizeChecksFromSuites([
      {
        status: "in_progress",
        conclusion: null,
        checkRuns: { nodes: [] },
      },
      {
        status: "completed",
        conclusion: "success",
        checkRuns: {
          nodes: [{ status: "completed", conclusion: "success" }],
        },
      },
    ]);

    expect(summary).toEqual({ success: 1, failure: 0, pending: 0 });
  });
});
import { describe, expect, it } from "vitest";
import {
  isRepositoryWritePermission,
  sliceOpenPullsResult,
  type FetchOpenPullsResult,
  type OpenPull,
} from "./github-batching.js";

describe("isRepositoryWritePermission", () => {
  it("is true for ADMIN, MAINTAIN, WRITE", () => {
    expect(isRepositoryWritePermission("ADMIN")).toBe(true);
    expect(isRepositoryWritePermission("MAINTAIN")).toBe(true);
    expect(isRepositoryWritePermission("WRITE")).toBe(true);
  });

  it("is false for READ, TRIAGE, and missing", () => {
    expect(isRepositoryWritePermission("READ")).toBe(false);
    expect(isRepositoryWritePermission("TRIAGE")).toBe(false);
    expect(isRepositoryWritePermission(null)).toBe(false);
    expect(isRepositoryWritePermission(undefined)).toBe(false);
  });
});

describe("sliceOpenPullsResult", () => {
  it("projects a superset map onto requested repo paths", () => {
    const full: FetchOpenPullsResult = {
      pullsByRepo: new Map<string, OpenPull[]>([
        ["a/b", [{ number: 1, title: "", user: { login: "x" }, head: { ref: "h" }, html_url: "", requested_reviewers: [] }]],
        ["c/d", [{ number: 2, title: "", user: { login: "x" }, head: { ref: "h" }, html_url: "", requested_reviewers: [] }]],
      ]),
      writableRepoPaths: new Set(["a/b"]),
    };
    const sliced = sliceOpenPullsResult(full, ["c/d"]);
    expect([...sliced.pullsByRepo.keys()]).toEqual(["c/d"]);
    expect(sliced.writableRepoPaths.size).toBe(0);
  });
});
