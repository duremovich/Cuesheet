// The Account page's profile: rename in place, change the login email through a dialog
// (sent, or told plainly that it wasn't), and a pending change with Resend / Cancel.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeEmailResponse } from "../../shared/account";
import type { MyAccessResponse, UserDTO } from "../../shared/api";
import { api } from "../lib/api";
import { AuthProvider, RequireAuth } from "../lib/auth";
import { click, render, setInputValue, wait } from "../test/dom";
import { AccountPage } from "./AccountPage";

const ME: UserDTO = { id: "u-me", email: "me@test.local", name: "Me", isAdmin: false };
const PENDING = { email: "new@test.local", expiresAt: Date.now() + 20 * 60 * 60 * 1000 };

function access(pendingEmail: MyAccessResponse["pendingEmail"] = null): MyAccessResponse {
  return { teams: [], shows: [], pendingEmail };
}

async function mount(first: MyAccessResponse = access()) {
  vi.spyOn(api, "me").mockResolvedValue({ user: ME });
  const myAccess = vi.spyOn(api, "myAccess").mockResolvedValue(first);
  const r = render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route
            path="/account"
            element={<RequireAuth>{(user) => <AccountPage user={user} />}</RequireAuth>}
          />
          <Route path="/login" element={<p>sign in</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
  await wait();
  return { ...r, myAccess };
}

const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
const input = (root: ParentNode, selector: string) =>
  root.querySelector(selector) as HTMLInputElement;
const testId = (root: ParentNode, id: string) =>
  root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function submit(form: Element | null) {
  act(() => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => vi.restoreAllMocks());

describe("account page: profile", () => {
  it("renames you in place", async () => {
    const { container } = await mount();
    expect(testId(container, "profile-name")?.textContent).toBe("Me");
    expect(testId(container, "profile-email")?.textContent).toBe("me@test.local");
    const update = vi
      .spyOn(api, "updateProfile")
      .mockResolvedValue({ user: { ...ME, name: "New Me" } });
    click(button(container, "Rename") as HTMLButtonElement);
    setInputValue(input(container, 'input[aria-label="Your name"]'), "  New Me ");
    submit(container.querySelector('form[aria-label="Rename yourself"]'));
    await wait();
    expect(update).toHaveBeenCalledWith("New Me");
    expect(testId(container, "profile-name")?.textContent).toBe("New Me");
    expect(container.querySelector('form[aria-label="Rename yourself"]')).toBeNull();
  });

  it("change email: the dialog sends the link; the pending change shows with Resend / Cancel", async () => {
    const { container, myAccess } = await mount();
    expect(testId(container, "pending-email")).toBeNull();
    expect(button(container, "Resend")).toBeUndefined();
    const sent: ChangeEmailResponse = { pending: PENDING, emailed: true };
    const request = vi.spyOn(api, "requestEmailChange").mockResolvedValue(sent);
    myAccess.mockResolvedValue(access(PENDING));

    click(button(container, "Change…") as HTMLButtonElement);
    const dialog = document.querySelector('[role="dialog"][aria-label="Change login email"]');
    expect(dialog).not.toBeNull();
    setInputValue(input(document, 'input[name="email"]'), "new@test.local");
    setInputValue(input(document, 'input[name="current"]'), "my-password");
    submit(dialog?.querySelector("form") ?? null);
    await wait();
    expect(request).toHaveBeenCalledWith({
      newEmail: "new@test.local",
      currentPassword: "my-password",
    });
    expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain(
      "new@test.local",
    );
    click(button(document, "Done") as HTMLButtonElement);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    expect(testId(container, "pending-email")?.textContent).toContain("new@test.local");
    expect(testId(container, "email-notice")?.textContent).toBe(
      "Confirmation sent to new@test.local.",
    );
    // The login itself hasn't changed.
    expect(testId(container, "profile-email")?.textContent).toBe("me@test.local");

    // Resend says whether it went out.
    vi.spyOn(api, "resendEmailChange").mockResolvedValue({
      pending: PENDING,
      emailed: false,
      message: "Email isn't set up on this Cuesheet, so no confirmation was sent.",
    });
    click(button(container, "Resend") as HTMLButtonElement);
    await wait();
    const notice = testId(container, "email-notice");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toContain("isn't set up");

    // Cancel asks first (in-row), then revokes.
    const cancel = vi.spyOn(api, "cancelEmailChange").mockResolvedValue({ ok: true });
    myAccess.mockResolvedValue(access());
    click(button(container, "Cancel change") as HTMLButtonElement);
    expect(cancel).not.toHaveBeenCalled();
    click(button(container, "Cancel the change") as HTMLButtonElement);
    await wait();
    expect(cancel).toHaveBeenCalled();
    expect(testId(container, "pending-email")).toBeNull();
    expect(testId(container, "email-notice")).toBeNull();
  });

  it("change email: a refused request stays in the dialog with the server's reason", async () => {
    const { container } = await mount();
    vi.spyOn(api, "requestEmailChange").mockRejectedValue(
      new Error("The current password is wrong"),
    );
    click(button(container, "Change…") as HTMLButtonElement);
    setInputValue(input(document, 'input[name="email"]'), "new@test.local");
    setInputValue(input(document, 'input[name="current"]'), "nope");
    submit(document.querySelector('[role="dialog"] form'));
    await wait();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "The current password is wrong",
    );
    expect(document.querySelector('[role="dialog"] form')).not.toBeNull();
  });

  it("sign out everywhere asks in-row, then ends every session", async () => {
    const { container } = await mount();
    const logoutAll = vi.spyOn(api, "logoutAll").mockResolvedValue({ ok: true });
    click(button(container, "Sign out everywhere…") as HTMLButtonElement);
    expect(logoutAll).not.toHaveBeenCalled();
    click(button(container, "Sign out everywhere") as HTMLButtonElement);
    await wait();
    expect(logoutAll).toHaveBeenCalled();
    expect(container.textContent).toBe("sign in");
  });
});
