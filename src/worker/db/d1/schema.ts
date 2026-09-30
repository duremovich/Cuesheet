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
  /** Bytes of attachments in R2 (thumbnails not counted); kept by the Worker, max 2 GB. */
  storageBytes: integer("storage_bytes").notNull().default(0),
  /** A show template (R27): listed separately; "New from template" clones it. */
  isTemplate: integer("is_template", { mode: "boolean" }).notNull().default(false),
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
  /**
   * `signup`: a new account (the invite link). `reset`: an admin's one-time password
   * reset link for `userId` (the same page shape; `/reset/<token>`).
   */
  kind: text("kind", { enum: ["signup", "reset"] })
    .notNull()
    .default("signup"),
  /** reset: the account whose password the link sets. */
  userId: text("user_id"),
  /** signup: the show the new account joins on accept (null: none), with `role`. */
  showId: text("show_id"),
  role: text("role", { enum: ["editor", "commenter", "viewer"] }),
});

/**
 * Read-only links to one table/view or print layout of a show (R23), opened without
 * signing in at `/s/<token>`. Only the token's SHA-256 is stored.
 */
export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    showId: text("show_id")
      .notNull()
      .references(() => shows.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** `view`: the live grid rendering; `print`: a print layout. */
    kind: text("kind", { enum: ["view", "print"] }).notNull(),
    /** The data table (`cues`, `notes`, …) the link shows. */
    table: text("table").notNull(),
    /** The shared view shown (null: the table's default view, or a preset). */
    viewId: text("view_id"),
    /** A built-in layout instead of a view: calling-script, cuesheet, by-person, … */
    preset: text("preset"),
    /** JSON of preset options ({session, orient, …}). */
    options: text("options"),
    label: text("label"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull().default(now),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [index("share_links_show_idx").on(t.showId)],
);

/**
 * Sliding-window rate limiting (R24): one row per counted event (a failed login, a bad
 * invite or share token) under a key like `login:email:<email>`. Rows older than the
 * longest window are pruned when their key is checked, and by the scheduled handler.
 */
export const rateLimitEvents = sqliteTable(
  "rate_limit_events",
  {
    key: text("key").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [index("rate_limit_events_key_at_idx").on(t.key, t.at)],
);
