import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockPrompt } = vi.hoisted(() => ({ mockPrompt: vi.fn() }));

vi.mock("../actioner.js", () => ({
  runPrCompanionPrompt: mockPrompt,
}));

import {
  collectGithubLoginsForMemberLinking,
  collectUncoveredAssigneeKeys,
  hasUncoveredLinearAssigneeOnTickets,
  isGithubLoginCoveredByMemberLinks,
  isLinearAssigneeCoveredByMemberLinks,
  listUnrecognisedGithubLogins,
  memberLinkClaudeJobFingerprint,
  mergeManualAndClaudeMemberLinks,
  suggestMemberLinksWithClaude,
  validateClaudeMemberLinkRows,
} from "./member-link-claude.js";
import type { TicketIssue } from "../tickets/types.js";

describe("collectGithubLoginsForMemberLinking", () => {
  it("collects unique authors", () => {
    const logins = collectGithubLoginsForMemberLinking(
      [{ author: "a", repo: "r", number: 1, title: "", updatedAt: "", branch: "", checksStatus: "", hasHumanApproval: false }],
      [{ author: "b", repo: "r", number: 2, title: "", updatedAt: "", branch: "", checksStatus: "", hasHumanApproval: false }],
      [{ authorLogin: "a" }, { authorLogin: "c" }],
    );
    expect(logins.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("memberLinkClaudeJobFingerprint", () => {
  it("changes when manual links change", () => {
    const a = memberLinkClaudeJobFingerprint([{ label: "A", githubLogins: ["a"] }], ["x"], []);
    const b = memberLinkClaudeJobFingerprint([{ label: "B", githubLogins: ["b"] }], ["x"], []);
    expect(a).not.toBe(b);
  });

  it("is stable for reordered unrecognised github", () => {
    const a = memberLinkClaudeJobFingerprint(undefined, ["b", "a"], []);
    const b = memberLinkClaudeJobFingerprint(undefined, ["a", "b"], []);
    expect(a).toBe(b);
  });
});

describe("member link coverage", () => {
  const links = [{ label: "Pat", githubLogins: ["plee"], linearUserIds: ["u-1"], linearNames: ["Pat Lee"] }];

  it("detects covered github and assignee", () => {
    expect(isGithubLoginCoveredByMemberLinks("plee", links)).toBe(true);
    expect(isGithubLoginCoveredByMemberLinks("other", links)).toBe(false);
    expect(isLinearAssigneeCoveredByMemberLinks({ id: "u-1", name: "Pat Lee" }, links)).toBe(true);
    expect(isLinearAssigneeCoveredByMemberLinks({ name: "Pat Lee" }, links)).toBe(true);
    expect(isLinearAssigneeCoveredByMemberLinks({ id: "u-99", name: "X" }, links)).toBe(false);
  });

  it("lists unrecognised github logins", () => {
    expect(listUnrecognisedGithubLogins(["plee", "newguy"], links)).toEqual(["newguy"]);
  });

  it("detects uncovered assignees on tickets", () => {
    const tickets: TicketIssue[] = [
      {
        id: "1",
        identifier: "ENG-1",
        title: "t",
        state: { name: "s", color: "#fff", type: "started" },
        priority: 0,
        labels: [],
        updatedAt: "",
        providerUrl: "",
        assignee: { id: "u-99", name: "Stranger" },
      },
    ];
    expect(hasUncoveredLinearAssigneeOnTickets(tickets, links)).toBe(true);
    expect(collectUncoveredAssigneeKeys(tickets, links)).toEqual(["id:u-99"]);
  });
});

describe("mergeManualAndClaudeMemberLinks", () => {
  it("keeps manual and adds non-conflicting Claude rows", () => {
    const merged = mergeManualAndClaudeMemberLinks(
      [{ label: "Jane", githubLogins: ["jsmith"] }],
      [{ label: "Bob", githubLogins: ["bob"], linearUserIds: ["u1"] }],
    );
    expect(merged).toEqual([
      { label: "bob", githubLogins: ["bob"], linearUserIds: ["u1"] },
      { label: "jsmith", githubLogins: ["jsmith"] },
    ]);
  });

  it("drops Claude rows when an identifier already maps to another teammate", () => {
    const merged = mergeManualAndClaudeMemberLinks(
      [
        { label: "Jane", githubLogins: ["jsmith"] },
        { label: "X", githubLogins: ["other"], linearUserIds: ["u1"] },
      ],
      [{ label: "Nope", githubLogins: ["jsmith"], linearUserIds: ["u1"] }],
    );
    expect(merged).toEqual([
      { label: "jsmith", githubLogins: ["jsmith"] },
      { label: "other", githubLogins: ["other"], linearUserIds: ["u1"] },
    ]);
  });
});

describe("validateClaudeMemberLinkRows", () => {
  it("filters to allowed github and linear ids", () => {
    const rows = validateClaudeMemberLinkRows(
      {
        links: [
          {
            label: "X",
            githubLogins: ["good", "bad"],
            linearUserIds: ["id1", "nope"],
            linearNames: ["Pat"],
          },
        ],
      },
      ["good"],
      [{ id: "id1", name: "Pat" }],
    );
    expect(rows).toEqual([
      { label: "Pat", githubLogins: ["good"], linearUserIds: ["id1"], linearNames: ["Pat"] },
    ]);
  });
});

describe("suggestMemberLinksWithClaude", () => {
  beforeEach(() => {
    mockPrompt.mockReset();
  });

  it("returns validated links from Claude JSON", async () => {
    mockPrompt.mockResolvedValue(
      JSON.stringify({
        links: [
          {
            label: "Pat Lee",
            githubLogins: ["plee"],
            linearUserIds: ["u-1"],
            linearNames: ["Pat Lee"],
          },
        ],
      }),
    );
    const out = await suggestMemberLinksWithClaude(["plee"], [{ id: "u-1", name: "Pat Lee" }]);
    expect(out).toEqual([
      { label: "Pat Lee", githubLogins: ["plee"], linearUserIds: ["u-1"], linearNames: ["Pat Lee"] },
    ]);
  });

  it("returns empty on parse failure", async () => {
    mockPrompt.mockResolvedValue("not json");
    const out = await suggestMemberLinksWithClaude(["a"], [{ id: "u", name: "A" }]);
    expect(out).toEqual([]);
  });
});
