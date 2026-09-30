CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`table` text NOT NULL,
	`record_id` text NOT NULL,
	`field` text DEFAULT 'attachments' NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`width` integer,
	`height` integer,
	`thumb_key` text,
	`position` real
);
--> statement-breakpoint
CREATE INDEX `attachments_record_idx` ON `attachments` (`table`,`record_id`);--> statement-breakpoint
CREATE TABLE `content_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`content_id` text NOT NULL,
	`version` text,
	`date` text,
	`rendered_by` text,
	`changes` text,
	`file_path` text,
	`is_current` integer DEFAULT 0 NOT NULL,
	`status` text,
	`position` real,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rendered_by`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `content_versions_content_idx` ON `content_versions` (`content_id`);--> statement-breakpoint
-- Default select options for content_versions.status (docs/spec/data-model.md).
INSERT INTO `field_options` (`table`, `field`, `value`, `color`, `position`) VALUES
  ('content_versions', 'status', 'Rendering', 'yellow', 0),
  ('content_versions', 'status', 'Available', 'green', 1),
  ('content_versions', 'status', 'In Millumin', 'blue', 2),
  ('content_versions', 'status', 'Superseded', 'gray', 3);
