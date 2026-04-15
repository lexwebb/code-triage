import { describe, it, expect } from "vitest";
import {
  extractTicketIdentifiers,
  buildLinkMap,
  mergeProviderPullLinksIntoLinkMap,
  parseGithubPullRequestUrl,
  type LinkablePR,
} from "./linker.js";

describe("extractTicketIdentifiers", () => {
  it("extracts identifiers from branch name", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "lex/ENG-123-fix-bug", title: "Fix bug", body: "" };
    expect(extractTicketIdentifiers(pr)).toEqual(["ENG-123"]);
  });

  it("extracts from PR title when branch has no match", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "fix-bug", title: "Fixes ENG-456", body: "" };
    expect(extractTicketIdentifiers(pr)).toEqual(["ENG-456"]);
  });

  it("extracts from PR body as fallback", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "fix-bug", title: "Fix bug", body: "Resolves PROD-789" };
    expect(extractTicketIdentifiers(pr)).toEqual(["PROD-789"]);
  });

  it("collects every ticket id in each source", () => {
    const pr: LinkablePR = {
      number: 1,
      repo: "org/repo",
      branch: "ENG-1-and-ENG-2",
      title: "Fixes CHA-10 and CHA-11",
      body: "",
    };
    expect(extractTicketIdentifiers(pr)).toEqual(["ENG-1", "ENG-2", "CHA-10", "CHA-11"]);
  });

  it("returns empty array when no match", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "fix-bug", title: "Fix bug", body: "No ticket" };
    expect(extractTicketIdentifiers(pr)).toEqual([]);
  });

  it("handles identifiers with various team key lengths", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "FE-42-styles", title: "", body: "" };
    expect(extractTicketIdentifiers(pr)).toEqual(["FE-42"]);
  });

  it("normalizes lowercase ticket keys (Linear git branches)", () => {
    const pr: LinkablePR = { number: 1, repo: "org/repo", branch: "cha-6269-app-store-compliance", title: "", body: "" };
    expect(extractTicketIdentifiers(pr)).toEqual(["CHA-6269"]);
  });
});

describe("parseGithubPullRequestUrl", () => {
  it("parses standard GitHub pull URLs", () => {
    expect(
      parseGithubPullRequestUrl("https://github.com/chaching-engineering/price-comparison-tool/pull/741"),
    ).toEqual({ repo: "chaching-engineering/price-comparison-tool", number: 741 });
  });

  it("parses pull URLs with extra path segments", () => {
    expect(
      parseGithubPullRequestUrl(
        "https://github.com/chaching-engineering/price-comparison-tool/pull/741/files",
      ),
    ).toEqual({ repo: "chaching-engineering/price-comparison-tool", number: 741 });
  });

  it("returns null for non-pull URLs", () => {
    expect(parseGithubPullRequestUrl("https://linear.app/foo")).toBeNull();
  });
});

describe("mergeProviderPullLinksIntoLinkMap", () => {
  it("adds ticket and PR keys without duplicating", () => {
    const prs: LinkablePR[] = [
      { number: 10, repo: "org/repo", branch: "ENG-1-fix", title: "", body: "" },
    ];
    const map = buildLinkMap(prs, new Set(["ENG-1"]));
    mergeProviderPullLinksIntoLinkMap(map, "ENG-1", [
      { number: 99, repo: "org/other", title: "from Linear" },
    ]);
    expect(map.ticketToPRs.get("ENG-1")).toEqual([
      { number: 10, repo: "org/repo", title: "" },
      { number: 99, repo: "org/other", title: "from Linear" },
    ]);
    expect(map.prToTickets.get("org/other#99")).toEqual(["ENG-1"]);
  });
});

describe("buildLinkMap", () => {
  it("builds bidirectional maps", () => {
    const prs: LinkablePR[] = [
      { number: 10, repo: "org/repo", branch: "ENG-123-fix", title: "", body: "" },
      { number: 20, repo: "org/repo", branch: "ENG-123-more", title: "", body: "" },
      { number: 30, repo: "org/other", branch: "main", title: "Fixes PROD-5", body: "" },
    ];
    const validIdentifiers = new Set(["ENG-123", "PROD-5"]);

    const { ticketToPRs, prToTickets } = buildLinkMap(prs, validIdentifiers);

    expect(ticketToPRs.get("ENG-123")).toEqual([
      { number: 10, repo: "org/repo", title: "" },
      { number: 20, repo: "org/repo", title: "" },
    ]);
    expect(ticketToPRs.get("PROD-5")).toEqual([{ number: 30, repo: "org/other", title: "Fixes PROD-5" }]);
    expect(prToTickets.get("org/repo#10")).toEqual(["ENG-123"]);
    expect(prToTickets.get("org/other#30")).toEqual(["PROD-5"]);
  });

  it("discards identifiers not in valid set", () => {
    const prs: LinkablePR[] = [
      { number: 1, repo: "org/repo", branch: "ABC-999-fake", title: "", body: "" },
    ];
    const validIdentifiers = new Set(["ENG-123"]);

    const { ticketToPRs, prToTickets } = buildLinkMap(prs, validIdentifiers);

    expect(ticketToPRs.size).toBe(0);
    expect(prToTickets.size).toBe(0);
  });
});
