import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHealthPayload,
  getPollState,
  updatePollState,
  updateRepos,
} from "./server.js";

describe("getHealthPayload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes lastPollError", () => {
    updateRepos([{ repo: "a/b", localPath: "/x" }]);
    updatePollState({
      lastPoll: 1000,
      nextPoll: 2000,
      intervalMs: 60_000,
      polling: false,
      lastPollError: "GitHub timeout",
    });
    const h = getHealthPayload();
    expect(h.status).toBe("ok");
    expect(h.repos).toBe(1);
    expect(h.lastPollError).toBe("GitHub timeout");
    expect(h.fixJobsRunning).toBe(0);
  });

  it("getPollState returns poll fields", () => {
    const p = getPollState();
    expect(typeof p.polling).toBe("boolean");
    expect(Array.isArray(p.fixJobs)).toBe(true);
  });
});
