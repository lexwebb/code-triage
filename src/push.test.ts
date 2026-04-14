import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { closeStateDatabase, openStateDatabase } from "./db/client.js";
import { savePushSubscription } from "./push-db.js";
import { mutePR } from "./push-db.js";

// Mock web-push to avoid actual push sends
const { mockWebPushSendNotification } = vi.hoisted(() => ({
  mockWebPushSendNotification: vi.fn().mockResolvedValue({}),
}));
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "fake-pub", privateKey: "fake-priv" }),
    setVapidDetails: vi.fn(),
    sendNotification: mockWebPushSendNotification,
  },
}));

// Mock notifier module
const { mockSendNotification } = vi.hoisted(() => ({
  mockSendNotification: vi.fn(),
}));
vi.mock("./notifier.js", () => ({
  sendNotification: mockSendNotification,
}));

import { processPolledData, initPush, resetPushState, notifyEvalComplete, notifyFixJobComplete, sendTestPush } from "./push.js";
describe("push notification module", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `push-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.CODE_TRIAGE_STATE_DIR = testDir;
    openStateDatabase();
    resetPushState();
    vi.clearAllMocks();
    initPush();
  });

  afterEach(() => {
    closeStateDatabase();
    delete process.env.CODE_TRIAGE_STATE_DIR;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("does not send notifications on first poll (baseline)", () => {
    processPolledData({
      authored: [{ repo: "owner/repo", number: 1, title: "PR 1", checksStatus: "pending", openComments: 0 }],
      reviewRequested: [],
    });
    expect(mockWebPushSendNotification).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("sends push for new review request on second poll", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    processPolledData({ authored: [], reviewRequested: [] });
    processPolledData({
      authored: [],
      reviewRequested: [{ repo: "owner/repo", number: 5, title: "New PR", checksStatus: "pending", openComments: 0 }],
    });

    expect(mockWebPushSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((mockWebPushSendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("Review requested");
  });

  it("sends push for CI status change", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    processPolledData({
      authored: [{ repo: "owner/repo", number: 1, title: "My PR", checksStatus: "pending", openComments: 0 }],
      reviewRequested: [],
    });
    processPolledData({
      authored: [{ repo: "owner/repo", number: 1, title: "My PR", checksStatus: "success", openComments: 0 }],
      reviewRequested: [],
    });

    expect(mockWebPushSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((mockWebPushSendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("Checks passed");
  });

  it("sends push for new comments", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    processPolledData({
      authored: [{ repo: "owner/repo", number: 1, title: "My PR", checksStatus: "pending", openComments: 0 }],
      reviewRequested: [],
    });
    processPolledData({
      authored: [{ repo: "owner/repo", number: 1, title: "My PR", checksStatus: "pending", openComments: 3 }],
      reviewRequested: [],
    });

    expect(mockWebPushSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((mockWebPushSendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("3 new comments");
  });

  it("falls back to node-notifier when no subscriptions exist", () => {
    processPolledData({ authored: [], reviewRequested: [] });
    processPolledData({
      authored: [],
      reviewRequested: [{ repo: "owner/repo", number: 5, title: "New PR", checksStatus: "pending", openComments: 0 }],
    });

    expect(mockWebPushSendNotification).not.toHaveBeenCalled();
    expect(mockSendNotification).toHaveBeenCalled();
  });

  it("respects muted PRs", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });
    mutePR("owner/repo", 5);

    processPolledData({ authored: [], reviewRequested: [] });
    processPolledData({
      authored: [],
      reviewRequested: [{ repo: "owner/repo", number: 5, title: "Muted PR", checksStatus: "pending", openComments: 0 }],
    });

    expect(mockWebPushSendNotification).not.toHaveBeenCalled();
  });

  it("notifyEvalComplete sends push for analyzed comment", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    notifyEvalComplete({
      repo: "owner/repo", prNumber: 1, commentId: 42,
      path: "src/index.ts", line: 10, action: "fix", summary: "Missing null check",
    });

    expect(mockWebPushSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((mockWebPushSendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("Needs fix");
  });

  it("notifyFixJobComplete sends push for completed fix", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    notifyFixJobComplete({
      repo: "owner/repo", prNumber: 1, commentId: 42, path: "src/index.ts", status: "completed",
    });

    expect(mockWebPushSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((mockWebPushSendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("Fix ready");
  });

  it("notifyFixJobComplete sends push for failed fix", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });

    notifyFixJobComplete({
      repo: "owner/repo", prNumber: 1, commentId: 42, path: "src/index.ts", status: "failed", error: "Timeout",
    });

    expect(mockWebPushSendNotification).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((mockWebPushSendNotification as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(payload.title).toContain("Fix failed");
  });

  it("sendTestPush sends a test notification", () => {
    savePushSubscription({ endpoint: "https://push.example.com/abc", keys: { p256dh: "a", auth: "b" } });
    sendTestPush();
    expect(mockWebPushSendNotification).toHaveBeenCalledTimes(1);
  });
});
