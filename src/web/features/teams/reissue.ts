// Who may reissue a pending show invite (a new link and 7 days), mirroring the server:
// the show's owner always; anyone else must be able to make that invite themselves
// (allowed to invite under the show's policy, and the role within their own), and it must
// be their own invite or they must manage the show's team (owner/admin). Revoking is wider:
// everyone who sees an invite may revoke it.
import type { InvitePolicy, PendingInviteDTO, Role, TeamRole } from "../../../shared/api";
import { canGrant, canInviteToShow, isTeamManager } from "../../../shared/roles";

export function canReissueShowInvite(
  actor: { id: string; role: Role; teamRole?: TeamRole | null },
  policy: InvitePolicy,
  invite: Pick<PendingInviteDTO, "role" | "invitedBy">,
): boolean {
  if (actor.role === "owner") return true;
  return (
    canInviteToShow(actor.role, policy) &&
    canGrant(actor.role, invite.role) &&
    (invite.invitedBy?.id === actor.id || isTeamManager(actor.teamRole))
  );
}
