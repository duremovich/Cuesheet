import { describe, expect, it } from "vitest";
import { canReissueShowInvite } from "./reissue";

const byOwner = { role: "editor" as const, invitedBy: { id: "owner", name: "Owner" } };
const byMe = { role: "commenter" as const, invitedBy: { id: "me", name: "Me" } };
const byGone = { role: "viewer" as const, invitedBy: null };

describe("canReissueShowInvite", () => {
  it("the show's owner always", () => {
    const owner = { id: "owner", role: "owner" as const };
    expect(canReissueShowInvite(owner, "owner", byGone)).toBe(true);
  });

  it("an inviter their own invites, while they could still make them", () => {
    const editor = { id: "me", role: "editor" as const };
    expect(canReissueShowInvite(editor, "editors", byMe)).toBe(true);
    expect(canReissueShowInvite(editor, "editors", byOwner)).toBe(false);
    expect(canReissueShowInvite(editor, "owner", byMe)).toBe(false);
    expect(canReissueShowInvite({ id: "me", role: "viewer" }, "editors", byMe)).toBe(false);
  });

  it("a team owner/admin anyone's, but never past an owner-only policy", () => {
    const admin = { id: "me", role: "editor" as const, teamRole: "admin" as const };
    expect(canReissueShowInvite(admin, "editors", byOwner)).toBe(true);
    expect(canReissueShowInvite(admin, "editors", byGone)).toBe(true);
    expect(canReissueShowInvite(admin, "owner", byOwner)).toBe(false);
    expect(canReissueShowInvite(admin, "owner", byGone)).toBe(false);
    // A team editor isn't a manager: only their own.
    const teamEditor = { id: "me", role: "editor" as const, teamRole: "editor" as const };
    expect(canReissueShowInvite(teamEditor, "editors", byOwner)).toBe(false);
  });
});
