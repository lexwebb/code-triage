import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockNotify } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
}));

vi.mock("node-notifier", () => ({
  default: { notify: mockNotify },
}));

import { sendNotification } from "./notifier.js";

describe("sendNotification", () => {
  beforeEach(() => {
    mockNotify.mockImplementation((_opts: unknown, cb: (err: Error | null) => void) => {
      cb(null);
    });
  });

  it("delegates to node-notifier with title and message", () => {
    sendNotification("T", "Body");
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "T",
        message: "Body",
      }),
      expect.any(Function),
    );
  });
});
