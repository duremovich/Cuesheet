-- drizzle-kit drops ON DELETE from ALTER TABLE … ADD on SQLite: the three clauses below
-- (invites.team_id, memberships.invited_by, shows.team_id) were appended by hand to match
-- schema.ts and the snapshot.
CREATE TABLE `team_memberships` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `team_memberships_user_idx` ON `team_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`invite_policy` text DEFAULT 'editors' NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `invites` ADD `team_id` text REFERENCES teams(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `invites` ADD `team_role` text;--> statement-breakpoint
ALTER TABLE `invites` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `memberships` ADD `invited_by` text REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `shows` ADD `team_id` text REFERENCES teams(id) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `shows` ADD `invite_policy` text DEFAULT 'editors' NOT NULL;--> statement-breakpoint
CREATE INDEX `shows_team_idx` ON `shows` (`team_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `last_active_at` integer;