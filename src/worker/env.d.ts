// Ambient declarations for the Worker build.

// Drizzle's durable-sqlite migrations import raw .sql files; the Vite `sqlText` plugin
// (vite.config.ts) turns them into string modules.
declare module "*.sql" {
  const sql: string;
  export default sql;
}

/** Vite replaces this in the Worker bundle (`DEV` is true under `vite dev`). */
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean };
}
