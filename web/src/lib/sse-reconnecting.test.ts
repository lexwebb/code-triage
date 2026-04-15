import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeReconnectingSse } from "./sse-reconnecting.js";

function stubEventSource() {
  const created: MockEs[] = [];
  class MockEs {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = MockEs.CONNECTING;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener = () => {};
    constructor(_url: string) {
      created.push(this);
    }
    close() {
      this.readyState = MockEs.CLOSED;
    }
  }
  vi.stubGlobal("EventSource", MockEs);
  return { created, MockEs };
}

describe("subscribeReconnectingSse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("runs onOpen when the connection opens", () => {
    const { created, MockEs } = stubEventSource();
    const onOpen = vi.fn();
    subscribeReconnectingSse("/api/events", () => {}, { onOpen });
    const es = created[0];
    expect(es).toBeDefined();
    es.readyState = MockEs.OPEN;
    es.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens a new EventSource after CLOSED and backoff", async () => {
    vi.useFakeTimers();
    const { created, MockEs } = stubEventSource();
    const onOpen = vi.fn();
    subscribeReconnectingSse("/api/events", () => {}, { onOpen });

    const first = created[0];
    first.readyState = MockEs.OPEN;
    first.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);

    first.readyState = MockEs.CLOSED;
    first.onerror?.();
    expect(created.length).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(created.length).toBe(2);

    const second = created[1];
    second.readyState = MockEs.OPEN;
    second.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect after dispose", async () => {
    vi.useFakeTimers();
    const { created, MockEs } = stubEventSource();
    const dispose = subscribeReconnectingSse("/api/events", () => {});

    const first = created[0];
    first.readyState = MockEs.CLOSED;
    first.onerror?.();
    dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(created.length).toBe(1);
  });
});
