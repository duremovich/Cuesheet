// M5b (R24): sign out everywhere closes the account's other browsers' shows; renaming
// yourself and changing the login email through its emailed link (from the e2e build's dev
// outbox); changing the password from the account menu; an admin's one-time reset link.
// Uses its own invited user (never the shared admin: see CLAUDE.md "E2E reliability").
import { type Browser, expect, type Page, test } from "@playwright/test";
import { ADMIN, apiCreateShow, apiLogin, openShow, trackErrors, uniqueName } from "./helpers";

let errors: string[] = [];
const pages: Page[] = [];

test.beforeEach(() => {
  errors = [];
  pages.length = 0;
});

test.afterEach(async () => {
  // A signed-out page's requests answer 401, a wrong current password 400: Chromium logs both.
  expect(
    errors.filter((e) => !/status of 40[01]/.test(e)),
    "console errors",
  ).toEqual([]);
  for (const p of pages) await p.context().close();
});

async function newPage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  pages.push(page);
  trackErrors(page, errors);
  return page;
}

const PASSWORD = "a-long-password";

/** Invite a new user (to `showId` as editor, when given) and accept in a fresh context. */
async function invitedUser(browser: Browser, admin: Page, showId?: string) {
  const email = `${uniqueName("acct").replace(/\s+/g, "-")}@cuesheet.test`;
  const res = await admin.request.post("/api/invites", {
    data: showId ? { email, showId, role: "editor" } : { email },
  });
  expect(res.status()).toBe(200);
  const token = ((await res.json()) as { path: string }).path.split("/").at(-1);
  const page = await newPage(browser);
  const accepted = await page.request.post(`/api/invites/${token}/accept`, {
    data: { name: "Account Tester", password: PASSWORD },
  });
  expect(accepted.status()).toBe(201);
  return { page, email };
}

test("sign out everywhere closes the show in the account's other browser", async ({ browser }) => {
  const admin = await newPage(browser);
  await apiLogin(admin);
  const showId = await apiCreateShow(admin, uniqueName("Everywhere"));
  const { page: a, email } = await invitedUser(browser, admin, showId);
  const b = await newPage(browser);
  await apiLogin(b, email, PASSWORD);
  await openShow(a, showId);
  await openShow(b, showId);
  await expect(b.getByTestId("presence")).toHaveAttribute("data-status", "connected");

  a.once("dialog", (d) => void d.accept());
  await a.getByRole("button", { name: "Account" }).click();
  await a.getByRole("menuitem", { name: "Sign out everywhere" }).click();
  await expect(a).toHaveURL(/\/login/);
  await expect(b.getByTestId("presence")).toHaveAttribute("data-status", "unauthorized");
  await b.reload();
  await expect(b).toHaveURL(/\/login/);
});

test("rename yourself, then change the login email through the emailed link", async ({
  browser,
}) => {
  const admin = await newPage(browser);
  await apiLogin(admin);
  const { page, email } = await invitedUser(browser, admin);
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
  const profile = page.getByTestId("profile");
  await expect(page.getByTestId("profile-email")).toHaveText(email);

  const name = uniqueName("Renamed");
  await profile.getByRole("button", { name: "Rename" }).click();
  await profile.getByLabel("Your name").fill(name);
  await profile.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("profile-name")).toHaveText(name);

  // No email is set up in e2e: the dialog says so plainly, and the change waits.
  const newEmail = `${uniqueName("moved").replace(/\s+/g, "-")}@cuesheet.test`;
  await profile.getByRole("button", { name: "Change…" }).click();
  const dialog = page.getByRole("dialog", { name: "Change login email" });
  await dialog.getByLabel("New email").fill(newEmail);
  await dialog.getByLabel("Current password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Send link" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Email isn't set up");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("pending-email")).toContainText(newEmail);

  // The link from the developer outbox (the e2e build keeps unsent email for admins).
  const box = await admin.request.get(`/api/dev/outbox?to=${encodeURIComponent(newEmail)}`);
  expect(box.status()).toBe(200);
  const { messages } = (await box.json()) as { messages: { text: string }[] };
  const link = /https?:\/\/\S+\/confirm-email\/[A-Za-z0-9_-]+/.exec(
    messages.at(-1)?.text ?? "",
  )?.[0];
  expect(link).toBeTruthy();

  // Opened signed out (another device): the link alone confirms it.
  const phone = await newPage(browser);
  await phone.goto(new URL(link as string).pathname);
  await expect(phone.getByTestId("confirm-email-address")).toHaveText(newEmail);
  await phone.getByRole("button", { name: "Confirm new email" }).click();
  await expect(phone.getByRole("status")).toContainText(`you now sign in with ${newEmail}`);

  // The new address signs in; the old one doesn't (one deliberate failure).
  await apiLogin(phone, newEmail, PASSWORD);
  const stranger = await newPage(browser);
  const old = await stranger.request.post("/api/auth/login", {
    data: { email, password: PASSWORD },
  });
  expect(old.status()).toBe(401);
  await page.reload();
  await expect(page.getByTestId("profile-email")).toHaveText(newEmail);
  await expect(page.getByTestId("pending-email")).toHaveCount(0);
});

test("change the password from the account menu; an admin's reset link", async ({ browser }) => {
  const admin = await newPage(browser);
  await apiLogin(admin);
  const { page, email } = await invitedUser(browser, admin);
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Change password…" }).click();
  const dialog = page.getByRole("dialog", { name: "Change password" });
  await dialog.getByLabel("Current password").fill("not-the-password");
  await dialog.getByLabel("New password", { exact: true }).fill("second-long-password");
  await dialog.getByLabel("Repeat the new password").fill("second-long-password");
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The current password is wrong");
  await dialog.getByLabel("Current password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(dialog.getByRole("status")).toContainText("Password changed");
  await dialog.getByRole("button", { name: "Done" }).click();

  // The admin makes a reset link; the user sets a new password with it.
  await admin.goto("/");
  const card = admin.getByRole("form", { name: "Reset a password" });
  await card.getByLabel("Account to reset").fill(email);
  await card.getByRole("button", { name: "Create reset link" }).click();
  const link = (await admin.getByTestId("reset-link").textContent()) ?? "";
  expect(link).toMatch(/\/reset\/[A-Za-z0-9_-]+$/);
  const other = await newPage(browser);
  await other.goto(link);
  await expect(other.getByTestId("reset-email")).toHaveText(email);
  await other.getByLabel("New password").fill("third-long-password");
  await other.getByLabel("Repeat it").fill("third-long-password");
  await other.getByRole("button", { name: "Set password and sign in" }).click();
  await expect(other.getByRole("heading", { name: "Shows" })).toBeVisible();
  // The earlier session was signed out by the reset.
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  expect(ADMIN.email).not.toBe(email);
});
