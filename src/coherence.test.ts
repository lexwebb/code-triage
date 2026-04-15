import { describe, expect, it } from "vitest";
import { evaluateCoherence, type CoherenceInput } from "./coherence.js";

function makeInput(overrides: Partial<CoherenceInput> = {}): CoherenceInput {
  return {
    myTickets: [],
    repoLinkedTickets: [],
    authoredPRs: [],
    reviewRequestedPRs: [],
    ticketToPRs: {},
    prToTickets: {},
    thresholds: {
      branchStalenessDays: 3,
      approvedUnmergedHours: 24,
      reviewWaitHours: 24,
      ticketInactivityDays: 5,
    },
    now: Date.now(),
    ...overrides,
  };
}

describe("evaluateCoherence", () => {
  it("detects stale in-progress ticket (ticket active, no recent PR activity)", () => {
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-42",
        title: "Fix auth",
        state: { name: "In Progress", color: "#f00", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: fourDaysAgo,
        providerUrl: "https://linear.app/eng/issue/ENG-42",
      }],
      ticketToPRs: {
        "ENG-42": [{ number: 18, repo: "org/repo", title: "fix auth" }],
      },
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "lex/ENG-42-fix-auth",
        updatedAt: fourDaysAgo,
        checksStatus: "success",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    const stale = alerts.find((a) => a.type === "stale-in-progress");
    expect(stale).toBeDefined();
    expect(stale?.entityIdentifier).toBe("ENG-42");
    expect(stale?.priority).toBe("medium");
  });

  it("does not flag in-progress ticket with recent activity", () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-42",
        title: "Fix auth",
        state: { name: "In Progress", color: "#f00", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: oneHourAgo,
        providerUrl: "https://linear.app/eng/issue/ENG-42",
      }],
      ticketToPRs: {
        "ENG-42": [{ number: 18, repo: "org/repo", title: "fix auth" }],
      },
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "lex/ENG-42-fix-auth",
        updatedAt: oneHourAgo,
        checksStatus: "success",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "stale-in-progress")).toBeUndefined();
  });

  it("detects approved-but-lingering PR", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "fix-auth",
        updatedAt: twoDaysAgo,
        checksStatus: "success",
        hasHumanApproval: true,
        merged: false,
        reviewers: [{ login: "alice", state: "APPROVED" }],
      }],
    });

    const alerts = evaluateCoherence(input);
    const alert = alerts.find((a) => a.type === "approved-but-lingering");
    expect(alert).toBeDefined();
    expect(alert?.entityIdentifier).toBe("org/repo#18");
    expect(alert?.priority).toBe("medium");
  });

  it("does not flag recently approved PR", () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "fix-auth",
        updatedAt: oneHourAgo,
        checksStatus: "success",
        hasHumanApproval: true,
        merged: false,
        reviewers: [{ login: "alice", state: "APPROVED" }],
      }],
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "approved-but-lingering")).toBeUndefined();
  });

  it("detects PR without linked ticket", () => {
    const input = makeInput({
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "fix-auth",
        updatedAt: new Date().toISOString(),
        checksStatus: "success",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
      prToTickets: {},
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "pr-without-ticket")).toBeDefined();
  });

  it("detects review bottleneck on review-requested PR", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      reviewRequestedPRs: [{
        number: 42,
        repo: "org/repo",
        title: "add feature",
        branch: "add-feature",
        updatedAt: twoDaysAgo,
        checksStatus: "success",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    const alert = alerts.find((a) => a.type === "review-bottleneck");
    expect(alert).toBeDefined();
    expect(alert?.priority).toBe("high");
  });

  it("detects inactive in-progress ticket with no open linked PR", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-99",
        title: "Refactor logging",
        state: { name: "In Progress", color: "#ccc", type: "started" },
        priority: 3,
        labels: [],
        updatedAt: tenDaysAgo,
        providerUrl: "https://linear.app/eng/issue/ENG-99",
      }],
    });

    const alerts = evaluateCoherence(input);
    const alert = alerts.find((a) => a.type === "ticket-inactive");
    expect(alert).toBeDefined();
    expect(alert?.priority).toBe("low");
  });

  it("does not flag ticket-inactive for Todo/backlog idle tickets", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-100",
        title: "Someday task",
        state: { name: "Todo", color: "#ccc", type: "unstarted" },
        priority: 3,
        labels: [],
        updatedAt: tenDaysAgo,
        providerUrl: "https://linear.app/eng/issue/ENG-100",
      }],
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "ticket-inactive")).toBeUndefined();
  });

  it("detects CI failure on authored PR", () => {
    const input = makeInput({
      authoredPRs: [{
        number: 18,
        repo: "org/repo",
        title: "fix auth",
        branch: "fix-auth",
        updatedAt: new Date().toISOString(),
        checksStatus: "failure",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    const alert = alerts.find((a) => a.type === "ci-failure");
    expect(alert).toBeDefined();
    expect(alert?.priority).toBe("medium");
  });

  it("detects ticket assigned with no PR", () => {
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-50",
        title: "Build feature",
        state: { name: "In Progress", color: "#f00", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: new Date().toISOString(),
        providerUrl: "https://linear.app/eng/issue/ENG-50",
      }],
      ticketToPRs: {},
    });

    const alerts = evaluateCoherence(input);
    const alert = alerts.find((a) => a.type === "ticket-no-pr");
    expect(alert).toBeDefined();
    expect(alert?.priority).toBe("medium");
  });

  it("does not flag ticket-no-pr when provider lists linked PRs but ticketToPRs is empty", () => {
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "CHA-6269",
        title: "Compliance",
        state: { name: "In Progress", color: "#f00", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: new Date().toISOString(),
        providerUrl: "https://linear.app/x",
        providerLinkedPulls: [
          { repo: "org/repo", number: 741, title: "Fix" },
        ],
      }],
      ticketToPRs: {},
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "ticket-no-pr")).toBeUndefined();
  });

  it("does not flag ticket-no-pr when workflow name looks terminal but type lags", () => {
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "CHA-9999",
        title: "Rollout",
        state: { name: "Merged", color: "#0f0", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: new Date().toISOString(),
        providerUrl: "https://linear.app/x",
      }],
      ticketToPRs: {},
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "ticket-no-pr")).toBeUndefined();
  });

  it("does not flag done-but-unmerged from workflow name alone (requires completed/canceled or isDone)", () => {
    const input = makeInput({
      repoLinkedTickets: [{
        id: "t1",
        identifier: "ENG-777",
        title: "X",
        state: { name: "Merged", color: "#0f0", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: new Date().toISOString(),
        providerUrl: "https://linear.app/x",
      }],
      ticketToPRs: {
        "ENG-777": [{ number: 38, repo: "org/repo", title: "fix" }],
      },
      authoredPRs: [{
        number: 38,
        repo: "org/repo",
        title: "fix",
        branch: "b",
        updatedAt: new Date().toISOString(),
        checksStatus: "success",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "done-but-unmerged")).toBeUndefined();
  });

  it("does not flag in-progress ticket when only merged PRs link (refs exist, open list empty)", () => {
    const input = makeInput({
      myTickets: [{
        id: "t1",
        identifier: "ENG-51",
        title: "Ship fix",
        state: { name: "In Progress", color: "#f00", type: "started" },
        priority: 1,
        labels: [],
        updatedAt: new Date().toISOString(),
        providerUrl: "https://linear.app/eng/issue/ENG-51",
      }],
      ticketToPRs: {
        "ENG-51": [{ number: 99, repo: "org/repo", title: "ENG-51 fix" }],
      },
      authoredPRs: [],
      reviewRequestedPRs: [],
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "ticket-no-pr")).toBeUndefined();
  });

  it("does not flag done tickets as ticket-no-pr when provider marks isDone", () => {
    const input = makeInput({
      myTickets: [{
        id: "t2",
        identifier: "CHA-6269",
        title: "App store compliance",
        state: { name: "Merged", color: "#0f0", type: "started" },
        isDone: true,
        priority: 1,
        labels: [],
        updatedAt: new Date().toISOString(),
        providerUrl: "https://linear.app/cha/issue/CHA-6269",
      }],
      ticketToPRs: {},
    });

       const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "ticket-no-pr")).toBeUndefined();
  });

  it("omits PR alerts for globally muted repos", () => {
    const input = makeInput({
      mutedRepos: ["Org/Noisy-Repo"],
      authoredPRs: [{
        number: 1,
        repo: "Org/Noisy-Repo",
        title: "x",
        branch: "b",
        updatedAt: new Date().toISOString(),
        checksStatus: "failure",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
      reviewRequestedPRs: [{
        number: 2,
        repo: "org/noisy-repo",
        title: "y",
        branch: "c",
        updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        checksStatus: "success",
        hasHumanApproval: false,
        merged: false,
        reviewers: [],
      }],
    });

    const alerts = evaluateCoherence(input);
    expect(alerts.find((a) => a.type === "ci-failure")).toBeUndefined();
    expect(alerts.find((a) => a.type === "review-bottleneck")).toBeUndefined();
  });
});
