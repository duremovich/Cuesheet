// The e2e webServer (playwright.config.ts): wipe the state dir, build with the /dev/* pages,
// apply the D1 migrations to that state dir and serve the build with `vite preview`.
// A Node script rather than a shell one-liner so it runs the same under sh and cmd.exe:
// the CLIs are started with this Node directly, no shell or .cmd shims involved.
//
//   node scripts/e2e-server.ts <port> <state dir>
import { type SpawnOptions, spawn } from "node:child_process";
import { rmSync } from "node:fs";

const [port, stateDir] = process.argv.slice(2);
if (!port || !stateDir) throw new Error("usage: node scripts/e2e-server.ts <port> <state dir>");

const VITE = "node_modules/vite/bin/vite.js";
const WRANGLER = "node_modules/wrangler/bin/wrangler.js";

function run(script: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  const opts: SpawnOptions = { stdio: "inherit", env: { ...process.env, ...env } };
  const child = spawn(process.execPath, [script, ...args], opts);
  // Pass Playwright's shutdown on to the long-running preview server.
  const stop = () => child.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (code === 0) resolve();
      else reject(new Error(`${script} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

// stderr reaches the Playwright output (stdout is ignored): say where the state lives.
process.stderr.write(`e2e server state: ${stateDir}\n`);
rmSync(stateDir, { recursive: true, force: true });
// VITE_DEV_PAGES=1 includes the /dev/* pages (e2e/grid.spec.ts) in this build only.
await run(VITE, ["build"], { VITE_DEV_PAGES: "1" });
await run(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir]);
await run(VITE, ["preview", "--port", port, "--strictPort"], { CUESHEET_PERSIST: stateDir });
