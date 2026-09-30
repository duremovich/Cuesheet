import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// CUESHEET_PERSIST lets the e2e server use its own throwaway local state
// (see playwright.config.ts); by default state lives in .wrangler/state like wrangler's.
const persistPath = process.env.CUESHEET_PERSIST;

// .sql imports (drizzle DO migrations) are bundled as Text modules by the Cloudflare plugin.
export default defineConfig({
  plugins: [react(), cloudflare(persistPath ? { persistState: { path: persistPath } } : {})],
});
