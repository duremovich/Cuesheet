import { defineConfig } from "drizzle-kit";

// D1 schema. Generated SQL is applied with `pnpm db:migrate:local` (wrangler d1 migrations).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/db/d1/schema.ts",
  out: "./src/worker/db/d1/migrations",
});
