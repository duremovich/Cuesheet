import type { Plugin } from "vite";

/**
 * Import `.sql` files as strings in the Vitest workers pool (drizzle's durable-sqlite
 * migrations.js imports them). The app build doesn't need it: the Cloudflare Vite plugin
 * bundles .sql as Text modules.
 */
export function sqlText(): Plugin {
  return {
    name: "cuesheet:sql-text",
    transform(code, id) {
      if (!id.endsWith(".sql")) return null;
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}
