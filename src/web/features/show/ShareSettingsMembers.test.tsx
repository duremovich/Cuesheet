// Show settings → Members: the owner's "Make owner" asks in-row (never a native dialog),
// and only a confirmed handover calls the API. Controls follow the API's rules (an editor
// manages only the people they added; team members are managed in the team), adding
// people reports an invite with its link, and revoking or moving the show asks in-row.
import { act } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InvitePolicy,
  MemberDTO,
  PendingInviteDTO,
  Role,
  ShowResponse,
  TeamDTO,
  TeamMemberDTO,
} from "../../../shared/api";
import { api } from "../../lib/api";
import { AuthProvider } from "../../lib/auth";
import { click, press, render, setInputValue, wait } from "../../test/dom";
import { MembersSection } from "./ShareSettingsMembers";
import { type Workspace, WorkspaceContext } from "./workspace";

const DIRECT = {
  source: "direct",
  teamRole: null,
  invitedBy: null,
  joinedAt: 0,
  lastActiveAt: null,
} as const;
const MEMBERS: MemberDTO[] = [
  {
    userId: "u-owner",
    email: "owner@test.local",
    name: "Owner",
    role: "owner",
    directRole: "owner",
    ...DIRECT,
  },
  {
    userId: "u-dylan",
    email: "dylan@test.local",
    name: "Dylan",
    role: "editor",
    directRole: "editor",
    ...DIRECT,
  },
];

/** Dylan (editor) added Guest; Other was added by the owner; Crew is here through the team. */
const TEAM_SHOW_MEMBERS: MemberDTO[] = [
  ...MEMBERS,
  {
    userId: "u-guest",
    email: "guest@test.local",
    name: "Guest",
    role: "commenter",
    directRole: "commenter",
    ...DIRECT,
    invitedBy: { id: "u-dylan", name: "Dylan" },
  },
  {
    userId: "u-other",
    email: "other@test.local",
    name: "Other",
    role: "viewer",
    directRole: "viewer",
    ...DIRECT,
    invitedBy: { id: "u-owner", name: "Owner" },
  },
  {
    userId: "u-crew",
    email: "crew@test.local",
    name: "Crew",
    role: "editor",
    source: "team",
    directRole: null,
    teamRole: "admin",
    invitedBy: null,
    joinedAt: 0,
    lastActiveAt: null,
  },
];

function workspace(role: Role): Workspace {
  return {
    showId: "show-1",
    showName: "Wilderness",
    role,
    userId: role === "owner" ? "u-owner" : "u-dylan",
    canEdit: role === "owner" || role === "editor",
    canComment: role !== "viewer",
    memberNames: new Map(),
    toast: () => undefined,
    reportError: () => undefined,
    sortCuesNow: async () => true,
    openImport: () => undefined,
  };
}

function showResponse(
  team: { id: string; name: string } | null,
  invitePolicy: InvitePolicy = "editors",
): ShowResponse {
  return {
    show: {
      showId: "show-1",
      name: "Wilderness",
      createdAt: 0,
      currentSession: null,
      teamId: team?.id ?? null,
      teamName: team?.name ?? null,
      invitePolicy,
    },
    role: "owner",
  };
}

async function mount(
  role: Role,
  opts: {
    members?: MemberDTO[];
    team?: { id: string; name: string } | null;
    policy?: InvitePolicy;
    invites?: PendingInviteDTO[];
    teams?: TeamDTO[];
    onMembersChanged?: () => void;
  } = {},
) {
  vi.spyOn(api, "me").mockResolvedValue({ user: null });
  vi.spyOn(api, "getShow").mockResolvedValue(showResponse(opts.team ?? null, opts.policy));
  vi.spyOn(api, "showInvites").mockResolvedValue({ invites: opts.invites ?? [] });
  vi.spyOn(api, "people").mockResolvedValue({ people: [] });
  vi.spyOn(api, "listTeams").mockResolvedValue({ teams: opts.teams ?? [] });
  const rendered = render(
    <AuthProvider>
      <MemoryRouter>
        <WorkspaceContext value={workspace(role)}>
          <MembersSection
            members={opts.members ?? MEMBERS}
            onMembersChanged={opts.onMembersChanged ?? (() => undefined)}
          />
        </WorkspaceContext>
      </MemoryRouter>
    </AuthProvider>,
  );
  await wait();
  return rendered;
}

const byLabel = (root: ParentNode, label: string) =>
  root.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const makeOwnerButton = (root: HTMLElement) =>
  byLabel(root, "Make Dylan the owner") as HTMLButtonElement | null;
const dialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null;
const buttonIn = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
const options = (el: HTMLElement | null) =>
  [...(el as HTMLSelectElement).options].map((o) => o.value);
const row = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll('[data-testid="members"] > li')].find((li) =>
    li.textContent?.startsWith(name),
  ) as HTMLElement;

afterEach(() => vi.restoreAllMocks());

describe("Make owner", () => {
  it("confirms in the row, then transfers and refreshes the list", async () => {
    const native = vi.spyOn(window, "confirm");
    const transfer = vi.spyOn(api, "transferOwnership").mockResolvedValue({ ok: true });
    const changed = vi.fn();
    const { container } = await mount("owner", { onMembersChanged: changed });
    // The owner's own row has no actions.
    expect(byLabel(container, "Make Owner the owner")).toBeNull();

    click(makeOwnerButton(container) as HTMLButtonElement);
    const strip = dialog() as HTMLElement;
    expect(strip.textContent).toContain("Make Dylan the owner of Wilderness?");
    expect(strip.textContent).toContain("You'll become an editor");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(transfer).not.toHaveBeenCalled();

    click(buttonIn(strip, "Make owner"));
    await wait();
    expect(transfer).toHaveBeenCalledWith("show-1", "u-dylan");
    expect(changed).toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(native).not.toHaveBeenCalled();
  });

  it("Cancel and Escape leave everything as it was", async () => {
    const transfer = vi.spyOn(api, "transferOwnership").mockResolvedValue({ ok: true });
    const { container } = await mount("owner");
    click(makeOwnerButton(container) as HTMLButtonElement);
    click(buttonIn(dialog() as HTMLElement, "Cancel"));
    expect(dialog()).toBeNull();
    click(makeOwnerButton(container) as HTMLButtonElement);
    press("Escape");
    expect(dialog()).toBeNull();
    expect(transfer).not.toHaveBeenCalled();
  });

  it("shows the API's error", async () => {
    vi.spyOn(api, "transferOwnership").mockRejectedValue(new Error("Not a member of this show"));
    const { container } = await mount("owner");
    click(makeOwnerButton(container) as HTMLButtonElement);
    click(buttonIn(dialog() as HTMLElement, "Make owner"));
    await wait();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Not a member of this show",
    );
  });

  it("isn't offered to non-owners", async () => {
    const { container } = await mount("editor");
    expect(makeOwnerButton(container)).toBeNull();
  });
});

describe("who manages whom", () => {
  const team = { id: "team-1", name: "Crew" };

  it("an editor manages only the people they added, up to editor", async () => {
    const { container } = await mount("editor", { members: TEAM_SHOW_MEMBERS, team });
    const guestRole = byLabel(container, "Role for Guest") as HTMLSelectElement;
    expect(guestRole).not.toBeNull();
    expect([...guestRole.options].map((o) => o.value)).toEqual(["editor", "commenter", "viewer"]);
    expect(byLabel(container, "Remove Guest")).not.toBeNull();
    // Added by the owner: read-only for the editor; never the owner, nor yourself.
    expect(byLabel(container, "Role for Other")).toBeNull();
    expect(byLabel(container, "Remove Other")).toBeNull();
    expect(byLabel(container, "Role for Owner")).toBeNull();
    expect(byLabel(container, "Role for Dylan")).toBeNull();
    expect(row(container, "Guest").textContent).toContain("Invited by Dylan");
  });

  it("a team admin manages every guest of the team's shows, up to editor, and revokes any invite", async () => {
    // Dylan is here only through the team, as its admin (show role editor).
    const members = TEAM_SHOW_MEMBERS.map((m) =>
      m.userId === "u-dylan"
        ? { ...m, source: "team" as const, directRole: null, teamRole: "admin" as const }
        : m,
    );
    const ownersInvite: PendingInviteDTO = {
      id: "inv-o",
      email: "someone@test.local",
      role: "editor",
      invitedBy: { id: "u-owner", name: "Owner" },
      createdAt: 0,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      expired: false,
    };
    const { container } = await mount("editor", {
      members,
      team,
      policy: "owner",
      invites: [ownersInvite],
    });
    // Other was added by the owner: a team admin still manages them.
    expect(byLabel(container, "Remove Other")).not.toBeNull();
    expect(options(byLabel(container, "Role for Other"))).toEqual([
      "editor",
      "commenter",
      "viewer",
    ]);
    expect(byLabel(container, "Remove Guest")).not.toBeNull();
    // Never the show's owner, no handover, and team rows stay with the team.
    expect(byLabel(container, "Remove Owner")).toBeNull();
    expect(byLabel(container, "Make Other the owner")).toBeNull();
    expect(row(container, "Crew").querySelector("select, button")).toBeNull();
    // Someone else's invite: Revoke, but no Reissue (no new links past the owner-only policy).
    expect(byLabel(container, "Revoke the invite for someone@test.local")).not.toBeNull();
    expect(byLabel(container, "Reissue the invite for someone@test.local")).toBeNull();

    // Under the normal policy a team admin reissues anyone's invite (up to editor), also one
    // from someone who has left.
    const departed: PendingInviteDTO = {
      ...ownersInvite,
      id: "inv-d",
      email: "departed@test.local",
      role: "commenter",
      invitedBy: null,
    };
    const open = await mount("editor", { members, team, invites: [ownersInvite, departed] });
    for (const email of ["someone@test.local", "departed@test.local"]) {
      expect(byLabel(open.container, `Reissue the invite for ${email}`)).not.toBeNull();
      expect(byLabel(open.container, `Revoke the invite for ${email}`)).not.toBeNull();
    }
  });

  it("people with access through the team are managed in the team", async () => {
    const { container } = await mount("owner", { members: TEAM_SHOW_MEMBERS, team });
    const crew = row(container, "Crew");
    expect(crew.dataset.source).toBe("team");
    expect(crew.textContent).toContain("via Crew");
    expect(crew.querySelector("select, button")).toBeNull();
    expect(crew.querySelector('[data-testid="member-role"]')?.textContent).toBe("editor");
    // The owner manages every direct member.
    expect(byLabel(container, "Role for Other")).not.toBeNull();
    expect(byLabel(container, "Role for Guest")).not.toBeNull();
  });

  it("Remove asks in the row first", async () => {
    const native = vi.spyOn(window, "confirm");
    const remove = vi.spyOn(api, "removeMember").mockResolvedValue({ ok: true });
    const { container } = await mount("owner");
    click(byLabel(container, "Remove Dylan") as HTMLElement);
    expect(dialog()?.textContent).toContain("Remove Dylan from Wilderness?");
    expect(remove).not.toHaveBeenCalled();
    click(buttonIn(dialog() as HTMLElement, "Remove"));
    await wait();
    expect(remove).toHaveBeenCalledWith("show-1", "u-dylan");
    expect(native).not.toHaveBeenCalled();
  });

  it("editors add people unless the policy says only the owner", async () => {
    const { container } = await mount("editor");
    expect(container.querySelector('form[aria-label="Add people"]')).not.toBeNull();
    const ownerOnly = await mount("editor", { policy: "owner" });
    expect(ownerOnly.container.querySelector('form[aria-label="Add people"]')).toBeNull();
  });
});

describe("adding people and pending invites", () => {
  const invite: PendingInviteDTO = {
    id: "inv-1",
    email: "new@test.local",
    role: "commenter",
    invitedBy: { id: "u-dylan", name: "Dylan" },
    createdAt: 0,
    expiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
    expired: false,
  };

  it("an unknown email gets an invite: the result says so and offers the link", async () => {
    const add = vi.spyOn(api, "addShowPeople").mockResolvedValue({
      invited: {
        id: "inv-1",
        email: "new@test.local",
        role: "commenter",
        path: "/invite/tok",
        expiresAt: invite.expiresAt,
      },
      emailed: false,
    });
    const { container } = await mount("editor");
    vi.spyOn(api, "showInvites").mockResolvedValue({ invites: [invite] });
    const form = container.querySelector('form[aria-label="Add people"]') as HTMLFormElement;
    setInputValue(form.querySelector('input[name="email"]') as HTMLInputElement, "new@test.local");
    (form.querySelector('select[name="role"]') as HTMLSelectElement).value = "commenter";
    form.requestSubmit();
    await wait();
    expect(add).toHaveBeenCalledWith("show-1", { email: "new@test.local", role: "commenter" });
    const result = container.querySelector('[data-testid="add-people-result"]') as HTMLElement;
    expect(result.textContent).toContain("Invite created for new@test.local as commenter");
    expect(result.textContent).toContain("Email not sent: copy the link below.");
    // The link is shown once, on the invite's pending row (only now: the server keeps a hash).
    expect(result.querySelector("code")).toBeNull();
    const pending = container.querySelector('[data-testid="pending-invites"]') as HTMLElement;
    expect(pending.textContent).toContain("new@test.local");
    expect(pending.textContent).toContain("Invited by Dylan");
    expect(pending.querySelector("code")?.textContent).toBe(`${window.location.origin}/invite/tok`);
  });

  it("an existing account is added at once", async () => {
    vi.spyOn(api, "addShowPeople").mockResolvedValue({
      added: { ...MEMBERS[1], name: "Sam", email: "sam@test.local" } as MemberDTO,
      emailed: true,
    });
    const changed = vi.fn();
    const { container } = await mount("owner", { onMembersChanged: changed });
    const form = container.querySelector('form[aria-label="Add people"]') as HTMLFormElement;
    setInputValue(form.querySelector('input[name="email"]') as HTMLInputElement, "sam@test.local");
    form.requestSubmit();
    await wait();
    const result = container.querySelector('[data-testid="add-people-result"]') as HTMLElement;
    expect(result.textContent).toContain("Added Sam as editor. Email sent.");
    expect(result.querySelector("code")?.textContent).toBe(
      `${window.location.origin}/shows/show-1`,
    );
    expect(changed).toHaveBeenCalled();
  });

  it("an inviter who can no longer invite that role keeps Revoke but loses Reissue", async () => {
    const reissueOf = (root: HTMLElement) => byLabel(root, "Reissue the invite for new@test.local");
    const revokeOf = (root: HTMLElement) => byLabel(root, "Revoke the invite for new@test.local");
    // Demoted to viewer: the list is still fetched and shows their own invite.
    const demoted = await mount("viewer", { invites: [invite] });
    expect(api.showInvites).toHaveBeenCalledWith("show-1");
    expect(revokeOf(demoted.container)).not.toBeNull();
    expect(reissueOf(demoted.container)).toBeNull();
    // Still an editor, but the owner now invites alone.
    const policy = await mount("editor", { invites: [invite], policy: "owner" });
    expect(revokeOf(policy.container)).not.toBeNull();
    expect(reissueOf(policy.container)).toBeNull();
    // An editor allowed to invite keeps both; so does the owner, whatever the policy.
    const editor = await mount("editor", { invites: [invite] });
    expect(reissueOf(editor.container)).not.toBeNull();
    const owner = await mount("owner", { invites: [invite], policy: "owner" });
    expect(reissueOf(owner.container)).not.toBeNull();
    expect(revokeOf(owner.container)).not.toBeNull();
  });

  it("Revoke asks in the row; Reissue shows the new link", async () => {
    const revoke = vi.spyOn(api, "revokeInvite").mockResolvedValue({ ok: true });
    const reissue = vi.spyOn(api, "reissueInvite").mockResolvedValue({
      id: "inv-2",
      path: "/invite/fresh",
      expiresAt: invite.expiresAt,
      emailed: false,
    });
    const { container } = await mount("editor", { invites: [invite] });
    const pending = container.querySelector('[data-testid="pending-invites"]') as HTMLElement;
    // Listed from the server: no link to copy (only its hash is kept).
    expect(pending.querySelector("code")).toBeNull();

    click(byLabel(pending, "Revoke the invite for new@test.local") as HTMLElement);
    expect(dialog()?.textContent).toContain("Its link stops working");
    expect(revoke).not.toHaveBeenCalled();
    click(buttonIn(dialog() as HTMLElement, "Revoke"));
    await wait();
    expect(revoke).toHaveBeenCalledWith("inv-1");

    vi.spyOn(api, "showInvites").mockResolvedValue({ invites: [{ ...invite, id: "inv-2" }] });
    click(byLabel(pending, "Reissue the invite for new@test.local") as HTMLElement);
    await wait();
    expect(reissue).toHaveBeenCalledWith("inv-1");
    const fresh = container.querySelector('[data-testid="pending-invites"]') as HTMLElement;
    expect(fresh.querySelector("code")?.textContent).toBe(`${window.location.origin}/invite/fresh`);
    expect(fresh.textContent).toContain("Email not sent: copy the link.");
  });
});

describe("the show's team", () => {
  const crew: TeamMemberDTO = {
    userId: "u-crew",
    name: "Crew",
    email: "crew@test.local",
    role: "editor",
    invitedBy: null,
    joinedAt: 0,
    lastActiveAt: null,
  };

  it("the owner moves the show into a team after a confirm that says who gains access", async () => {
    const update = vi
      .spyOn(api, "updateShow")
      .mockResolvedValue({ show: { id: "show-1", name: "Wilderness", currentSession: null } });
    vi.spyOn(api, "teamMembers").mockResolvedValue({
      members: [crew, { ...crew, userId: "u-2" }, { ...crew, userId: "u-3" }],
    });
    const team = (id: string, name: string, role: TeamDTO["role"]): TeamDTO => ({
      id,
      name,
      role,
      invitePolicy: "editors",
      createdAt: 0,
    });
    const { container } = await mount("owner", {
      teams: [team("team-1", "Crew", "owner"), team("team-2", "Watchers", "viewer")],
    });
    const picker = container.querySelector('[data-testid="show-team"] select') as HTMLSelectElement;
    // Only teams where you're an editor or up.
    expect([...picker.options].map((o) => o.textContent)).toEqual(["Personal", "Crew"]);
    act(() => {
      picker.value = "team-1";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await wait();
    expect(dialog()?.querySelector("span")?.textContent).toBe(
      "Move Wilderness into Crew? All 3 members will get access.",
    );
    expect(update).not.toHaveBeenCalled();
    click(buttonIn(dialog() as HTMLElement, "Move"));
    await wait();
    expect(update).toHaveBeenCalledWith("show-1", { teamId: "team-1" });
  });

  it("everyone else just sees the team", async () => {
    const { container } = await mount("editor", { team: { id: "team-1", name: "Crew" } });
    const team = container.querySelector('[data-testid="show-team"]') as HTMLElement;
    expect(team.textContent).toBe("Team: Crew");
    expect(team.querySelector("select")).toBeNull();
  });
});
