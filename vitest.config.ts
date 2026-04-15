import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "web",
          environment: "jsdom",
          include: ["web/src/**/*.test.ts"],
        },
      },
    ],
  },
});
