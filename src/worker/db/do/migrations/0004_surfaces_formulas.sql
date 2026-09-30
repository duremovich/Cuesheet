CREATE TABLE `content_surfaces` (
	`content_id` text NOT NULL,
	`surface_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`content_id`, `surface_id`),
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surface_id`) REFERENCES `surfaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `content_surfaces_surface_idx` ON `content_surfaces` (`surface_id`);--> statement-breakpoint
CREATE TABLE `scene_surfaces` (
	`scene_id` text NOT NULL,
	`surface_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`scene_id`, `surface_id`),
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surface_id`) REFERENCES `surfaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scene_surfaces_surface_idx` ON `scene_surfaces` (`surface_id`);--> statement-breakpoint
CREATE TABLE `surfaces` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`order_key` text NOT NULL,
	`name` text,
	`channel` text,
	`parent_id` text,
	`width` real,
	`height` real,
	`pixel_width` real,
	`pixel_height` real,
	`throw_distance` real,
	`lens_ratio` real,
	`description` text
);
--> statement-breakpoint
CREATE INDEX `surfaces_order_idx` ON `surfaces` (`order_key`);--> statement-breakpoint
CREATE INDEX `surfaces_parent_idx` ON `surfaces` (`parent_id`);--> statement-breakpoint
ALTER TABLE `meta` ADD `default_unit` text;