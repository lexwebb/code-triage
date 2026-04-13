import { describe, expect, it, vi } from "vitest";
import { runWithConcurrency } from "./run-with-concurrency.js";

describe("runWithConcurrency", () => {
  it("runs nothing when items empty", async () => {
    const fn = vi.fn();
    await runWithConcurrency([], 4, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses at most concurrency parallel executions", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6];

    await runWithConcurrency(items, 2, async (_n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("processes all items", async () => {
    const seen: number[] = [];
    await runWithConcurrency([1, 2, 3], 3, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
