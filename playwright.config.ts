import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The e2e server builds the app and runs it with `vite preview` (the built Worker under
// workerd, same as production) against a throwaway local state dir, so every run starts
// from an empty database and the admin is seeded from .dev.vars on the first request.
//
// E2E_ORIGIN (default http://localhost:4317) picks the port, e.g. when 4317 is taken by
// another checkout's run. It's exported so the test workers (e2e/helpers.ts) see the same
// value. The state dir is per port and wiped at the start of every run. One run per
// checkout at a time: runs share `dist/`.
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:4317";
process.env.E2E_ORIGIN = ORIGIN;
const PORT = Number(new URL(ORIGIN).port || 80);
const STATE_DIR = `.wrangler/e2e-state-${PORT}`;

// The server reads .dev.vars; make sure it exists (CI) and give the tests the same creds.
if (!existsSync(".dev.vars")) copyFileSync(".dev.vars.example", ".dev.vars");
for (const line of readFileSync(".dev.vars", "utf8").split("\n")) {
  const m = /^\s*(ADMIN_EMAIL|ADMIN_PASSWORD)\s*=\s*(.*?)\s*$/.exec(line);
  if (m?.[1] && m[2] !== undefined) process.env[`E2E_${m[1]}`] = m[2].replace(/^"(.*)"$/, "$1");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // 3 workers on a 4-core machine (locally and in CI): the fourth core runs workerd, which
  // every test talks to. Stress with `pnpm e2e:stress` (6 workers, each test 3×).
  workers: 3,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  // One retry in CI only to capture a second trace; a test that needed it still fails the
  // run, so flakes can't hide.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: ORIGIN,
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
    url: `${ORIGIN}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
