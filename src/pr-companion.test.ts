import { describe, expect, it } from "vitest";
import {
  parseAndSizeBundle,
  validateBundleItems,
  buildCompanionPrompt,
  parseAndStripQueueFixDirectives,
  COMPANION_QUEUE_FIXES_FENCE,
} from "./pr-companion.js";

describe("pr-companion", () => {
  it("validateBundleItems filters invalid rows", () => {
    expect(validateBundleItems("x")).toEqual([]);
    expect(
      validateBundleItems([
        { commentId: 1, path: "a.ts", line: 2, body: "hi" },
        { commentId: "bad", path: "b.ts", line: 1, body: "x" },
      ]),
    ).toHaveLength(1);
  });

  it("parseAndSizeBundle rejects oversized JSON", () => {
    const hugeBody = "z".repeat(400_000);
    const r = parseAndSizeBundle([{ commentId: 1, path: "a.ts", line: 1, body: hugeBody }]);
    expect(r.error).toMatch(/too large/i);
    expect(r.items).toEqual([]);
  });

  it("buildCompanionPrompt includes bundle and user turn", () => {
    const p = buildCompanionPrompt(
      "o/r",
      9,
      [{ commentId: 1, path: "a.ts", line: 1, body: "c" }],
      [{ role: "user", content: "Summarize" }],
    );
    expect(p).toContain("o/r PR #9");
    expect(p).toContain('"commentId":1');
    expect(p).toContain("Summarize");
  });

  it("parseAndStripQueueFixDirectives extracts queueFixes and strips fence", () => {
    const raw = `Here is the plan.

\`\`\`${COMPANION_QUEUE_FIXES_FENCE}
{"queueFixes":[{"commentId":42,"userInstructions":"use X"}]}
\`\`\``;
    const { displayText, queueFixes } = parseAndStripQueueFixDirectives(raw);
    expect(displayText).toContain("Here is the plan");
    expect(displayText).not.toContain("queueFixes");
    expect(queueFixes).toEqual([{ commentId: 42, userInstructions: "use X" }]);
  });

  it("parseAndStripQueueFixDirectives caps list length and instruction size", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ commentId: i + 1 }));
    const raw = `\`\`\`${COMPANION_QUEUE_FIXES_FENCE}\n${JSON.stringify({ queueFixes: many })}\n\`\`\``;
    const { queueFixes } = parseAndStripQueueFixDirectives(raw);
    expect(queueFixes.length).toBe(12);
  });
});
