CREATE TABLE `views` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`table` text NOT NULL,
	`name` text,
	`owner_user_id` text,
	`is_default` integer DEFAULT 0 NOT NULL,
	`position` real,
	`config` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `views_table_idx` ON `views` (`table`);