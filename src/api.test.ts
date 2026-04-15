import { describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { mergeConfigFromBody, serializeConfigForClient, toInt } from "./api.js";

const baseConfig: Config = {
  root: "~/src",
  port: 3100,
  interval: 1,
  evalConcurrency: 2,
  pollReviewRequested: false,
};

describe("toInt", () => {
  it("returns Math.floor for finite numbers", () => {
    expect(toInt(7.9, 0)).toBe(7);
    expect(toInt(-3.2, 0)).toBe(-4);
  });

  it("parses numeric strings", () => {
    expect(toInt("42", 0)).toBe(42);
    expect(toInt("  9 ", 0)).toBe(9);
  });

  it("uses fallback for non-numbers and NaN from parseInt", () => {
    expect(toInt("abc", 99)).toBeNaN();
    expect(toInt(Number.NaN, 3)).toBe(3);
    expect(toInt(undefined, 5)).toBe(5);
  });
});

describe("serializeConfigForClient", () => {
  it("fills defaults and hides raw tokens while indicating presence", () => {
    const c: Config = {
      ...baseConfig,
      githubToken: "secret",
      accounts: [{ name: "a1", token: "t", orgs: ["o"] }],
    };
    const out = serializeConfigForClient(c);
    expect(out.evalConcurrency).toBe(2);
    expect(out.pollReviewRequested).toBe(false);
    expect(out.commentRetentionDays).toBe(0);
    expect(out.hasGithubToken).toBe(true);
    expect(out.accounts).toEqual([{ name: "a1", orgs: ["o"], hasToken: true }]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("serializes optional prompt and claude args", () => {
    const c: Config = {
      ...baseConfig,
      evalPromptAppend: "always",
      evalPromptAppendByRepo: { "o/r": "repo bit" },
      evalClaudeExtraArgs: ["--model", "opus"],
    };
    const out = serializeConfigForClient(c);
    expect(out.evalPromptAppend).toBe("always");
    expect(out.evalPromptAppendByRepo).toEqual({ "o/r": "repo bit" });
    expect(out.evalClaudeExtraArgs).toEqual(["--model", "opus"]);
  });

  it("serializes team snapshot settings", () => {
    expect(serializeConfigForClient(baseConfig).team).toEqual({
      enabled: false,
      pollIntervalMinutes: 5,
    });
    const c: Config = { ...baseConfig, team: { enabled: true, pollIntervalMinutes: 9 } };
    expect(serializeConfigForClient(c).team).toEqual({ enabled: true, pollIntervalMinutes: 9 });
  });
});

describe("mergeConfigFromBody", () => {
  it("updates root and numeric fields from body", () => {
    const next = mergeConfigFromBody(
      { root: " /tmp/r ", port: "9000", interval: "5" },
      baseConfig,
    );
    expect(next.root).toBe("/tmp/r");
    expect(next.port).toBe(9000);
    expect(next.interval).toBe(5);
  });

  it("throws on invalid port or interval", () => {
    expect(() => mergeConfigFromBody({ root: "/x", port: 0 }, baseConfig)).toThrow(/port/);
    expect(() => mergeConfigFromBody({ root: "/x", interval: 0 }, baseConfig)).toThrow(/interval/);
  });

  it("merges ignoredBots and clears githubToken when body sends empty string", () => {
    const prev: Config = { ...baseConfig, githubToken: "old", ignoredBots: ["x"] };
    const next = mergeConfigFromBody(
      { root: "/z", githubToken: "", ignoredBots: [" bot-a ", "bot-b"] },
      prev,
    );
    expect(next.githubToken).toBeUndefined();
    expect(next.ignoredBots).toEqual(["bot-a", "bot-b"]);
  });

  it("throws when ignoredBots is not an array", () => {
    expect(() =>
      mergeConfigFromBody({ root: "/x", ignoredBots: "nope" } as Record<string, unknown>, baseConfig),
    ).toThrow(/ignoredBots/);
  });

  it("parses accounts with comma-separated orgs string", () => {
    const next = mergeConfigFromBody(
      {
        root: "/x",
        accounts: [{ name: "acc", orgs: "a, b", token: "tok" }],
      },
      baseConfig,
    );
    expect(next.accounts).toEqual([{ name: "acc", orgs: ["a", "b"], token: "tok" }]);
  });

  it("throws for account missing name or token", () => {
    expect(() =>
      mergeConfigFromBody(
        { root: "/x", accounts: [{ name: "", orgs: [], token: "t" }] },
        baseConfig,
      ),
    ).toThrow(/name/);
    expect(() =>
      mergeConfigFromBody({ root: "/x", accounts: [{ name: "n", orgs: [], token: "" }] }, baseConfig),
    ).toThrow(/token required/);
  });

  it("clears evalPromptAppend when body sends null or empty", () => {
    const prev: Config = { ...baseConfig, evalPromptAppend: "old" };
    expect(mergeConfigFromBody({ root: "/x", evalPromptAppend: null }, prev).evalPromptAppend).toBeUndefined();
    expect(mergeConfigFromBody({ root: "/x", evalPromptAppend: "" }, prev).evalPromptAppend).toBeUndefined();
  });

  it("throws for invalid evalPromptAppendByRepo type", () => {
    expect(() =>
      mergeConfigFromBody({ root: "/x", evalPromptAppendByRepo: [] }, baseConfig),
    ).toThrow(/evalPromptAppendByRepo/);
  });

  it("throws for evalClaudeExtraArgs when not an array", () => {
    expect(() =>
      mergeConfigFromBody({ root: "/x", evalClaudeExtraArgs: "bad" }, baseConfig),
    ).toThrow(/evalClaudeExtraArgs/);
  });

  it("merges team snapshot settings", () => {
    expect(mergeConfigFromBody({ root: "/x" }, baseConfig).team).toEqual({
      enabled: false,
      pollIntervalMinutes: 5,
    });
    const prev: Config = { ...baseConfig, team: { enabled: true, pollIntervalMinutes: 7 } };
    expect(
      mergeConfigFromBody({ root: "/x", team: { enabled: false, pollIntervalMinutes: "2" } }, prev).team,
    ).toEqual({ enabled: false, pollIntervalMinutes: 2 });
    expect(
      mergeConfigFromBody({ root: "/x", team: { enabled: true, pollIntervalMinutes: 0 } }, baseConfig).team,
    ).toEqual({ enabled: true, pollIntervalMinutes: 1 });
    expect(
      mergeConfigFromBody({ root: "/x", team: {} }, prev).team,
    ).toEqual({ enabled: true, pollIntervalMinutes: 7 });
  });
});
