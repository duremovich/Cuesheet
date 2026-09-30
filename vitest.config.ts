import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { sqlText } from "./vite.sql-text.ts";

export default defineConfig({
  test: {
    projects: [
      {
        // Plain Node: pure functions from worker, web and shared code (`*.test.ts` next to the code).
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        // jsdom: React component tests (`*.test.tsx` next to the code).
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/web/test/setup-dom.ts"],
        },
      },
      {
        // Inside workerd via @cloudflare/vitest-pool-workers: Durable Object and API tests.
        plugins: [
          sqlText(),
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                ADMIN_EMAIL: "admin@test.local",
                ADMIN_PASSWORD: "test-password-123",
                // Applied to D1 by test/worker/setup.ts before each test file.
                TEST_MIGRATIONS: await readD1Migrations("./src/worker/db/d1/migrations"),
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["./test/worker/setup.ts"],
        },
      },
    ],
  },
});
