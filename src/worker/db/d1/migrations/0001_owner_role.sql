-- M1: memberships.role gains 'owner' (the show's creator). Promote existing creators.
UPDATE `memberships` SET `role` = 'owner'
WHERE EXISTS (
  SELECT 1 FROM `shows`
  WHERE `shows`.`id` = `memberships`.`show_id` AND `shows`.`created_by` = `memberships`.`user_id`
);
