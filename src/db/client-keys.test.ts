import { describe, expect, it } from "vitest";
import { parseCommentIdFromKey, repoFromCommentKey } from "./client.js";

describe("comment key helpers", () => {
  it("parseCommentIdFromKey handles owner/repo:id and bare id", () => {
    expect(parseCommentIdFromKey("acme/web-app:12345")).toBe(12345);
    expect(parseCommentIdFromKey("999")).toBe(999);
  });

  it("repoFromCommentKey returns undefined for legacy keys", () => {
    expect(repoFromCommentKey("acme/web-app:12345")).toBe("acme/web-app");
    expect(repoFromCommentKey("999")).toBeUndefined();
  });
});
