import { describe, expect, it } from "vitest";
import { buildIgnoredBotSet, filterCommentsForPoll } from "./poller.js";

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
