import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./exec.js", () => ({
  ghAsync: vi.fn(),
}));

import { ghAsync } from "./exec.js";
import { discoverTrackedOrgMemberLogins, fetchTrackedOrgDirectoryLogins } from "./github-org-team-scope.js";

describe("discoverTrackedOrgMemberLogins", () => {
  beforeEach(() => {
    vi.mocked(ghAsync).mockReset();
  });

  it("returns org members for orgs that intersect user orgs and tracked repo owners", async () => {
    const gh = vi.mocked(ghAsync);
    gh.mockImplementation(async (path: string) => {
      if (path === "/user/orgs") {
        return [{ login: "acme" }, { login: "other-org" }];
      }
      if (path === "/orgs/acme/members") {
        return [{ login: "alice" }, { login: "bob" }];
      }
      throw new Error(`unexpected ${path}`);
    });

    const out = await discoverTrackedOrgMemberLogins(["acme/one", "acme/two"], "me");
    expect([...out].sort()).toEqual(["alice", "bob"]);
  });

  it("excludes the viewer login", async () => {
    const gh = vi.mocked(ghAsync);
    gh.mockImplementation(async (path: string) => {
      if (path === "/user/orgs") return [{ login: "acme" }];
      if (path === "/orgs/acme/members") return [{ login: "me" }, { login: "carol" }];
      throw new Error(`unexpected ${path}`);
    });

    const out = await discoverTrackedOrgMemberLogins(["acme/r"], "me");
    expect([...out]).toEqual(["carol"]);
  });

  it("returns empty set when no tracked owner is a user org", async () => {
    const gh = vi.mocked(ghAsync);
    gh.mockImplementation(async (path: string) => {
      if (path === "/user/orgs") return [{ login: "acme" }];
      return [];
    });

    const out = await discoverTrackedOrgMemberLogins(["someuser/r"], "me");
    expect(out.size).toBe(0);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("directory logins include the viewer and are sorted", async () => {
    const gh = vi.mocked(ghAsync);
    gh.mockImplementation(async (path: string) => {
      if (path === "/user/orgs") return [{ login: "acme" }];
      if (path === "/orgs/acme/members") return [{ login: "zebra" }, { login: "me" }, { login: "alice" }];
      throw new Error(`unexpected ${path}`);
    });

    const out = await fetchTrackedOrgDirectoryLogins(["acme/r"]);
    expect(out).toEqual(["alice", "me", "zebra"]);
  });
});
