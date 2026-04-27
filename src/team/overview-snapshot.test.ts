import { describe, expect, it } from "vitest";
import { buildTeamOverviewSnapshotFromData } from "./overview.js";
import type { CoherenceAlert } from "../coherence.js";
import type { TicketIssue } from "../tickets/types.js";

const baseTicket = (
  id: string,
  title: string,
  type: string,
  assignee?: { name: string; id?: string },
): TicketIssue => ({
  id: `id-${id}`,
  identifier: id,
  title,
  state: { name: "In Progress", color: "#fff", type },
  priority: 0,
  labels: [],
  updatedAt: "2026-04-10T00:00:00.000Z",
  providerUrl: "https://example.com",
  ...(assignee ? { assignee } : {}),
});

const sidebarRow = (overrides: Partial<Record<string, unknown>>) => ({
  number: 1,
  repo: "acme/app",
  title: "PR",
  updatedAt: "2026-04-15T12:00:00.000Z",
  branch: "f",
  checksStatus: "pending",
  hasHumanApproval: false,
  author: "alice",
  ...overrides,
});

describe("buildTeamOverviewSnapshotFromData", () => {
  it("places review-bottleneck only in awaitingReview ordering, not stuck", () => {
    const alerts: CoherenceAlert[] = [
      {
        id: "review-bottleneck:acme/app#1",
        type: "review-bottleneck",
        entityKind: "pr",
        entityIdentifier: "acme/app#1",
        priority: "high",
        title: "waiting",
      },
      {
        id: "ci-failure:acme/app#2",
        type: "ci-failure",
        entityKind: "pr",
        entityIdentifier: "acme/app#2",
        priority: "medium",
        title: "CI red",
      },
    ];
    const snap = buildTeamOverviewSnapshotFromData({
      generatedAt: "2026-04-15T12:00:00.000Z",
      now: new Date("2026-04-15T18:00:00.000Z").getTime(),
      alerts,
      authored: [],
      reviewRequested: [
        {
          number: 1,
          repo: "acme/app",
          title: "PR one",
          updatedAt: "2026-04-14T12:00:00.000Z",
          branch: "f",
          checksStatus: "pending",
          hasHumanApproval: false,
        },
        {
          number: 3,
          repo: "acme/app",
          title: "PR three",
          updatedAt: "2026-04-13T12:00:00.000Z",
          branch: "g",
          checksStatus: "pending",
          hasHumanApproval: false,
        },
      ],
      myIssues: [],
      repoLinkedIssues: [],
      ticketToPRs: {},
      prToTickets: {},
      recentlyMerged: [],
    });
    expect(snap.stuck).toHaveLength(1);
    expect(snap.stuck[0]!.entityIdentifier).toBe("acme/app#2");
    expect(snap.awaitingReview).toHaveLength(2);
    expect(snap.awaitingReview[0]!.number).toBe(3);
    expect(snap.awaitingReview[0]!.waitHours).toBeGreaterThan(snap.awaitingReview[1]!.waitHours);
  });

  it("lists unlinked PRs and tickets from maps", () => {
    const myIssues: TicketIssue[] = [
      baseTicket("ENG-1", "No PR yet", "started"),
    ];
    const snap = buildTeamOverviewSnapshotFromData({
      generatedAt: "2026-04-15T12:00:00.000Z",
      now: Date.now(),
      alerts: [],
      authored: [
        {
          number: 10,
          repo: "acme/app",
          title: "Lonely PR",
          updatedAt: "2026-04-15T00:00:00.000Z",
          branch: "x",
          checksStatus: "success",
          hasHumanApproval: false,
        },
      ],
      reviewRequested: [],
      myIssues,
      repoLinkedIssues: [],
      ticketToPRs: {},
      prToTickets: {},
      recentlyMerged: [],
    });
    expect(snap.unlinkedPrs).toHaveLength(1);
    expect(snap.unlinkedPrs[0]).toMatchObject({ repo: "acme/app", number: 10, title: "Lonely PR" });
    expect(snap.unlinkedPrs[0]!.lifecycleStage).toBeDefined();
    expect(snap.unlinkedTickets).toHaveLength(1);
    expect(snap.unlinkedTickets[0]).toMatchObject({
      identifier: "ENG-1",
      title: "No PR yet",
      providerUrl: "https://example.com",
    });
    expect(snap.unlinkedTickets[0]!.lifecycleStage).toBeDefined();
  });

  it("builds per-member summaries for authored, review queue, and tickets", () => {
    const myIssues: TicketIssue[] = [
      baseTicket("ENG-2", "Later", "unstarted", { name: "bob" }),
      baseTicket("ENG-3", "Doing", "started", { name: "bob" }),
    ];
    const snap = buildTeamOverviewSnapshotFromData({
      generatedAt: "2026-04-15T12:00:00.000Z",
      now: new Date("2026-04-15T18:00:00.000Z").getTime(),
      alerts: [],
      authored: [sidebarRow({ number: 10, title: "Alice feature", author: "alice" })],
      reviewRequested: [
        sidebarRow({
          number: 20,
          title: "Needs review",
          author: "carol",
          updatedAt: "2026-04-13T12:00:00.000Z",
        }),
      ],
      myIssues,
      repoLinkedIssues: [],
      ticketToPRs: {},
      prToTickets: {},
      recentlyMerged: [{ repo: "a/b", number: 99, title: "Shipped", mergedAt: "2026-04-14T00:00:00.000Z", authorLogin: "alice" }],
    });
    const byLabel = Object.fromEntries(snap.memberSummaries.map((m) => [m.memberLabel, m]));
    expect(byLabel.alice?.workingOn.some((w) => w.entityIdentifier.includes("#10"))).toBe(true);
    expect(byLabel.alice?.workingOn.some((w) => w.title === "Shipped")).toBe(true);
    expect(byLabel.carol?.waiting.some((w) => w.title === "Needs review")).toBe(true);
    expect(byLabel.bob?.workingOn.some((w) => w.entityIdentifier === "ENG-3")).toBe(true);
    expect(byLabel.bob?.comingUp.some((c) => c.entityIdentifier === "ENG-2")).toBe(true);
  });

  it("merges GitHub and Linear identities via teamMemberLinks", () => {
    const myIssues: TicketIssue[] = [
      baseTicket("ENG-9", "Do thing", "started", { name: "Robert Tables", id: "user-linear-9" }),
    ];
    const snap = buildTeamOverviewSnapshotFromData({
      generatedAt: "2026-04-15T12:00:00.000Z",
      now: Date.now(),
      alerts: [],
      authored: [sidebarRow({ number: 11, title: "Code", author: "rtables" })],
      reviewRequested: [],
      myIssues,
      repoLinkedIssues: [],
      ticketToPRs: {},
      prToTickets: {},
      recentlyMerged: [],
      teamMemberLinks: [
        {
          label: "Robert Tables",
          githubLogins: ["rtables"],
          linearNames: ["Robert Tables"],
          linearUserIds: ["user-linear-9"],
        },
      ],
    });
    const bob = snap.memberSummaries.find((m) => m.memberLabel === "Robert Tables");
    expect(bob).toBeDefined();
    expect(bob!.workingOn.some((w) => w.entityIdentifier === "ENG-9")).toBe(true);
    expect(bob!.workingOn.some((w) => w.entityIdentifier.includes("#11"))).toBe(true);
  });

  it("sorts recently merged by mergedAt descending", () => {
    const snap = buildTeamOverviewSnapshotFromData({
      generatedAt: "2026-04-15T12:00:00.000Z",
      now: Date.now(),
      alerts: [],
      authored: [],
      reviewRequested: [],
      myIssues: [],
      repoLinkedIssues: [],
      ticketToPRs: {},
      prToTickets: {},
      recentlyMerged: [
        { repo: "a/b", number: 1, title: "old", mergedAt: "2026-04-01T00:00:00.000Z" },
        { repo: "a/b", number: 2, title: "new", mergedAt: "2026-04-14T00:00:00.000Z" },
      ],
    });
    expect(snap.recentlyMerged.map((r) => r.number)).toEqual([2, 1]);
    expect(snap.recentlyMerged.every((r) => r.lifecycleStage === "merged")).toBe(true);
  });
});
