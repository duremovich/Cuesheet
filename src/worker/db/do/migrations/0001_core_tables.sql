CREATE TABLE `changes` (
	`version` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`user_id` text NOT NULL,
	`table` text NOT NULL,
	`record_id` text NOT NULL,
	`field` text NOT NULL,
	`old` text,
	`new` text,
	`client_id` text
);
--> statement-breakpoint
CREATE INDEX `changes_record_idx` ON `changes` (`table`,`record_id`);--> statement-breakpoint
CREATE TABLE `content` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`order_key` text NOT NULL,
	`scene_id` text,
	`name` text,
	`description` text,
	`creator_id` text,
	`status` text,
	`loop_in` text,
	`loop_out` text,
	`duration` text,
	`resolution` text,
	`frame_rate` real,
	`file_path` text,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`creator_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `content_order_idx` ON `content` (`order_key`);--> statement-breakpoint
CREATE INDEX `content_scene_idx` ON `content` (`scene_id`);--> statement-breakpoint
CREATE TABLE `cue_assignees` (
	`cue_id` text NOT NULL,
	`person_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`cue_id`, `person_id`),
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cue_assignees_person_idx` ON `cue_assignees` (`person_id`);--> statement-breakpoint
CREATE TABLE `cue_content` (
	`cue_id` text NOT NULL,
	`content_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`cue_id`, `content_id`),
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cue_content_content_idx` ON `cue_content` (`content_id`);--> statement-breakpoint
CREATE TABLE `cues` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`order_key` text NOT NULL,
	`scene_id` text,
	`number` text,
	`description` text,
	`trigger_type` text,
	`trigger_value` text,
	`sm_call` text,
	`lx_cue` text,
	`sq_cue` text,
	`timecode` text,
	`ae_time` text,
	`measure` text,
	`page` text,
	`status` text,
	`is_section` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cues_order_idx` ON `cues` (`order_key`);--> statement-breakpoint
CREATE INDEX `cues_scene_idx` ON `cues` (`scene_id`);--> statement-breakpoint
CREATE TABLE `field_options` (
	`table` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`color` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`table`, `field`, `value`)
);
--> statement-breakpoint
CREATE TABLE `note_assignees` (
	`note_id` text NOT NULL,
	`person_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`note_id`, `person_id`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_assignees_person_idx` ON `note_assignees` (`person_id`);--> statement-breakpoint
CREATE TABLE `note_cues` (
	`note_id` text NOT NULL,
	`cue_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`note_id`, `cue_id`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_cues_cue_idx` ON `note_cues` (`cue_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`body` text,
	`type` text DEFAULT '[]' NOT NULL,
	`priority` text,
	`status` text,
	`content_id` text,
	`scene_id` text,
	`session` text,
	`completed_by` text,
	`completed_at` integer,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notes_created_idx` ON `notes` (`created_at`);--> statement-breakpoint
CREATE TABLE `persons` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`name` text,
	`role` text,
	`group` text,
	`email` text,
	`phone` text,
	`organization` text,
	`user_id` text
);
--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`order_key` text NOT NULL,
	`number` text,
	`name` text,
	`act` text,
	`location` text,
	`time_of_day` text,
	`song` text,
	`stage_direction` text,
	`description` text,
	`video_overview` text
);
--> statement-breakpoint
CREATE INDEX `scenes_order_idx` ON `scenes` (`order_key`);