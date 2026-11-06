-- Row height "auto" (fit to content) is the new default. Until now "normal" was the
-- default and what every view got without anyone choosing it, so there's no telling an
-- explicit "normal" from the default: move them all to "auto". Compact and tall (explicit
-- choices) stay. Like the seeded views, not logged in `changes` and no version bump: the
-- open clients pick it up with the snapshot they fetch when they reconnect.
UPDATE `views`
SET `config` = json_set(`config`, '$.rowHeight', 'auto')
WHERE json_valid(`config`) AND json_extract(`config`, '$.rowHeight') = 'normal';
