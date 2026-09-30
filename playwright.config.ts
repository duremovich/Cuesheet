import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The e2e server builds the app and runs it with `vite preview` (the built Worker under
// workerd, same as production) against a throwaway local state dir, so every run starts
// from an empty database and the admin is seeded from .dev.vars on the first request.
const PORT = 4317;
const STATE_DIR = ".wrangler/e2e-state";

// The server reads .dev.vars; make sure it exists (CI) and give the tests the same creds.
if (!existsSync(".dev.vars")) copyFileSync(".dev.vars.example", ".dev.vars");
for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
  const m = /^\s*(ADMIN_EMAIL|ADMIN_PASSWORD)\s*=\s*(.*?)\s*$/.exec(line);
  if (m?.[1] && m[2] !== undefined) process.env[`E2E_${m[1]}`] = m[2].replace(/^"(.*)"$/, "$1");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: [
      `rm -rf ${STATE_DIR}`,
      // VITE_DEV_PAGES=1 includes the /dev/* pages (e2e/grid.spec.ts) in this build only.
      "VITE_DEV_PAGES=1 pnpm build",
      `pnpm exec wrangler d1 migrations apply DB --local --persist-to ${STATE_DIR}`,
      `CUESHEET_PERSIST=${STATE_DIR} pnpm exec vite preview --port ${PORT} --strictPort`,
    ].join(" && "),
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
