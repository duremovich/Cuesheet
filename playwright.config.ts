import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statfsSync } from "node:fs";
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
const STATE_DIR = process.env.E2E_STATE_DIR ?? stateDir(PORT);

/**
 * Where the e2e server keeps its D1/Durable Object/R2 state. On Linux (CI), in RAM
 * (/dev/shm): workerd does its SQLite and file I/O on the one thread that serves every
 * request, so on the CI runner's disk a write burst stalls the whole server for seconds
 * (measured: health probes up to 2.2 s, a page load 4 s, past the 5 s expect timeout).
 * On tmpfs the worst probe was 0.46 s. Elsewhere (or with < 1 GB free there), in
 * .wrangler/. Per checkout and port, so parallel runs don't share it.
 */
function stateDir(port: number): string {
  const local = `.wrangler/e2e-state-${port}`;
  if (process.platform !== "linux") return local;
  try {
    const fs = statfsSync("/dev/shm");
    if (fs.bavail * fs.bsize < 1024 ** 3) return local;
  } catch {
    return local;
  }
  const checkout = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 8);
  return `/dev/shm/cuesheet-e2e-${checkout}-${port}`;
}

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
    // Wipe the state dir, build with the /dev/* pages, migrate, `vite preview` (see the script).
    command: `node scripts/e2e-server.ts ${PORT} ${STATE_DIR}`,
    url: `${ORIGIN}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
