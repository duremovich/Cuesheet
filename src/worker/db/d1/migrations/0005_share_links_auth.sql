CREATE TABLE `rate_limit_events` (
	`key` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_limit_events_key_at_idx` ON `rate_limit_events` (`key`,`at`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`show_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`table` text NOT NULL,
	`view_id` text,
	`preset` text,
	`options` text,
	`label` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	FOREIGN KEY (`show_id`) REFERENCES `shows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_hash_unique` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_show_idx` ON `share_links` (`show_id`);--> statement-breakpoint
ALTER TABLE `invites` ADD `kind` text DEFAULT 'signup' NOT NULL;--> statement-breakpoint
ALTER TABLE `invites` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `invites` ADD `show_id` text;--> statement-breakpoint
ALTER TABLE `invites` ADD `role` text;