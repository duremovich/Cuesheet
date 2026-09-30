// Worker entry point. Durable Object classes must be exported from here.
// /api/* goes to the Hono app; every other path (pages, robots.txt, …) is served from the
// static assets with security headers (src/worker/security.ts), except the hashed build
// files under /assets/, which the platform serves without running the Worker
// (wrangler.jsonc `run_worker_first`).
import { app } from "./app";
import { scheduled } from "./routes/backup";
import { serveAsset } from "./security";

export { ShowDO } from "./do/ShowDO";

/** Vite's dev server injects inline scripts of its own; the CSP is for built pages. */
const DEV = import.meta.env?.DEV === true;

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    return serveAsset(request, env.ASSETS, { csp: !DEV });
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduled(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
