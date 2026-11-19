// Words for roles in sentences and the team role descriptions.
import type { TeamRole } from "../../../shared/api";

/** "an editor", "an admin", "a viewer". */
export function withArticle(role: string): string {
  return /^[aeiou]/.test(role) ? `an ${role}` : `a ${role}`;
}

export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  owner: "Everything, plus deleting the team. One per team.",
  admin: "Manages the team's members and settings; editor on every show of the team.",
  editor: "Editor on every show of the team; adds shows to it.",
  commenter: "Commenter on every show of the team.",
  viewer: "Viewer on every show of the team.",
};
