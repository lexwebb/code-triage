import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { closeStateDatabase, openStateDatabase } from "../db/client.js";
import {
  memberSummaryWorkFingerprint,
  teamMemberWorkAggregateFingerprint,
  enrichMemberSummariesWithAiDigests,
  readMemberAiDigestFromDb,
  writeMemberAiDigestToDb,
} from "./member-summary-ai.js";
import type { TeamOverviewSnapshot } from "./overview.js";

const { mockPrompt } = vi.hoisted(() => ({ mockPrompt: vi.fn() }));

vi.mock("../actioner.js", () => ({
  runPrCompanionPrompt: mockPrompt,
}));

/** Snapshot time for digest age checks (items without activityAt still count as recent). */
const SNAP_ISO = "2026-05-15T12:00:00.000Z";
const REF_MS = Date.parse(SNAP_ISO);

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "member-summary-ai-"));
  process.env.CODE_TRIAGE_STATE_DIR = tmpDir;
  openStateDatabase();
  mockPrompt.mockReset();
});

afterEach(() => {
  closeStateDatabase();
  delete process.env.CODE_TRIAGE_STATE_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("memberSummaryWorkFingerprint", () => {
  it("is stable for same items regardless of bucket order in source arrays", () => {
    const item = {
      entityKind: "pr" as const,
      entityIdentifier: "o/r#1",
      title: "Fix bug",
      lifecycleStage: "in_review",
      lifecycleStuck: false,
      activityAt: "2026-05-10T00:00:00.000Z",
    };
    const a = memberSummaryWorkFingerprint(
      { workingOn: [item], waiting: [], comingUp: [] },
      REF_MS,
    );
    const b = memberSummaryWorkFingerprint(
      { workingOn: [item], waiting: [], comingUp: [] },
      REF_MS,
    );
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("changes when lifecycle stage changes", () => {
    const base = {
      entityKind: "ticket" as const,
      entityIdentifier: "ENG-1",
      title: "Task",
      lifecycleStage: "started",
      lifecycleStuck: false,
      activityAt: "2026-05-10T00:00:00.000Z",
    };
    const fp1 = memberSummaryWorkFingerprint({ workingOn: [base], waiting: [], comingUp: [] }, REF_MS);
    const fp2 = memberSummaryWorkFingerprint(
      { workingOn: [{ ...base, lifecycleStage: "done" }], waiting: [], comingUp: [] },
      REF_MS,
    );
    expect(fp1).not.toBe(fp2);
  });

  it("excludes PRs/tickets with activityAt older than 30 days before snapshot time", () => {
    const staleIso = "2026-03-01T12:00:00.000Z";
    const fpStaleOnly = memberSummaryWorkFingerprint(
      {
        workingOn: [
          {
            entityKind: "pr",
            entityIdentifier: "o/r#9",
            title: "Old",
            activityAt: staleIso,
          },
        ],
        waiting: [],
        comingUp: [],
      },
      REF_MS,
    );
    const fpEmpty = memberSummaryWorkFingerprint({ workingOn: [], waiting: [], comingUp: [] }, REF_MS);
    expect(fpStaleOnly).toBe(fpEmpty);
  });
});

describe("teamMemberWorkAggregateFingerprint", () => {
  it("changes when any member fingerprint changes", () => {
    const rows: NonNullable<TeamOverviewSnapshot["memberSummaries"]> = [
      {
        memberLabel: "A",
        workingOn: [
          {
            entityKind: "pr",
            entityIdentifier: "x#1",
            title: "P",
            activityAt: "2026-05-10T00:00:00.000Z",
          },
        ],
        waiting: [],
        comingUp: [],
      },
      {
        memberLabel: "B",
        workingOn: [],
        waiting: [],
        comingUp: [],
      },
    ];
    const g1 = teamMemberWorkAggregateFingerprint(rows, REF_MS);
    const g2 = teamMemberWorkAggregateFingerprint(
      [
        rows[0]!,
        {
          ...rows[1]!,
          workingOn: [
            { entityKind: "pr", entityIdentifier: "y#2", title: "Q", activityAt: "2026-05-10T00:00:00.000Z" },
          ],
        },
      ],
      REF_MS,
    );
    expect(g1).not.toBe(g2);
  });
});

describe("enrichMemberSummariesWithAiDigests", () => {
  it("skips Claude when fingerprint matches cache", async () => {
    const row = {
      memberLabel: "Pat",
      workingOn: [
        { entityKind: "pr" as const, entityIdentifier: "o/r#1", title: "Do thing", activityAt: "2026-05-10T00:00:00.000Z" },
      ],
      waiting: [] as const,
      comingUp: [] as const,
    };
    const snap: TeamOverviewSnapshot = {
      generatedAt: SNAP_ISO,
      summaryCounts: { stuck: 0, awaitingReview: 0, recentlyMerged: 0, unlinkedPrs: 0, unlinkedTickets: 0 },
      stuck: [],
      awaitingReview: [],
      recentlyMerged: [],
      unlinkedPrs: [],
      unlinkedTickets: [],
      memberSummaries: [row],
    };
    const fp = memberSummaryWorkFingerprint(row, REF_MS);
    writeMemberAiDigestToDb("Pat", fp, ["Cached bullet"]);

    await enrichMemberSummariesWithAiDigests(snap);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(snap.memberSummaries![0]!.aiDigest?.bullets).toEqual(["Cached bullet"]);
    expect(snap.memberSummaries![0]!.aiDigest?.workFingerprint).toBe(fp);
  });

  it("calls Claude and persists when cache misses", async () => {
    mockPrompt.mockResolvedValue(
      JSON.stringify({
        summaries: [{ memberLabel: "Pat", bullets: ["Working on o/r#1", "Nothing blocked"] }],
      }),
    );

    const snap: TeamOverviewSnapshot = {
      generatedAt: SNAP_ISO,
      summaryCounts: { stuck: 0, awaitingReview: 0, recentlyMerged: 0, unlinkedPrs: 0, unlinkedTickets: 0 },
      stuck: [],
      awaitingReview: [],
      recentlyMerged: [],
      unlinkedPrs: [],
      unlinkedTickets: [],
      memberSummaries: [
        {
          memberLabel: "Pat",
          workingOn: [
            { entityKind: "pr", entityIdentifier: "o/r#1", title: "Do thing", activityAt: "2026-05-10T00:00:00.000Z" },
          ],
          waiting: [],
          comingUp: [],
        },
      ],
    };

    await enrichMemberSummariesWithAiDigests(snap);

    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(snap.memberSummaries![0]!.aiDigest?.bullets.length).toBeGreaterThan(0);
    const fp = memberSummaryWorkFingerprint(snap.memberSummaries![0]!, REF_MS);
    const dbRow = readMemberAiDigestFromDb("Pat");
    expect(dbRow?.work_fingerprint).toBe(fp);
  });
});
