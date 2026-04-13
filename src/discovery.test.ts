import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "./discovery.js";

describe("parseGitHubRemote", () => {
  it("parses SSH-style github.com URLs", () => {
    expect(parseGitHubRemote("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(parseGitHubRemote("git@github.com:org/repo")).toBe("org/repo");
  });

  it("parses HTTPS github.com URLs", () => {
    expect(parseGitHubRemote("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(parseGitHubRemote("https://github.com/org/repo")).toBe("org/repo");
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRemote("git@gitlab.com:group/proj.git")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });
});
