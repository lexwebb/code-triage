import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @linear/sdk before importing
vi.mock("@linear/sdk", () => {
  const mockIssues = vi.fn();
  const mockIssue = vi.fn();
  const mockTeams = vi.fn();
  const mockViewer = vi.fn();
  return {
    LinearClient: vi.fn().mockImplementation(() => ({
      issues: mockIssues,
      issue: mockIssue,
      teams: mockTeams,
      viewer: mockViewer,
    })),
    __mockIssues: mockIssues,
    __mockIssue: mockIssue,
    __mockTeams: mockTeams,
    __mockViewer: mockViewer,
  };
});

import { LinearProvider } from "./linear.js";

const sdk = await import("@linear/sdk");
const mockIssues = (sdk as unknown as { __mockIssues: ReturnType<typeof vi.fn> }).__mockIssues;
const mockIssue = (sdk as unknown as { __mockIssue: ReturnType<typeof vi.fn> }).__mockIssue;
const mockTeams = (sdk as unknown as { __mockTeams: ReturnType<typeof vi.fn> }).__mockTeams;
const mockViewer = (sdk as unknown as { __mockViewer: ReturnType<typeof vi.fn> }).__mockViewer;

function makeIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Fix the bug",
    state: Promise.resolve({ name: "In Progress", color: "#f00", type: "started" }),
    priority: 2,
    assignee: Promise.resolve({ name: "Alice", avatarUrl: "https://example.com/a.png" }),
    labels: () => Promise.resolve({ nodes: [{ name: "bug", color: "#ff0000" }] }),
    updatedAt: new Date("2026-04-14T00:00:00Z"),
    url: "https://linear.app/team/issue/ENG-123",
    ...overrides,
  };
}

describe("LinearProvider", () => {
  let provider: LinearProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LinearProvider("lin_api_test");
  });

  describe("fetchMyIssues", () => {
    it("returns mapped issues assigned to viewer", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeIssueNode();
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchMyIssues();

      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        id: "issue-1",
        identifier: "ENG-123",
        title: "Fix the bug",
        priority: 2,
        providerUrl: "https://linear.app/team/issue/ENG-123",
      });
      expect(issues[0]!.state).toEqual({ name: "In Progress", color: "#f00", type: "started" });
      expect(issues[0]!.assignee).toEqual({ name: "Alice", avatarUrl: "https://example.com/a.png" });
      expect(issues[0]!.labels).toEqual([{ name: "bug", color: "#ff0000" }]);
    });
  });

  describe("fetchIssuesByIdentifiers", () => {
    it("returns issues matching identifiers", async () => {
      const node = makeIssueNode({ identifier: "ENG-123" });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchIssuesByIdentifiers(["ENG-123", "ENG-999"]);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.identifier).toBe("ENG-123");
    });

    it("returns empty array for empty input", async () => {
      const issues = await provider.fetchIssuesByIdentifiers([]);
      expect(issues).toEqual([]);
      expect(mockIssues).not.toHaveBeenCalled();
    });
  });

  describe("getIssueDetail", () => {
    it("returns issue with description and comments", async () => {
      const issueData = {
        ...makeIssueNode(),
        description: "Detailed description here",
        comments: () =>
          Promise.resolve({
            nodes: [
              {
                id: "comment-1",
                body: "Looks good",
                user: Promise.resolve({ name: "Bob", avatarUrl: null }),
                createdAt: new Date("2026-04-14T12:00:00Z"),
              },
            ],
          }),
      };
      mockIssue.mockResolvedValue(issueData);

      const detail = await provider.getIssueDetail("issue-1");

      expect(detail.description).toBe("Detailed description here");
      expect(detail.comments).toHaveLength(1);
      expect(detail.comments[0]).toMatchObject({
        id: "comment-1",
        body: "Looks good",
        author: { name: "Bob", avatarUrl: null },
      });
    });
  });

  describe("getTeams", () => {
    it("returns teams", async () => {
      mockTeams.mockResolvedValue({
        nodes: [{ id: "team-1", key: "ENG", name: "Engineering" }],
      });

      const teams = await provider.getTeams();
      expect(teams).toEqual([{ id: "team-1", key: "ENG", name: "Engineering" }]);
    });
  });

  describe("getCurrentUser", () => {
    it("returns viewer info", async () => {
      mockViewer.mockResolvedValue({ id: "user-1", name: "Alice", email: "alice@example.com" });
      const user = await provider.getCurrentUser();
      expect(user).toEqual({ id: "user-1", name: "Alice", email: "alice@example.com" });
    });
  });
});
