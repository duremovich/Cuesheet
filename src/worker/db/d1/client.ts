import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type D1Db = DrizzleD1Database<typeof schema>;

export function getDb(env: Pick<Env, "DB">): D1Db {
  return drizzle(env.DB, { schema });
}

export { schema };
