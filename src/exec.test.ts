import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ghAsync, setTokenResolver } from "./exec.js";

beforeEach(() => {
  setTokenResolver(() => "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ghAsync", () => {
  it("returns a single object for non-array JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ login: "u" }), { status: 200 })),
    );
    const out = await ghAsync<{ login: string }>("/user");
    expect(out).toEqual({ login: "u" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("concatenates paginated array responses using Link rel=next", async () => {
    const nextUrl = "https://api.github.com/repos/o/r/issues?page=2";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce((url: string) => {
          expect(url).toContain("api.github.com");
          return Promise.resolve(
            new Response(JSON.stringify([{ id: 1 }]), {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: `<${nextUrl}>; rel="next"`,
              },
            }),
          );
        })
        .mockImplementationOnce((url: string) => {
          expect(url).toBe(nextUrl);
          return Promise.resolve(new Response(JSON.stringify([{ id: 2 }]), { status: 200 }));
        }),
    );
    const out = await ghAsync<Array<{ id: number }>>("/repos/o/r/issues");
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("retries on 429 then succeeds", async () => {
    vi.useFakeTimers();
    const reset = Math.floor(Date.now() / 1000) + 1;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "rate limit" }), {
            status: 429,
            headers: { "X-RateLimit-Reset": String(reset) },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    const p = ghAsync<Record<string, unknown>>("/user");
    await vi.advanceTimersByTimeAsync(120_000);
    const out = await p;
    expect(out).toEqual({ ok: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
