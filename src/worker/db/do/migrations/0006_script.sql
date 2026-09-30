CREATE TABLE `cue_anchors` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`cue_id` text NOT NULL,
	`script_version_id` text NOT NULL,
	`block` integer,
	`offset` integer,
	`length` integer,
	`quote` text,
	`prefix` text,
	`suffix` text,
	`page` integer,
	`state` text,
	`confidence` real,
	FOREIGN KEY (`cue_id`) REFERENCES `cues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_version_id`) REFERENCES `script_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cue_anchors_cue_version_idx` ON `cue_anchors` (`cue_id`,`script_version_id`);--> statement-breakpoint
CREATE INDEX `cue_anchors_version_idx` ON `cue_anchors` (`script_version_id`);--> statement-breakpoint
CREATE TABLE `script_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`script_id` text NOT NULL,
	`label` text,
	`attachment_id` text,
	`imported_at` integer,
	`source` text,
	`confidence` real,
	`text_key` text,
	`text_bytes` integer,
	`block_count` integer,
	`page_count` integer,
	`page_map` text DEFAULT '[]' NOT NULL,
	`stats` text DEFAULT '{}' NOT NULL,
	`position` real,
	FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `script_versions_script_idx` ON `script_versions` (`script_id`);--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`custom` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`title` text,
	`current_version_id` text
);
--> statement-breakpoint
-- Re-anchoring states for cue_anchors.state (decision 0004, ux.md §New script version).
INSERT INTO `field_options` (`table`, `field`, `value`, `color`, `position`) VALUES
  ('cue_anchors', 'state', 'matched', 'green', 0),
  ('cue_anchors', 'state', 'moved', 'blue', 1),
  ('cue_anchors', 'state', 'changed', 'yellow', 2),
  ('cue_anchors', 'state', 'missing', 'red', 3),
  ('cue_anchors', 'state', 'manual', 'purple', 4);
--> statement-breakpoint
-- A cue cut from the script keeps its row (the resolve screen's "Cut"): cues.status "Cut",
-- after the existing options.
INSERT OR IGNORE INTO `field_options` (`table`, `field`, `value`, `color`, `position`)
  SELECT 'cues', 'status', 'Cut', 'red', coalesce(max(`position`), -1) + 1
  FROM `field_options` WHERE `table` = 'cues' AND `field` = 'status';
