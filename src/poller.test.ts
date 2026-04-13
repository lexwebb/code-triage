import { describe, expect, it } from "vitest";
import { buildIgnoredBotSet, filterCommentsForPoll, selectPollPulls } from "./poller.js";

function pr(
  n: number,
  author: string,
  reviewers: string[] = [],
): {
  number: number;
  title: string;
  user: { login: string };
  head: { ref: string };
  html_url: string;
  requested_reviewers: Array<{ login: string }>;
} {
  return {
    number: n,
    title: `PR ${n}`,
    user: { login: author },
    head: { ref: "b" },
    html_url: `https://example/${n}`,
    requested_reviewers: reviewers.map((login) => ({ login })),
  };
}

describe("selectPollPulls", () => {
  const me = "alice";

  it("returns only authored PRs when pollReviewRequested is false", () => {
    const pulls = [pr(1, me), pr(2, "bob", [me]), pr(3, "carol", [])];
    const out = selectPollPulls(pulls, me, false);
    expect(out.map((p) => p.number)).toEqual([1]);
  });

  it("includes review-requested PRs when enabled", () => {
    const pulls = [pr(1, me), pr(2, "bob", [me]), pr(3, "carol", ["other"])];
    const out = selectPollPulls(pulls, me, true);
    expect(out.map((p) => p.number).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("dedupes by PR number if both rules match (defensive)", () => {
    const p = pr(1, me, [me]);
    const out = selectPollPulls([p], me, true);
    expect(out).toHaveLength(1);
  });
});

describe("buildIgnoredBotSet", () => {
  it("includes built-in bots and config extras", () => {
    const s = buildIgnoredBotSet(["custom[bot]"]);
    expect(s.has("dependabot[bot]")).toBe(true);
    expect(s.has("custom[bot]")).toBe(true);
  });
});

describe("filterCommentsForPoll", () => {
  const comments = [
    { id: 1, user: { login: "dependabot[bot]" } },
    { id: 2, user: { login: "coderabbitai[bot]" } },
    { id: 3, user: { login: "human" } },
  ];

  it("removes ignored bots, resolved threads, and already-seen ids", () => {
    const ignored = buildIgnoredBotSet();
    const resolved = new Set<number>([3]);
    const isNew = (id: number) => id !== 2;
    const out = filterCommentsForPoll(comments, resolved, ignored, isNew);
    expect(out.map((c) => c.id)).toEqual([]);
  });

  it("keeps new comments from non-ignored authors in open threads", () => {
    const ignored = buildIgnoredBotSet();
    const resolved = new Set<number>();
    const isNew = () => true;
    const out = filterCommentsForPoll(comments, resolved, ignored, isNew);
    expect(out.map((c) => c.id)).toEqual([2, 3]);
  });
});
