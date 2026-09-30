import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: already-applied migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
