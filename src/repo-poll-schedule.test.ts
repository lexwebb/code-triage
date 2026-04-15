import { afterEach, describe, expect, it } from "vitest";
import { closeStateDatabase, getStateDir } from "./db/client.js";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { recordPollOutcomes, selectReposToPoll } from "./repo-poll-schedule.js";

let testRoot: string;

describe("repo poll schedule", () => {
  afterEach(() => {
    closeStateDatabase();
    delete process.env.CODE_TRIAGE_STATE_DIR;
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("polls all repos when no rows exist", () => {
    testRoot = mkdtempSync(join(tmpdir(), "ct-rps-"));
    process.env.CODE_TRIAGE_STATE_DIR = testRoot;
    mkdirSync(getStateDir(), { recursive: true });
    const repos = ["a/b", "c/d"];
    const out = selectReposToPoll(repos, Date.now(), { staleAfterDays: 7, coldIntervalMinutes: 60 });
    expect(out.sort()).toEqual(repos.sort());
  });

  it("first poll with no triage activity is cold until cold interval elapses", () => {
    testRoot = mkdtempSync(join(tmpdir(), "ct-rps-"));
    process.env.CODE_TRIAGE_STATE_DIR = testRoot;
    mkdirSync(getStateDir(), { recursive: true });
    const t0 = 1_000_000_000_000;
    const coldMs = 60 * 60_000;
    recordPollOutcomes([{ repo: "idle", hadActivity: false }], t0);
    expect(selectReposToPoll(["idle"], t0 + 30_000, { staleAfterDays: 7, coldIntervalMinutes: 60 })).toEqual([]);
    expect(selectReposToPoll(["idle"], t0 + coldMs + 1, { staleAfterDays: 7, coldIntervalMinutes: 60 })).toEqual(["idle"]);
  });

  it("super-cold multiplier delays repos with no recorded activity", () => {
    testRoot = mkdtempSync(join(tmpdir(), "ct-rps-"));
    process.env.CODE_TRIAGE_STATE_DIR = testRoot;
    mkdirSync(getStateDir(), { recursive: true });
    const t0 = 1_000_000_000_000;
    const coldMs = 60 * 60_000;
    recordPollOutcomes([{ repo: "idle", hadActivity: false }], t0);
    expect(
      selectReposToPoll(["idle"], t0 + coldMs + 1, {
        staleAfterDays: 7,
        coldIntervalMinutes: 60,
        superColdMultiplier: 3,
      }),
    ).toEqual([]);
    expect(
      selectReposToPoll(["idle"], t0 + (coldMs * 3) + 1, {
        staleAfterDays: 7,
        coldIntervalMinutes: 60,
        superColdMultiplier: 3,
      }),
    ).toEqual(["idle"]);
  });

  it("cold repo is skipped until cold interval elapses after last poll", () => {
    testRoot = mkdtempSync(join(tmpdir(), "ct-rps-"));
    process.env.CODE_TRIAGE_STATE_DIR = testRoot;
    mkdirSync(getStateDir(), { recursive: true });
    const t0 = 1_000_000_000_000;
    const staleMs = 7 * 86_400_000;
    const coldMs = 60 * 60_000;
    recordPollOutcomes([{ repo: "x", hadActivity: true }], t0);
    const tCold = t0 + staleMs + 1;
    recordPollOutcomes([{ repo: "x", hadActivity: false }], tCold);

    expect(selectReposToPoll(["x"], tCold, { staleAfterDays: 7, coldIntervalMinutes: 60 })).toEqual([]);
    expect(selectReposToPoll(["x"], tCold + coldMs + 1, { staleAfterDays: 7, coldIntervalMinutes: 60 })).toEqual(["x"]);
  });

  it("disabling adaptive returns all repos", () => {
    testRoot = mkdtempSync(join(tmpdir(), "ct-rps-"));
    process.env.CODE_TRIAGE_STATE_DIR = testRoot;
    mkdirSync(getStateDir(), { recursive: true });
    const repos = ["a/b", "c/d"];
    expect(selectReposToPoll(repos, Date.now(), { staleAfterDays: 0, coldIntervalMinutes: 60 })).toEqual(repos);
    expect(selectReposToPoll(repos, Date.now(), { staleAfterDays: 7, coldIntervalMinutes: 0 })).toEqual(repos);
  });
});
