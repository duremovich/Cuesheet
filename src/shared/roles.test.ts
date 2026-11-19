// The grant/invite/manage rules the web client renders controls from (the Worker's
// access.ts enforces the same ones; test/worker/people.test.ts covers the routes).
import { describe, expect, it } from "vitest";
import {
  canGrant,
  canInviteToShow,
  canInviteToTeam,
  canManageShowMember,
  canManageTeamMember,
  showRoleFromTeamRole,
} from "./roles";

describe("roles", () => {
  it("team owner/admin are editors on the team's shows", () => {
    expect(showRoleFromTeamRole("owner")).toBe("editor");
    expect(showRoleFromTeamRole("admin")).toBe("editor");
    expect(showRoleFromTeamRole("viewer")).toBe("viewer");
  });

  it("nobody grants owner or above their own role; commenters grant nothing", () => {
    expect(canGrant("owner", "owner")).toBe(false);
    expect(canGrant("owner", "editor")).toBe(true);
    expect(canGrant("admin", "admin")).toBe(true);
    expect(canGrant("editor", "admin")).toBe(false);
    expect(canGrant("editor", "viewer")).toBe(true);
    expect(canGrant("commenter", "viewer")).toBe(false);
  });

  it("invite policies", () => {
    expect(canInviteToShow("editor", "editors")).toBe(true);
    expect(canInviteToShow("editor", "owner")).toBe(false);
    expect(canInviteToShow("owner", "owner")).toBe(true);
    expect(canInviteToTeam("admin", "owner")).toBe(true);
    expect(canInviteToTeam("editor", "owner")).toBe(false);
    expect(canInviteToTeam("commenter", "editors")).toBe(false);
  });

  it("inviters manage their own invitees within their cap; managers everyone but the owner", () => {
    const ed = { id: "ed", role: "editor" as const };
    expect(canManageShowMember(ed, "editors", { role: "viewer", invitedBy: "ed" })).toBe(true);
    expect(canManageShowMember(ed, "editors", { role: "viewer", invitedBy: "x" })).toBe(false);
    expect(canManageShowMember(ed, "owner", { role: "viewer", invitedBy: "ed" })).toBe(false);
    expect(
      canManageShowMember({ id: "o", role: "owner" }, "owner", { role: "editor", invitedBy: null }),
    ).toBe(true);
    const admin = { id: "a", role: "admin" as const };
    expect(canManageTeamMember(admin, "owner", { role: "admin", invitedBy: null })).toBe(true);
    expect(canManageTeamMember(admin, "owner", { role: "owner", invitedBy: null })).toBe(false);
    expect(
      canManageTeamMember({ id: "e", role: "editor" }, "editors", {
        role: "admin",
        invitedBy: "e",
      }),
    ).toBe(false);
  });
});
