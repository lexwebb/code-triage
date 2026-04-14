import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { closeStateDatabase, openStateDatabase } from "./db/client.js";
import { savePushSubscription, getAllPushSubscriptions, deletePushSubscription, mutePR, unmutePR, getMutedPRs, isPRMuted } from "./push-db.js";

describe("push subscription DB", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `push-db-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
    openStateDatabase();
  });

  afterEach(() => {
    closeStateDatabase();
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("stores and retrieves a push subscription", () => {
    savePushSubscription({
      endpoint: "https://push.example.com/send/abc",
      keys: { p256dh: "key1", auth: "key2" },
    });
    const subs = getAllPushSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe("https://push.example.com/send/abc");
    expect(subs[0].keys.p256dh).toBe("key1");
  });

  it("upserts on same endpoint", () => {
    savePushSubscription({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: "a", auth: "b" } });
    savePushSubscription({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: "c", auth: "d" } });
    const subs = getAllPushSubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].keys.p256dh).toBe("c");
  });

  it("deletes a push subscription by endpoint", () => {
    savePushSubscription({ endpoint: "https://push.example.com/send/abc", keys: { p256dh: "a", auth: "b" } });
    deletePushSubscription("https://push.example.com/send/abc");
    expect(getAllPushSubscriptions()).toHaveLength(0);
  });
});

describe("muted PRs DB", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `muted-db-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
    openStateDatabase();
  });

  afterEach(() => {
    closeStateDatabase();
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("mutes and lists PRs", () => {
    mutePR("owner/repo", 42);
    expect(getMutedPRs()).toEqual(["owner/repo:42"]);
  });

  it("unmutes a PR", () => {
    mutePR("owner/repo", 42);
    unmutePR("owner/repo", 42);
    expect(getMutedPRs()).toEqual([]);
  });

  it("isPRMuted returns correct status", () => {
    expect(isPRMuted("owner/repo", 42)).toBe(false);
    mutePR("owner/repo", 42);
    expect(isPRMuted("owner/repo", 42)).toBe(true);
  });
});
