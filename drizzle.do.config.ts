import { defineConfig } from "drizzle-kit";

// ShowDO schema. The `durable-sqlite` driver also emits migrations.js, which the DO
// imports and applies in its constructor.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/worker/db/do/schema.ts",
  out: "./src/worker/db/do/migrations",
});
