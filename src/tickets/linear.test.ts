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
    labels: (_vars?: unknown) => Promise.resolve({ nodes: [{ name: "bug", color: "#ff0000" }] }),
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
      expect(issues[0]!.isDone).toBe(false);
    });

    it("marks issue as done when provider returns completion metadata", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeIssueNode({
        state: Promise.resolve({ name: "Merged", color: "#0f0", type: "started" }),
        completedAt: new Date("2026-04-15T00:00:00Z"),
      });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.isDone).toBe(true);
    });

    it("marks issue done from Merged workflow name when completedAt is null", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeIssueNode({
        state: Promise.resolve({ name: "Merged", color: "#0f0", type: "started" }),
        completedAt: null,
      });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.isDone).toBe(true);
    });

    it("maps GitHub PR attachments into providerLinkedPulls", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeIssueNode({
        attachments: (vars: Record<string, unknown> | undefined) => {
          expect(vars).toMatchObject({ first: 100 });
          return Promise.resolve({
            nodes: [
              {
                url: "https://github.com/chaching-engineering/price-comparison-tool/pull/741",
                title: "CHA-6269: compliance",
              },
              { url: "https://linear.app/issue/FOO-1", title: "not github" },
            ],
          });
        },
      });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.providerLinkedPulls).toEqual([
        { repo: "chaching-engineering/price-comparison-tool", number: 741, title: "CHA-6269: compliance" },
      ]);
    });

    it("maps syncedWith GitHub metadata into providerLinkedPulls", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeIssueNode({
        attachments: () => Promise.resolve({ nodes: [] }),
        syncedWith: [
          { service: "github", metadata: { owner: "o", repo: "r", number: 10 } },
          { service: "slack", metadata: {} },
        ],
      });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.providerLinkedPulls).toEqual([{ repo: "o/r", number: 10, title: "" }]);
    });

    it("follows Linear pagination until hasNextPage is false", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const nodeA = makeIssueNode({ id: "a", identifier: "ENG-1" });
      const nodeB = makeIssueNode({ id: "b", identifier: "ENG-2" });
      const connection: {
        nodes: ReturnType<typeof makeIssueNode>[];
        pageInfo: { hasNextPage: boolean };
        fetchNext: () => Promise<void>;
      } = {
        nodes: [nodeA],
        pageInfo: { hasNextPage: true },
        fetchNext: async () => {
          connection.nodes = [nodeA, nodeB];
          connection.pageInfo = { hasNextPage: false };
        },
      };
      mockIssues.mockResolvedValue(connection);

      const issues = await provider.fetchMyIssues();

      expect(issues).toHaveLength(2);
      expect(issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
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

    it("accepts lowercase identifier keys", async () => {
      const node = makeIssueNode({ identifier: "ENG-123" });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const issues = await provider.fetchIssuesByIdentifiers(["eng-123"]);

      expect(issues).toHaveLength(1);
      expect(mockIssues).toHaveBeenCalled();
    });

    it("returns empty array for empty input", async () => {
      const issues = await provider.fetchIssuesByIdentifiers([]);
      expect(issues).toEqual([]);
      expect(mockIssues).not.toHaveBeenCalled();
    });

    it("uses identifier cache for repeated lookups", async () => {
      const node = makeIssueNode({ identifier: "ENG-123" });
      mockIssues.mockResolvedValue({ nodes: [node] });

      const first = await provider.fetchIssuesByIdentifiers(["ENG-123"]);
      const second = await provider.fetchIssuesByIdentifiers(["ENG-123"]);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(mockIssues).toHaveBeenCalledTimes(1);
    });

    it("negative-caches missing identifiers to avoid repeated misses", async () => {
      mockIssues.mockResolvedValue({ nodes: [] });

      const first = await provider.fetchIssuesByIdentifiers(["ENG-999"]);
      const second = await provider.fetchIssuesByIdentifiers(["ENG-999"]);

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(mockIssues).toHaveBeenCalledTimes(1);
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
