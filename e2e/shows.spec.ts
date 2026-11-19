import { expect, test } from "@playwright/test";
import { ADMIN, createShow, login, openShow, uniqueName, waitForShowReady } from "./helpers";

test("sign in, create a show, and see live presence from two browsers", async ({ browser }) => {
  const alice = await browser.newContext();
  const page = await alice.newPage();

  await login(page);
  const name = uniqueName("Some Like It Hot");
  const showId = await createShow(page, name);

  // The empty cue list page: header, presence, empty cue list.
  await expect(page.getByTestId("cue-list")).toContainText("No cues yet.");
  const presence = page.getByTestId("presence");
  await expect(presence).toHaveAttribute("data-status", "connected");
  await expect(page.getByTestId("presence-count")).toHaveText("1 online");

  // The show is in the list.
  await page.getByRole("link", { name: "Cuesheet" }).click();
  await expect(page.getByTestId("show-list")).toContainText(name);
  await page.getByRole("link", { name }).click();
  await waitForShowReady(page);
  // The count comes from the server's presence broadcast; the old socket's close may
  // land after the new one's hello (briefly 2 connections), so wait for the settled value.
  await expect(presence).toHaveAttribute("data-clients", "1");

  // A second browser context (separate cookies) on the same show.
  const bob = await browser.newContext();
  const page2 = await bob.newPage();
  await login(page2);
  await openShow(page2, showId);
  // Two connections, but one account (both sign in as the admin): one person.
  await expect(page2.getByTestId("presence")).toHaveAttribute("data-clients", "2");
  await expect(presence).toHaveAttribute("data-clients", "2");
  await expect(page.getByTestId("presence-count")).toHaveText("1 online");

  // Closing the second one drops the count back.
  await bob.close();
  await expect(presence).toHaveAttribute("data-clients", "1");
  await alice.close();
});

test("signing out in one browser leaves the same user's other browsers live", async ({
  browser,
}) => {
  const laptop = await (await browser.newContext()).newPage();
  await login(laptop);
  const showId = await createShow(laptop, uniqueName("Two devices"));
  const phone = await (await browser.newContext()).newPage();
  await login(phone);
  await openShow(phone, showId);
  await expect(laptop.getByTestId("presence")).toHaveAttribute("data-clients", "2");

  // The phone signs out: only its own socket is revoked.
  await phone.getByRole("button", { name: "Sign out" }).click();
  await expect(phone).toHaveURL(/\/login/);
  await expect(laptop.getByTestId("presence")).toHaveAttribute("data-clients", "1");
  await expect(laptop.getByTestId("presence")).toHaveAttribute("data-status", "connected");
  await laptop.context().close();
  await phone.context().close();
});

test("signed-out users are sent to /login and returned afterwards", async ({ page }) => {
  await page.goto("/shows/some-show");
  await expect(page).toHaveURL(/\/login\?next=%2Fshows%2Fsome-show$/);

  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong email or password");

  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/shows\/some-show$/);
  await expect(page.getByText("Show not found")).toBeVisible();
});

test("sign out ends the session", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  expect(await (await page.request.get("/api/me")).json()).toEqual({ user: null });
});
