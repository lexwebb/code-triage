import { describe, expect, it } from "vitest";
import { buildPrCompanionBundle, COMPANION_TRUNCATE_BODY } from "./pr-companion-bundle.js";
import type { ReviewComment } from "../types.js";

function root(partial: Partial<ReviewComment> & Pick<ReviewComment, "id" | "path" | "line" | "body">): ReviewComment {
  return {
    author: "a",
    authorAvatar: "",
    path: partial.path,
    line: partial.line,
    diffHunk: partial.diffHunk ?? "",
    body: partial.body,
    createdAt: "",
    inReplyToId: null,
    isResolved: partial.isResolved ?? false,
    evaluation: partial.evaluation ?? null,
    crStatus: partial.crStatus ?? null,
    id: partial.id,
    ...partial,
  };
}

describe("buildPrCompanionBundle", () => {
  it("includes only fix threads by default", () => {
    const comments: ReviewComment[] = [
      root({ id: 1, path: "a.ts", line: 1, body: "fix me", evaluation: { action: "fix", summary: "s" } }),
      root({ id: 2, path: "b.ts", line: 2, body: "reply only", evaluation: { action: "reply", summary: "s", reply: "ok" } }),
    ];
    const b = buildPrCompanionBundle(comments);
    expect(b.map((x) => x.commentId)).toEqual([1]);
  });

  it("excludes resolved root threads", () => {
    const comments: ReviewComment[] = [
      root({
        id: 1,
        path: "a.ts",
        line: 1,
        body: "x",
        isResolved: true,
        evaluation: { action: "fix", summary: "s" },
      }),
    ];
    expect(buildPrCompanionBundle(comments)).toEqual([]);
  });

  it("includeAllEvaluated adds reply threads", () => {
    const comments: ReviewComment[] = [
      root({ id: 2, path: "b.ts", line: 2, body: "reply only", evaluation: { action: "reply", summary: "s", reply: "ok" } }),
    ];
    const b = buildPrCompanionBundle(comments, { includeAllEvaluated: true });
    expect(b).toHaveLength(1);
    expect(b[0]!.commentId).toBe(2);
  });

  it("truncates long bodies", () => {
    const long = "x".repeat(COMPANION_TRUNCATE_BODY + 100);
    const comments: ReviewComment[] = [
      root({ id: 1, path: "a.ts", line: 1, body: long, evaluation: { action: "fix", summary: "s" } }),
    ];
    const b = buildPrCompanionBundle(comments);
    expect(b[0]!.body.length).toBeLessThan(long.length);
    expect(b[0]!.body).toContain("(truncated)");
  });
});
