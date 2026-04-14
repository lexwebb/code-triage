import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "fs";
import { configExists, loadConfig, saveConfig } from "./config.js";

describe("loadConfig", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when config file is missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const c = loadConfig();
    expect(c.root).toBe("~/src");
    expect(c.port).toBe(3100);
    expect(c.evalConcurrency).toBe(2);
  });

  it("merges JSON file with defaults", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ root: "/projects", port: 4000 }));
    const c = loadConfig();
    expect(c.root).toBe("/projects");
    expect(c.port).toBe(4000);
    expect(c.interval).toBe(1);
  });

  it("falls back to defaults on invalid JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{ not json");
    const c = loadConfig();
    expect(c.port).toBe(3100);
  });

  it("reads linear config fields", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ root: "/x", port: 3100, interval: 1, linearApiKey: "lin_api_test", linearTeamKeys: ["ENG"], ticketProvider: "linear" }),
    );
    const c = loadConfig();
    expect(c.linearApiKey).toBe("lin_api_test");
    expect(c.linearTeamKeys).toEqual(["ENG"]);
    expect(c.ticketProvider).toBe("linear");
  });

  it("returns undefined for linear fields when not set", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ root: "/x", port: 3100, interval: 1 }));
    const c = loadConfig();
    expect(c.linearApiKey).toBeUndefined();
    expect(c.linearTeamKeys).toBeUndefined();
    expect(c.ticketProvider).toBeUndefined();
  });
});

describe("configExists", () => {
  it("reflects existsSync for config path", () => {
    vi.mocked(existsSync).mockReturnValueOnce(true);
    expect(configExists()).toBe(true);
    vi.mocked(existsSync).mockReturnValueOnce(false);
    expect(configExists()).toBe(false);
  });
});

describe("saveConfig", () => {
  it("writes pretty-printed JSON via writeFileSync", () => {
    saveConfig({
      root: "/x",
      port: 3200,
      interval: 2,
    });
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [, json] = vi.mocked(writeFileSync).mock.calls[0]!;
    expect(JSON.parse(json as string)).toMatchObject({ root: "/x", port: 3200 });
  });
});
