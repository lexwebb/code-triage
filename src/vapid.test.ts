import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("VAPID key management", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `vapid-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("generates and persists VAPID keys on first call", async () => {
    const { getVapidKeys } = await import("./vapid.js");
    const keys = getVapidKeys();
    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();
    expect(existsSync(join(testDir, "vapid.json"))).toBe(true);
  });

  it("returns same keys on subsequent calls", async () => {
    const { getVapidKeys } = await import("./vapid.js");
    const first = getVapidKeys();
    const second = getVapidKeys();
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.privateKey).toBe(second.privateKey);
  });

  it("loads existing keys from disk", async () => {
    const { getVapidKeys } = await import("./vapid.js");
    const original = getVapidKeys();
    const stored = JSON.parse(readFileSync(join(testDir, "vapid.json"), "utf-8"));
    expect(stored.publicKey).toBe(original.publicKey);
    expect(stored.privateKey).toBe(original.privateKey);
  });
});
