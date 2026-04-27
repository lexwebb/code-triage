import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullPollData } from "./github-batching.js";

vi.mock("./exec.js", () => ({
  getGitHubViewerCached: vi.fn(),
  ghAsync: vi.fn(),
  ghAsyncSinglePage: vi.fn(),
  ghPost: vi.fn(),
}));

vi.mock("./github-batching.js", () => ({
  fetchOpenPullRequestsForRepos: vi.fn(),
  batchPullPollDataForRepos: vi.fn(),
  batchPullPollData: vi.fn(),
}));

vi.mock("./state.js", () => ({
  loadState: vi.fn(),
  markComment: vi.fn(),
  patchCommentTriage: vi.fn(),
  saveState: vi.fn(),
  addFixJob: vi.fn(),
  removeFixJob: vi.fn(),
  getFixJobs: vi.fn(() => []),
  getPendingTriageCountsByPr: vi.fn(() => new Map<string, number>()),
  needsEvaluation: vi.fn(),
  reconcileResolvedComments: vi.fn(),
}));

import { getGitHubViewerCached } from "./exec.js";
import { fetchOpenPullRequestsForRepos, batchPullPollDataForRepos } from "./github-batching.js";
import { buildPullSidebarLists } from "./api.js";

describe("buildPullSidebarLists review list", () => {
  beforeEach(() => {
    vi.mocked(getGitHubViewerCached).mockReset();
    vi.mocked(fetchOpenPullRequestsForRepos).mockReset();
    vi.mocked(batchPullPollDataForRepos).mockReset();
  });

  it("includes PRs that explicitly request the viewer", async () => {
    vi.mocked(getGitHubViewerCached).mockResolvedValue({
      login: "me",
      avatar_url: "https://example/avatar.png",
      html_url: "https://github.com/me",
    });

    const pulls = [{
      number: 101,
      title: "Needs review",
      user: { login: "author" },
      head: { ref: "feature/a", sha: "abc123" },
      base: { ref: "main" },
      html_url: "https://github.com/acme/repo/pull/101",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T01:00:00Z",
      draft: false,
      requested_reviewers: [{ login: "me" }],
    }];

    vi.mocked(fetchOpenPullRequestsForRepos).mockResolvedValue({
      pullsByRepo: new Map([["acme/repo", pulls]]),
      writableRepoPaths: new Set(["acme/repo"]),
    });

    const poll = new Map<number, PullPollData>([[
      101,
      {
        comments: [],
        resolvedIds: new Set<number>(),
        checksStatus: "success",
        hasHumanApproval: false,
      },
    ]]);
    vi.mocked(batchPullPollDataForRepos).mockResolvedValue(new Map([["acme/repo", poll]]));

    const lists = await buildPullSidebarLists([{ repo: "acme/repo", localPath: "/tmp/repo" }]);
    expect(lists.reviewRequested.map((r) => r.number)).toEqual([101]);
  });

  it("includes re-review PRs when review decision is REVIEW_REQUIRED", async () => {
    vi.mocked(getGitHubViewerCached).mockResolvedValue({
      login: "me",
      avatar_url: "https://example/avatar.png",
      html_url: "https://github.com/me",
    });

    const pulls = [{
      number: 202,
      title: "Reviewed earlier, now changed",
      user: { login: "author" },
      head: { ref: "feature/b", sha: "def456" },
      base: { ref: "main" },
      html_url: "https://github.com/acme/repo/pull/202",
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T03:00:00Z",
      draft: false,
      requested_reviewers: [],
      review_decision: "REVIEW_REQUIRED" as const,
    }];

    vi.mocked(fetchOpenPullRequestsForRepos).mockResolvedValue({
      pullsByRepo: new Map([["acme/repo", pulls]]),
      writableRepoPaths: new Set(["acme/repo"]),
    });

    const poll = new Map<number, PullPollData>([[
      202,
      {
        comments: [],
        resolvedIds: new Set<number>(),
        checksStatus: "success",
        hasHumanApproval: false,
      },
    ]]);
    vi.mocked(batchPullPollDataForRepos).mockResolvedValue(new Map([["acme/repo", poll]]));

    const lists = await buildPullSidebarLists([{ repo: "acme/repo", localPath: "/tmp/repo" }]);
    expect(lists.reviewRequested.map((r) => r.number)).toEqual([202]);
  });
});
