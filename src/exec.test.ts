import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRateLimitState,
  ghAsync,
  ghAsyncSinglePage,
  hasEnvGitHubToken,
  resetRateLimitStateForTests,
  resolveGitHubTokenFromSources,
  setTokenResolver,
} from "./exec.js";

beforeEach(() => {
  setTokenResolver(() => "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  vi.restoreAllMocks();
  resetRateLimitStateForTests();
});

describe("ghAsync", () => {
  it("returns a single object for non-array JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ login: "u" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
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
          return Promise.resolve(
            new Response(JSON.stringify([{ id: 2 }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }),
    );
    const out = await ghAsync<Array<{ id: number }>>("/repos/o/r/issues");
    expect(out).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("ghAsyncSinglePage does not follow Link rel=next", async () => {
    const nextUrl = "https://api.github.com/repos/o/r/issues?page=2";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: 1 }]), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Link: `<${nextUrl}>; rel="next"`,
          },
        }),
      ),
    );
    const out = await ghAsyncSinglePage<Array<{ id: number }>>("/repos/o/r/issues");
    expect(out).toEqual([{ id: 1 }]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
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
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Remaining": "4999",
              "X-RateLimit-Limit": "5000",
              "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
            },
          }),
        ),
    );
    const p = ghAsync<Record<string, unknown>>("/user");
    await vi.advanceTimersByTimeAsync(120_000);
    const out = await p;
    expect(out).toEqual({ ok: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("records X-RateLimit-* on successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ login: "u" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Remaining": "100",
            "X-RateLimit-Limit": "5000",
            "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 3600),
            "X-RateLimit-Resource": "core",
          },
        }),
      ),
    );
    await ghAsync<{ login: string }>("/user");
    const s = getRateLimitState();
    expect(s.remaining).toBe(100);
    expect(s.limit).toBe(5000);
    expect(s.resource).toBe("core");
    expect(s.limited).toBe(false);
  });

  it("marks limited and keeps snapshot when GitHub returns 403 exhausted quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Limit": "5000",
            "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 120),
            "X-RateLimit-Resource": "core",
          },
        }),
      ),
    );
    await expect(ghAsync("/user")).rejects.toThrow();
    const s = getRateLimitState();
    expect(s.limited).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.resource).toBe("core");
  });
});

describe("hasEnvGitHubToken", () => {
  it("is false when neither env var is set", () => {
    expect(hasEnvGitHubToken()).toBe(false);
  });

  it("is true when GITHUB_TOKEN or GH_TOKEN is non-empty", () => {
    process.env.GITHUB_TOKEN = "x";
    expect(hasEnvGitHubToken()).toBe(true);
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "y";
    expect(hasEnvGitHubToken()).toBe(true);
  });
});

describe("resolveGitHubTokenFromSources", () => {
  it("prefers env over config token", () => {
    process.env.GITHUB_TOKEN = "from-env";
    expect(resolveGitHubTokenFromSources("from-config")).toBe("from-env");
  });

  it("uses config when env is unset", () => {
    expect(resolveGitHubTokenFromSources("  pat  ")).toBe("pat");
  });
});
