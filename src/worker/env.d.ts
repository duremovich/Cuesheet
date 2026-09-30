// Ambient declarations for the Worker build.

// Drizzle's durable-sqlite migrations import raw .sql files; the Vite `sqlText` plugin
// (vite.config.ts) turns them into string modules.
declare module "*.sql" {
  const sql: string;
  export default sql;
}
