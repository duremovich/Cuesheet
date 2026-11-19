// Ambient declarations for the Worker build.

// Drizzle's durable-sqlite migrations import raw .sql files; the Vite `sqlText` plugin
// (vite.config.ts) turns them into string modules.
declare module "*.sql" {
  const sql: string;
  export default sql;
}

/**
 * Vite replaces this in the Worker bundle (`DEV` is true under `vite dev`; VITE_DEV_PAGES
 * is "1" in the e2e build). Both are build-time constants: production builds drop what
 * they guard.
 */
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean; readonly VITE_DEV_PAGES?: string };
}
