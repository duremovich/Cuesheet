CREATE TABLE `note_content` (
	`note_id` text NOT NULL,
	`content_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`note_id`, `content_id`),
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_id`) REFERENCES `content`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_content_content_idx` ON `note_content` (`content_id`);--> statement-breakpoint
-- A note's content becomes a many-to-many link (`notes.content`, like `notes.cues`). Every
-- existing single `notes.content_id` moves into the join as the note's only content
-- (position 0), then the column is cleared: it stays in the table, retired, because SQLite
-- can't drop a foreign-key column without rebuilding `notes`. Like 0008, not logged in
-- `changes` and no version bump: clients get the joins with the snapshot they fetch when
-- they reconnect.
INSERT OR IGNORE INTO `note_content` (`note_id`, `content_id`, `position`)
SELECT `n`.`id`, `n`.`content_id`, 0
FROM `notes` AS `n`
WHERE `n`.`content_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `content` AS `c` WHERE `c`.`id` = `n`.`content_id`);
--> statement-breakpoint
UPDATE `notes` SET `content_id` = NULL WHERE `content_id` IS NOT NULL;
