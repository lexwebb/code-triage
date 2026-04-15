import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockIssue, mockTeams, mockViewer } = vi.hoisted(() => ({
  mockIssue: vi.fn(),
  mockTeams: vi.fn(),
  mockViewer: vi.fn(),
}));

// Mock @linear/sdk before importing
vi.mock("@linear/sdk", () => {
  return {
    LinearClient: vi.fn().mockImplementation(() => ({
      issue: mockIssue,
      teams: mockTeams,
      viewer: mockViewer,
    })),
    __mockIssue: mockIssue,
    __mockTeams: mockTeams,
    __mockViewer: mockViewer,
  };
});

import { LinearProvider } from "./linear.js";
const mockFetch = vi.fn();

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

function makeGqlIssueNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    identifier: "ENG-123",
    title: "Fix the bug",
    state: { name: "In Progress", color: "#f00", type: "started" },
    priority: 2,
    assignee: { name: "Alice", avatarUrl: "https://example.com/a.png" },
    labels: { nodes: [{ name: "bug", color: "#ff0000" }] },
    attachments: { nodes: [] },
    syncedWith: [],
    updatedAt: "2026-04-14T00:00:00.000Z",
    completedAt: null,
    canceledAt: null,
    url: "https://linear.app/team/issue/ENG-123",
    ...overrides,
  };
}

function gqlOk(data: unknown) {
  const body = JSON.stringify({ data });
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body) as { data: unknown },
  };
}

function gqlError(message: string) {
  const body = JSON.stringify({ errors: [{ message }] });
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body) as { errors: Array<{ message: string }> },
  };
}

describe("LinearProvider", () => {
  let provider: LinearProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    provider = new LinearProvider("lin_api_test");
  });

  describe("fetchMyIssues", () => {
    it("returns mapped issues assigned to viewer", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeGqlIssueNode();
      mockFetch.mockResolvedValue(
        gqlOk({
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [node],
          },
        }),
      );

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
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe("lin_api_test");
    });

    it("marks issue as done when provider returns completion metadata", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeGqlIssueNode({
        state: { name: "Merged", color: "#0f0", type: "started" },
        completedAt: "2026-04-15T00:00:00.000Z",
      });
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [node] } }));

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.isDone).toBe(true);
    });

    it("marks issue done from Merged workflow name when completedAt is null", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeGqlIssueNode({
        state: { name: "Merged", color: "#0f0", type: "started" },
        completedAt: null,
      });
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [node] } }));

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.isDone).toBe(true);
    });

    it("maps GitHub PR attachments into providerLinkedPulls", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeGqlIssueNode({
        attachments: {
          nodes: [
            {
              url: "https://github.com/chaching-engineering/price-comparison-tool/pull/741",
              title: "CHA-6269: compliance",
            },
            { url: "https://linear.app/issue/FOO-1", title: "not github" },
          ],
        },
      });
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [node] } }));

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.providerLinkedPulls).toEqual([
        { repo: "chaching-engineering/price-comparison-tool", number: 741, title: "CHA-6269: compliance" },
      ]);
    });

    it("maps syncedWith GitHub metadata into providerLinkedPulls", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeGqlIssueNode({
        attachments: { nodes: [] },
        syncedWith: [
          {
            service: "github",
            metadata: { __typename: "ExternalEntityInfoGithubMetadata", owner: "o", repo: "r", number: 10 },
          },
          { service: "slack", metadata: { __typename: "ExternalEntitySlackMetadata" } },
        ],
      });
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [node] } }));

      const issues = await provider.fetchMyIssues();
      expect(issues[0]!.providerLinkedPulls).toEqual([{ repo: "o/r", number: 10, title: "" }]);
    });

    it("follows Linear pagination until hasNextPage is false", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const nodeA = makeGqlIssueNode({ id: "a", identifier: "ENG-1" });
      const nodeB = makeGqlIssueNode({ id: "b", identifier: "ENG-2" });
      mockFetch
        .mockResolvedValueOnce(
          gqlOk({ issues: { pageInfo: { hasNextPage: true, endCursor: "cursor-1" }, nodes: [nodeA] } }),
        )
        .mockResolvedValueOnce(
          gqlOk({ issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [nodeB] } }),
        );

      const issues = await provider.fetchMyIssues();

      expect(issues).toHaveLength(2);
      expect(issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
      const secondPayload = JSON.parse(String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)) as {
        variables: { after: string | null };
      };
      expect(secondPayload.variables.after).toBe("cursor-1");
    });

    it("falls back when syncedWith is not available in GraphQL schema", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeGqlIssueNode({ identifier: "ENG-9" });
      mockFetch
        .mockResolvedValueOnce(gqlError('Cannot query field "syncedWith" on type "Issue".'))
        .mockResolvedValueOnce(
          gqlOk({ issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } }),
        );

      const issues = await provider.fetchMyIssues();

      expect(issues).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const firstQuery = JSON.parse(String((mockFetch.mock.calls[0]?.[1] as RequestInit).body)) as {
        query: string;
      };
      const secondQuery = JSON.parse(String((mockFetch.mock.calls[1]?.[1] as RequestInit).body)) as {
        query: string;
      };
      expect(firstQuery.query).toContain("syncedWith");
      expect(secondQuery.query).not.toContain("syncedWith");
    });

    it("falls back when Linear returns HTTP 400 for syncedWith query", async () => {
      mockViewer.mockResolvedValue({ id: "user-1" });
      const node = makeGqlIssueNode({ identifier: "ENG-10" });
      const errBody = JSON.stringify({
        errors: [{ message: 'Cannot query field "syncedWith" on type "Issue".' }],
      });
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          text: async () => errBody,
          json: async () => JSON.parse(errBody),
        })
        .mockResolvedValueOnce(
          gqlOk({ issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } }),
        );

      const issues = await provider.fetchMyIssues();

      expect(issues).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("fetchIssuesByIdentifiers", () => {
    it("returns issues matching identifiers", async () => {
      const node = makeGqlIssueNode({ identifier: "ENG-123" });
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [node] } }));

      const issues = await provider.fetchIssuesByIdentifiers(["ENG-123", "ENG-999"]);

      expect(issues).toHaveLength(1);
      expect(issues[0]!.identifier).toBe("ENG-123");
    });

    it("accepts lowercase identifier keys", async () => {
      const node = makeGqlIssueNode({ identifier: "ENG-123" });
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [node] } }));

      const issues = await provider.fetchIssuesByIdentifiers(["eng-123"]);

      expect(issues).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("returns empty array for empty input", async () => {
      const issues = await provider.fetchIssuesByIdentifiers([]);
      expect(issues).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("uses identifier cache for repeated lookups", async () => {
      const node = makeGqlIssueNode({ identifier: "ENG-123" });
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [node] } }));

      const first = await provider.fetchIssuesByIdentifiers(["ENG-123"]);
      const second = await provider.fetchIssuesByIdentifiers(["ENG-123"]);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("negative-caches missing identifiers to avoid repeated misses", async () => {
      mockFetch.mockResolvedValue(gqlOk({ issues: { pageInfo: { hasNextPage: false }, nodes: [] } }));

      const first = await provider.fetchIssuesByIdentifiers(["ENG-999"]);
      const second = await provider.fetchIssuesByIdentifiers(["ENG-999"]);

      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
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
