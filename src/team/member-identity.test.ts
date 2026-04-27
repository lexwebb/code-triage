import { describe, expect, it } from "vitest";
import {
  createTeamMemberIdentityResolver,
  normalizeTeamIdentityKey,
  parseTeamMemberLinksFromUnknown,
} from "./member-identity.js";

describe("normalizeTeamIdentityKey", () => {
  it("lowercases and trims", () => {
    expect(normalizeTeamIdentityKey("  Foo ")).toBe("foo");
  });
});

describe("parseTeamMemberLinksFromUnknown", () => {
  it("returns undefined for empty input", () => {
    expect(parseTeamMemberLinksFromUnknown(undefined)).toBeUndefined();
    expect(parseTeamMemberLinksFromUnknown(null)).toBeUndefined();
    expect(parseTeamMemberLinksFromUnknown([])).toBeUndefined();
  });

  it("parses valid rows and derives label from identities", () => {
    expect(
      parseTeamMemberLinksFromUnknown([
        { label: "ignored", githubLogins: ["jsmith"], linearUserIds: ["u1"] },
      ]),
    ).toEqual([{ label: "jsmith", githubLogins: ["jsmith"], linearUserIds: ["u1"] }]);
  });

  it("throws on invalid shape", () => {
    expect(() => parseTeamMemberLinksFromUnknown("x")).toThrow(/array/);
    expect(() => parseTeamMemberLinksFromUnknown([{ label: "only" }])).toThrow(/needs at least one/);
  });
});

describe("createTeamMemberIdentityResolver", () => {
  it("maps github, linear name, and linear id to one label", () => {
    const { resolve } = createTeamMemberIdentityResolver(
      [
        {
          label: "Robert Tables",
          githubLogins: ["bsmith"],
          linearNames: ["Robert Tables"],
          linearUserIds: ["lin-42"],
        },
      ],
      undefined,
    );
    expect(resolve("bsmith")).toBe("Robert Tables");
    expect(resolve("BSMITH")).toBe("Robert Tables");
    expect(resolve("Robert Tables")).toBe("Robert Tables");
    expect(resolve("who", { linearUserId: "lin-42" })).toBe("Robert Tables");
  });

  it("fills linear id from workspace directory when not in links", () => {
    const { resolve } = createTeamMemberIdentityResolver(undefined, [
      { id: "u99", name: "Pat Lee" },
    ]);
    expect(resolve("ignored", { linearUserId: "u99" })).toBe("Pat Lee");
    expect(resolve("pat lee")).toBe("Pat Lee");
  });
});
