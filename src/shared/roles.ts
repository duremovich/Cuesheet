// Who may grant, invite and manage whom (decisions 2–4 of the teams plan), as pure
// functions both sides can use: the Worker enforces them (src/worker/access.ts, which also
// resolves effective roles from D1), the web client renders only the controls they allow.
// Keep this file free of runtime dependencies and in step with access.ts.
import type { InvitePolicy, Role, TeamRole } from "./api";

/** Team and show roles on one scale, for capping grants (`canGrant`). */
const GRANT_RANK: Record<TeamRole | Role, number> = {
  owner: 5,
  admin: 4,
  editor: 3,
  commenter: 2,
  viewer: 1,
};

/** The show role a team role gives on every show of the team. */
export function showRoleFromTeamRole(role: TeamRole): Role {
  return role === "owner" || role === "admin" ? "editor" : role;
}

/**
 * Whether someone holding `actor` (a show or team role) may grant `role`. Nobody grants
 * `owner` (that's a transfer); commenters and viewers grant nothing; otherwise up to your
 * own level (team admins grant admin, editors editor, a show owner editor and below).
 */
export function canGrant(actor: TeamRole | Role, role: TeamRole | Role): boolean {
  if (role === "owner") return false;
  if (GRANT_RANK[actor] < GRANT_RANK.editor) return false;
  return GRANT_RANK[role] <= GRANT_RANK[actor];
}

/** Team owner and admins manage every member but the owner. */
export function isTeamManager(role: TeamRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Team editors and up: may create shows in the team and move their shows into it. */
export function isTeamEditor(role: TeamRole | null | undefined): boolean {
  return !!role && GRANT_RANK[role] >= GRANT_RANK.editor;
}

/** Who may add people to a team: owner and admins always, editors unless the policy is `owner`. */
export function canInviteToTeam(role: TeamRole | null | undefined, policy: InvitePolicy): boolean {
  if (isTeamManager(role)) return true;
  return role === "editor" && policy === "editors";
}

/** Who may add people to a show: the owner always, editors unless the policy is `owner`. */
export function canInviteToShow(role: Role | null | undefined, policy: InvitePolicy): boolean {
  if (role === "owner") return true;
  return role === "editor" && policy === "editors";
}

/** Someone whose membership is being changed or removed. */
export interface ManagedMember {
  role: TeamRole | Role;
  invitedBy: string | null;
}

/**
 * Whether `actor` may change or remove `target`, a direct member of a show (`target.role`
 * is their direct role). Never the show's owner. The show's owner manages everyone else,
 * and so do the owner and admins of the show's team (`actor.teamRole`: the actor's role in
 * the show's team, if any; their show role is editor, which caps what they grant). An
 * editor allowed to invite manages the people they added, while those hold a role within
 * their own.
 */
export function canManageShowMember(
  actor: { id: string; role: Role; teamRole?: TeamRole | null },
  policy: InvitePolicy,
  target: ManagedMember,
): boolean {
  if (target.role === "owner") return false;
  if (actor.role === "owner") return true;
  if (isTeamManager(actor.teamRole)) return true;
  return (
    canInviteToShow(actor.role, policy) &&
    target.invitedBy === actor.id &&
    canGrant(actor.role, target.role)
  );
}

/** The same in a team: owner and admins manage everyone but the owner (admins too). */
export function canManageTeamMember(
  actor: { id: string; role: TeamRole },
  policy: InvitePolicy,
  target: ManagedMember,
): boolean {
  if (target.role === "owner") return false;
  if (isTeamManager(actor.role)) return true;
  return (
    canInviteToTeam(actor.role, policy) &&
    target.invitedBy === actor.id &&
    canGrant(actor.role, target.role)
  );
}
