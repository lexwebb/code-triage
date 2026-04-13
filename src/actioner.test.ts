import { afterEach, describe, expect, it, vi } from "vitest";
import { clampEvalConcurrency, parseEvaluation } from "./actioner.js";
import { log } from "./logger.js";

describe("clampEvalConcurrency", () => {
  it("clamps to 1–8 and floors", () => {
    expect(clampEvalConcurrency(0)).toBe(1);
    expect(clampEvalConcurrency(100)).toBe(8);
    expect(clampEvalConcurrency(2.7)).toBe(2);
    expect(clampEvalConcurrency(Number.NaN)).toBe(2);
  });
});

describe("parseEvaluation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses valid JSON", () => {
    const raw = `{"action":"reply","summary":"short","reply":"thanks"}`;
    expect(parseEvaluation(raw)).toMatchObject({
      action: "reply",
      summary: "short",
      reply: "thanks",
    });
  });

  it("extracts JSON object embedded in surrounding text", () => {
    const raw = `prefix {"action":"resolve","summary":"done","reply":"ok"} suffix`;
    expect(parseEvaluation(raw)).toMatchObject({ action: "resolve", summary: "done" });
  });

  it("infers fix from prose when JSON is absent", () => {
    vi.spyOn(log, "warn").mockImplementation((_msg: string) => {});
    expect(parseEvaluation("needs a code change here")).toMatchObject({ action: "fix" });
  });
});
