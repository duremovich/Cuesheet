import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { createWriteStream, mkdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// TEMPORARY (probe branch): log every request's wall-clock start/end in the preview server.
function requestLog(): Plugin {
  return {
    name: "request-log",
    configurePreviewServer(server) {
      const dir = process.env.REQUEST_LOG_DIR;
      if (!dir) return;
      mkdirSync(dir, { recursive: true });
      const out = createWriteStream(`${dir}/requests-${Date.now()}.log`);
      server.middlewares.use((req, res, next) => {
        const t = Date.now();
        res.on("close", () => {
          out.write(`${t} ${Date.now()} ${res.statusCode} ${req.method} ${req.url}
`);
        });
        next();
      });
    },
  };
}

// CUESHEET_PERSIST lets the e2e server use its own throwaway local state
// (see playwright.config.ts); by default state lives in .wrangler/state like wrangler's.
const persistPath = process.env.CUESHEET_PERSIST;

// .sql imports (drizzle DO migrations) are bundled as Text modules by the Cloudflare plugin.
export default defineConfig({
  plugins: [requestLog(), react(), cloudflare(persistPath ? { persistState: { path: persistPath } } : {})],
});
