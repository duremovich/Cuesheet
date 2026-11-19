// The team page renders only the controls the API allows: owner and admins manage everyone
// but the owner (admins grant up to admin), an editor the people they added (up to
// editor); the owner hands the team over and deletes it (only when empty) after in-row
// confirms; everyone but the owner can leave.
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InvitePolicy,
  PendingInviteDTO,
  ShowSummaryDTO,
  TeamDTO,
  TeamMemberDTO,
  TeamRole,
  UserDTO,
} from "../../shared/api";
import { api } from "../lib/api";
import { AuthProvider } from "../lib/auth";
import { click, render, wait } from "../test/dom";
import { TeamPage } from "./TeamPage";

const ME: UserDTO = { id: "u-me", email: "me@test.local", name: "Me", isAdmin: false };

function member(
  userId: string,
  name: string,
  role: TeamRole,
  invitedBy: string | null = null,
): TeamMemberDTO {
  return {
    userId,
    name,
    email: `${userId}@test.local`,
    role,
    invitedBy: invitedBy ? { id: invitedBy, name: invitedBy } : null,
    joinedAt: Date.UTC(2026, 10, 3),
    lastActiveAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
  };
}

async function mount(
  myRole: TeamRole,
  opts: { policy?: InvitePolicy; shows?: ShowSummaryDTO[]; invites?: PendingInviteDTO[] } = {},
) {
  const team: TeamDTO = {
    id: "team-1",
    name: "Crew",
    role: myRole,
    invitePolicy: opts.policy ?? "editors",
    createdAt: 0,
  };
  const members = [
    member("u-boss", "Boss", "owner"),
    member("u-me", "Me", myRole === "owner" ? "admin" : myRole),
    member("u-adm", "Adm", "admin"),
    member("u-mine", "Mine", "viewer", "u-me"),
    member("u-theirs", "Theirs", "viewer", "u-adm"),
  ];
  if (myRole === "owner") {
    members[0] = member("u-me", "Me", "owner");
    members[1] = member("u-ed", "Ed", "editor");
  }
  vi.spyOn(api, "me").mockResolvedValue({ user: ME });
  vi.spyOn(api, "getTeam").mockResolvedValue({ team });
  vi.spyOn(api, "teamMembers").mockResolvedValue({ members });
  vi.spyOn(api, "teamShows").mockResolvedValue({ shows: opts.shows ?? [] });
  vi.spyOn(api, "teamInvites").mockResolvedValue({ invites: opts.invites ?? [] });
  vi.spyOn(api, "people").mockResolvedValue({ people: [] });
  const r = render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/teams/team-1"]}>
        <Routes>
          <Route path="/teams/:id" element={<TeamPage user={ME} />} />
          <Route path="/" element={<p>shows</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
  await wait();
  return r;
}

const byLabel = (root: ParentNode, label: string) =>
  root.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
const dialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement;
const options = (el: HTMLElement | null) =>
  [...(el as HTMLSelectElement).options].map((o) => o.value);

afterEach(() => vi.restoreAllMocks());

describe("team page", () => {
  it("an admin manages everyone but the owner, granting up to admin", async () => {
    const { container } = await mount("admin");
    expect(byLabel(container, "Role for Boss")).toBeNull();
    expect(byLabel(container, "Remove Boss")).toBeNull();
    expect(byLabel(container, "Role for Me")).toBeNull();
    expect(options(byLabel(container, "Role for Adm"))).toEqual([
      "admin",
      "editor",
      "commenter",
      "viewer",
    ]);
    expect(byLabel(container, "Role for Theirs")).not.toBeNull();
    // Only the owner hands the team over or deletes it; an admin renames and sets the policy.
    expect(byLabel(container, "Make Adm the owner")).toBeNull();
    expect(button(container, "Delete team")).toBeUndefined();
    expect(button(container, "Rename")).toBeDefined();
    expect(container.textContent).toContain("Who can add people");
    expect(button(container, "Leave team")).toBeDefined();
    expect(container.querySelector('form[aria-label="Add people"]')).not.toBeNull();
  });

  it("an editor manages only the people they added, up to editor", async () => {
    const { container } = await mount("editor");
    expect(options(byLabel(container, "Role for Mine"))).toEqual(["editor", "commenter", "viewer"]);
    expect(byLabel(container, "Remove Mine")).not.toBeNull();
    expect(byLabel(container, "Role for Theirs")).toBeNull();
    expect(byLabel(container, "Role for Adm")).toBeNull();
    expect(button(container, "Rename")).toBeUndefined();
    expect(container.textContent).not.toContain("Who can add people");
    expect(container.textContent).toContain("Invited by u-me");
    expect(container.textContent).toContain("active 3 days ago");
  });

  it("with the owner-only policy an editor adds nobody and manages nobody", async () => {
    const { container } = await mount("editor", { policy: "owner" });
    expect(container.querySelector('form[aria-label="Add people"]')).toBeNull();
    expect(byLabel(container, "Role for Mine")).toBeNull();
  });

  it("an editor's own invite: Revoke always, Reissue only while they may still invite it", async () => {
    const invite: PendingInviteDTO = {
      id: "inv-1",
      email: "new@test.local",
      role: "editor",
      invitedBy: { id: "u-me", name: "Me" },
      createdAt: 0,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      expired: false,
    };
    const reissue = (root: HTMLElement) => byLabel(root, "Reissue the invite for new@test.local");
    const revoke = (root: HTMLElement) => byLabel(root, "Revoke the invite for new@test.local");
    const open = await mount("editor", { invites: [invite] });
    expect(reissue(open.container)).not.toBeNull();
    open.unmount();
    const closed = await mount("editor", { invites: [invite], policy: "owner" });
    expect(reissue(closed.container)).toBeNull();
    expect(revoke(closed.container)).not.toBeNull();
    closed.unmount();
    const demoted = await mount("commenter", { invites: [invite] });
    expect(reissue(demoted.container)).toBeNull();
    expect(revoke(demoted.container)).not.toBeNull();
    demoted.unmount();
    // Admins manage every invite, whatever the policy.
    const admin = await mount("admin", { invites: [invite], policy: "owner" });
    expect(reissue(admin.container)).not.toBeNull();
  });

  it("the owner hands the team over after an in-row confirm", async () => {
    const transfer = vi.spyOn(api, "transferTeam").mockResolvedValue({ ok: true });
    const native = vi.spyOn(window, "confirm");
    const { container } = await mount("owner");
    expect(button(container, "Leave team")).toBeUndefined();
    click(byLabel(container, "Make Ed the owner") as HTMLElement);
    expect(dialog().textContent).toContain("Make Ed the owner of Crew? You'll become an admin");
    expect(transfer).not.toHaveBeenCalled();
    click(button(dialog(), "Make owner") as HTMLButtonElement);
    await wait();
    expect(transfer).toHaveBeenCalledWith("team-1", "u-ed");
    expect(native).not.toHaveBeenCalled();
  });

  it("the owner deletes the team only once it has no shows", async () => {
    const show: ShowSummaryDTO = {
      id: "s1",
      name: "Hamlet",
      role: "editor",
      createdAt: 0,
      teamId: "team-1",
      teamName: "Crew",
    };
    const withShows = await mount("owner", { shows: [show] });
    expect(button(withShows.container, "Delete team")).toBeUndefined();
    expect(withShows.container.textContent).toContain("move its shows out");
    withShows.unmount();

    const del = vi.spyOn(api, "deleteTeam").mockResolvedValue({ ok: true });
    const empty = await mount("owner");
    click(button(empty.container, "Delete team") as HTMLButtonElement);
    expect(dialog().textContent).toContain("Delete Crew?");
    click(button(dialog(), "Delete team") as HTMLButtonElement);
    await wait();
    expect(del).toHaveBeenCalledWith("team-1");
    expect(empty.container.textContent).toBe("shows");
  });
});
