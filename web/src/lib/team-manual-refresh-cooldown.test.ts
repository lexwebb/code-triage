import { describe, it, expect } from "vitest";
import { teamManualRefreshAllowed, TEAM_MANUAL_REFRESH_COOLDOWN_MS } from "./team-manual-refresh-cooldown.js";

describe("teamManualRefreshAllowed", () => {
  it("allows first trigger", () => {
    expect(teamManualRefreshAllowed(null, 1_000)).toBe(true);
  });

  it("blocks within cooldown window", () => {
    const t0 = 1_000_000;
    expect(teamManualRefreshAllowed(t0, t0 + TEAM_MANUAL_REFRESH_COOLDOWN_MS - 1)).toBe(false);
  });

  it("allows after cooldown window", () => {
    const t0 = 1_000_000;
    expect(teamManualRefreshAllowed(t0, t0 + TEAM_MANUAL_REFRESH_COOLDOWN_MS)).toBe(true);
  });
});
