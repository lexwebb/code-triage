import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHealthPayload,
  getPollState,
  triggerTestNotification,
  updatePollState,
  updateRepos,
} from "./server.js";

describe("getPollState", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not consume test notification when consumeTestNotification is false", () => {
    triggerTestNotification();
    const a = getPollState({ consumeTestNotification: false });
    expect(a.testNotification).toBe(false);
    const b = getPollState({ consumeTestNotification: true });
    expect(b.testNotification).toBe(true);
    const c = getPollState({ consumeTestNotification: true });
    expect(c.testNotification).toBe(false);
  });
});

describe("getHealthPayload", () => {
  it("includes lastPollError and never consumes test notification", () => {
    updateRepos([{ repo: "a/b", localPath: "/x" }]);
    updatePollState({
      lastPoll: 1000,
      nextPoll: 2000,
      intervalMs: 60_000,
      polling: false,
      lastPollError: "GitHub timeout",
    });
    triggerTestNotification();
    const h = getHealthPayload();
    expect(h.status).toBe("ok");
    expect(h.repos).toBe(1);
    expect(h.lastPollError).toBe("GitHub timeout");
    expect(h.fixJobsRunning).toBe(0);
    const p = getPollState({ consumeTestNotification: true });
    expect(p.testNotification).toBe(true);
  });
});
