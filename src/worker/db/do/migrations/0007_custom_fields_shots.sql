CREATE TABLE `custom_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`table` text NOT NULL,
	`key` text NOT NULL,
	`label` text,
	`type` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`position` real,
	`width` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_fields_table_key_idx` ON `custom_fields` (`table`,`key`);--> statement-breakpoint
CREATE TABLE `custom_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`order_key` text NOT NULL,
	`table_id` text NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `custom_tables`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `custom_rows_order_idx` ON `custom_rows` (`order_key`);--> statement-breakpoint
CREATE INDEX `custom_rows_table_idx` ON `custom_rows` (`table_id`);--> statement-breakpoint
CREATE TABLE `custom_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`key` text,
	`label` text,
	`icon` text,
	`position` real,
	`primary_field_key` text
);
--> statement-breakpoint
CREATE TABLE `shot_content` (
	`shot_id` text NOT NULL,
	`content_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`shot_id`, `content_id`),
	FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shot_content_content_idx` ON `shot_content` (`content_id`);--> statement-breakpoint
CREATE TABLE `shot_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`name` text,
	`shoot_date` text,
	`location` text,
	`notes` text,
	`position` real
);
--> statement-breakpoint
CREATE TABLE `shot_talent` (
	`shot_id` text NOT NULL,
	`person_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`shot_id`, `person_id`),
	FOREIGN KEY (`shot_id`) REFERENCES `shots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shot_talent_person_idx` ON `shot_talent` (`person_id`);--> statement-breakpoint
CREATE TABLE `shots` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`order_key` text NOT NULL,
	`shot_list_id` text NOT NULL,
	`number` text,
	`group` text,
	`description` text,
	`framing` text,
	`camera` text,
	`lens` text,
	`resolution` text,
	`frame_rate` real,
	`duration` text,
	`status` text,
	FOREIGN KEY (`shot_list_id`) REFERENCES `shot_lists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shots_order_idx` ON `shots` (`order_key`);--> statement-breakpoint
CREATE INDEX `shots_list_idx` ON `shots` (`shot_list_id`);--> statement-breakpoint
-- Shot select options (data-model.md §ShotList and Shot).
INSERT INTO `field_options` (`table`, `field`, `value`, `color`, `position`) VALUES
  ('shots', 'framing', 'WS', 'blue', 0),
  ('shots', 'framing', 'MS', 'teal', 1),
  ('shots', 'framing', 'CU', 'green', 2),
  ('shots', 'framing', 'ECU', 'yellow', 3),
  ('shots', 'framing', 'OTS', 'purple', 4),
  ('shots', 'framing', 'Insert', 'gray', 5),
  ('shots', 'status', 'Planned', 'gray', 0),
  ('shots', 'status', 'Shot', 'blue', 1),
  ('shots', 'status', 'Selected', 'green', 2),
  ('shots', 'status', 'Cut', 'red', 3);
