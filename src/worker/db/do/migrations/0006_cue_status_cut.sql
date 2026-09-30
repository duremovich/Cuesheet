-- The cue status "Cut" (the script view's Resolve screen marks cues cut, ux.md §New script
-- version). Temporary M4b migration: to be folded into M4a's 0006 at merge.
INSERT INTO `field_options` (`table`, `field`, `value`, `color`, `position`)
SELECT 'cues', 'status', 'Cut', 'red', 4
WHERE NOT EXISTS (
  SELECT 1 FROM `field_options` WHERE `table` = 'cues' AND `field` = 'status' AND `value` = 'Cut'
);
