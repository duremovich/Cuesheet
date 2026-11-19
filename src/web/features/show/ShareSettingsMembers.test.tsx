// Show settings → Members: the owner's "Make owner" asks in-row (never a native dialog),
// and only a confirmed handover calls the API.
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberDTO, Role } from "../../../shared/api";
import { api } from "../../lib/api";
import { AuthProvider } from "../../lib/auth";
import { click, press, render, wait } from "../../test/dom";
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

function mount(role: Role, onMembersChanged = () => undefined) {
  vi.spyOn(api, "me").mockResolvedValue({ user: null });
  return render(
    <AuthProvider>
      <MemoryRouter>
        <WorkspaceContext value={workspace(role)}>
          <MembersSection members={MEMBERS} onMembersChanged={onMembersChanged} />
        </WorkspaceContext>
      </MemoryRouter>
    </AuthProvider>,
  );
}

const makeOwnerButton = (root: HTMLElement) =>
  root.querySelector('[aria-label="Make Dylan the owner"]') as HTMLButtonElement | null;
const dialog = () => document.querySelector('[role="alertdialog"]') as HTMLElement | null;
const buttonIn = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;

afterEach(() => vi.restoreAllMocks());

describe("Make owner", () => {
  it("confirms in the row, then transfers and refreshes the list", async () => {
    const native = vi.spyOn(window, "confirm");
    const transfer = vi.spyOn(api, "transferOwnership").mockResolvedValue({ ok: true });
    const changed = vi.fn();
    const { container } = mount("owner", changed);
    // The owner's own row has no actions.
    expect(container.querySelector('[aria-label="Make Owner the owner"]')).toBeNull();

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

  it("Cancel and Escape leave everything as it was", () => {
    const transfer = vi.spyOn(api, "transferOwnership").mockResolvedValue({ ok: true });
    const { container } = mount("owner");
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
    const { container } = mount("owner");
    click(makeOwnerButton(container) as HTMLButtonElement);
    click(buttonIn(dialog() as HTMLElement, "Make owner"));
    await wait();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Not a member of this show",
    );
  });

  it("isn't offered to non-owners", () => {
    const { container } = mount("editor");
    expect(makeOwnerButton(container)).toBeNull();
  });
});
