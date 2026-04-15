import { describe, expect, it } from "vitest";
import { reduceCiToTriState } from "./ci-state.js";

describe("reduceCiToTriState", () => {
  it("prefers failures from either legacy status or checks", () => {
    expect(
      reduceCiToTriState({
        status: { state: "failure", hasStatuses: true },
        checks: { success: 2, failure: 0, pending: 0 },
      }),
    ).toBe("failure");
    expect(
      reduceCiToTriState({
        status: { state: "success", hasStatuses: true },
        checks: { success: 3, failure: 1, pending: 0 },
      }),
    ).toBe("failure");
  });

  it("returns pending when any checks are pending", () => {
    expect(
      reduceCiToTriState({
        status: { state: "success", hasStatuses: true },
        checks: { success: 1, failure: 0, pending: 1 },
      }),
    ).toBe("pending");
  });

  it("treats pending legacy state as pending only when statuses exist", () => {
    expect(
      reduceCiToTriState({
        status: { state: "pending", hasStatuses: true },
        checks: null,
      }),
    ).toBe("pending");
    expect(
      reduceCiToTriState({
        status: { state: "pending", hasStatuses: false },
        checks: null,
      }),
    ).toBe("pending");
  });

  it("returns success when at least one successful signal exists", () => {
    expect(
      reduceCiToTriState({
        status: { state: "success", hasStatuses: true },
        checks: null,
      }),
    ).toBe("success");
    expect(
      reduceCiToTriState({
        status: null,
        checks: { success: 1, failure: 0, pending: 0 },
      }),
    ).toBe("success");
  });
});
