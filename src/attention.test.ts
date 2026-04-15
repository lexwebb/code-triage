import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { dismissItem, getAttentionItems, pinItem, refreshAttentionFeed, snoozeItem } from "./attention.js";
import type { CoherenceAlert } from "./coherence.js";
import { closeStateDatabase, openStateDatabase } from "./db/client.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "attention-test-"));
  process.env.CODE_TRIAGE_STATE_DIR = tmpDir;
  openStateDatabase();
});

afterEach(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("refreshAttentionFeed", () => {
  it("inserts new coherence alerts", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "ENG-42 says in progress but branch is idle",
      stage: "pr-open",
      stuckSince: "2026-04-10T00:00:00.000Z",
    }];

    const { added } = refreshAttentionFeed(alerts);
    expect(added).toBe(1);

    const items = getAttentionItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("stale-in-progress:ENG-42");
    expect(items[0]?.pinned).toBe(false);
  });

  it("preserves snooze/dismiss/pin state across refreshes", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "ENG-42 says in progress but branch is idle",
    }];

    refreshAttentionFeed(alerts);
    pinItem("stale-in-progress:ENG-42");
    refreshAttentionFeed(alerts);

    const items = getAttentionItems({ includeAll: true });
    const item = items.find((i) => i.id === "stale-in-progress:ENG-42");
    expect(item?.pinned).toBe(true);
  });

  it("removes alerts that are no longer active", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "ENG-42 says in progress but branch is idle",
    }];

    refreshAttentionFeed(alerts);
    expect(getAttentionItems()).toHaveLength(1);
    refreshAttentionFeed([]);
    expect(getAttentionItems()).toHaveLength(0);
  });
});

describe("snoozeItem", () => {
  it("snoozes an item until a given time", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "test",
    }];
    refreshAttentionFeed(alerts);

    const until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    snoozeItem("stale-in-progress:ENG-42", until);

    expect(getAttentionItems()).toHaveLength(0);
    expect(getAttentionItems({ includeAll: true })).toHaveLength(1);
  });
});

describe("dismissItem", () => {
  it("dismisses an item", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "test",
    }];
    refreshAttentionFeed(alerts);
    dismissItem("stale-in-progress:ENG-42");

    expect(getAttentionItems()).toHaveLength(0);
  });

  it("re-fires if condition resolves and recurs", () => {
    const alerts: CoherenceAlert[] = [{
      id: "stale-in-progress:ENG-42",
      type: "stale-in-progress",
      entityKind: "ticket",
      entityIdentifier: "ENG-42",
      priority: "medium",
      title: "test",
    }];
    refreshAttentionFeed(alerts);
    dismissItem("stale-in-progress:ENG-42");

    refreshAttentionFeed([]);
    expect(getAttentionItems({ includeAll: true })).toHaveLength(0);

    refreshAttentionFeed(alerts);
    const items = getAttentionItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.dismissedAt).toBeUndefined();
  });
});
