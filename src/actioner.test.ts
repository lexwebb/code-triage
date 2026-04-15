import { afterEach, describe, expect, it, vi } from "vitest";
import { clampEvalConcurrency, fixClaudePermissionArgv, parseEvaluation, parseFixResponse } from "./actioner.js";
import { log } from "./logger.js";

describe("fixClaudePermissionArgv", () => {
  it("uses dontAsk mode and never bypasses permissions", () => {
    const argv = fixClaudePermissionArgv();
    const modeIdx = argv.indexOf("--permission-mode");
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(argv[modeIdx + 1]).toBe("dontAsk");
    expect(argv.join(" ")).not.toContain("dangerously-skip-permissions");
    expect(argv).toContain("--tools");
    expect(argv).toContain("--allowed-tools");
  });
});

describe("parseFixResponse", () => {
  it("parses a fix action from CLI JSON output", () => {
    const cliOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify({ action: "fix", message: "Applied the guard clause" }),
    });
    const parsed = parseFixResponse(cliOutput);
    expect(parsed).toEqual({ action: "fix", message: "Applied the guard clause" });
  });

  it("parses a questions action from CLI JSON output", () => {
    const cliOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify({ action: "questions", message: "Should I use Option A or B?" }),
    });
    const parsed = parseFixResponse(cliOutput);
    expect(parsed).toEqual({ action: "questions", message: "Should I use Option A or B?" });
  });

  it("falls back to fix action when result is not valid JSON", () => {
    const cliOutput = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "I made the changes as requested.",
    });
    const parsed = parseFixResponse(cliOutput);
    expect(parsed).toEqual({ action: "fix", message: "I made the changes as requested." });
  });

  it("falls back to fix action when CLI output is not JSON at all", () => {
    const parsed = parseFixResponse("Some plain text output from claude");
    expect(parsed).toEqual({ action: "fix", message: "Some plain text output from claude" });
  });
});

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
