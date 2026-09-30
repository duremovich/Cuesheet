// ShowDO SQLite: one database per show, living inside that show's Durable Object.
// M0 has only `meta`; M1 adds scenes, cues, content, notes, ...
// After editing, run `pnpm db:generate`; migrations are applied in the DO constructor.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Single row (id = 1) describing the show this object holds. */
export const meta = sqliteTable("meta", {
  id: integer("id").primaryKey(),
  showId: text("show_id").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});
