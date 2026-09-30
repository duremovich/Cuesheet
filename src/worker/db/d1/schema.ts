// D1: the cross-show index (users, sessions, shows, memberships, invites).
// Per-show data lives in the show's Durable Object; see ../do/schema.ts.
// After editing, run `pnpm db:generate` and commit the new SQL in ./migrations.
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull().default(now),
});

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 (hex) of the cookie token; the raw token is never stored. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(now),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const shows = sqliteTable("shows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull().default(now),
  /** The rehearsal/session new notes are stamped with ("Tech 2"); shared by the team. */
  currentSession: text("current_session"),
});

export const memberships = sqliteTable(
  "memberships",
  {
    showId: text("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "editor", "commenter", "viewer"] }).notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.showId, t.userId] }),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const invites = sqliteTable("invites", {
  /** SHA-256 (hex) of the invite token; the raw token only appears in the link. */
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  invitedBy: text("invited_by")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at").notNull().default(now),
  expiresAt: integer("expires_at").notNull(),
  acceptedAt: integer("accepted_at"),
});
