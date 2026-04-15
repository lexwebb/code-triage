import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { closeStateDatabase, openStateDatabase } from "../db/client.js";
import { readTeamOverviewCache, writeTeamOverviewCache, type TeamOverviewSnapshot } from "./overview.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "team-overview-test-"));
  process.env.CODE_TRIAGE_STATE_DIR = tmpDir;
  openStateDatabase();
});

afterEach(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("team overview cache", () => {
  it("round-trips snapshot", () => {
    const snap: TeamOverviewSnapshot = {
      generatedAt: "2026-04-15T00:00:00.000Z",
      summaryCounts: { stuck: 1, awaitingReview: 2, recentlyMerged: 3, unlinkedPrs: 4, unlinkedTickets: 5 },
      stuck: [],
      awaitingReview: [],
      recentlyMerged: [],
      unlinkedPrs: [],
      unlinkedTickets: [],
    };
    writeTeamOverviewCache(snap, null);
    const read = readTeamOverviewCache();
    expect(read?.snapshot.summaryCounts.stuck).toBe(1);
    expect(read?.refreshError).toBeNull();
  });
});
