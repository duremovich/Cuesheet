import { expect, test } from "@playwright/test";
import { ADMIN, createShow, login, uniqueName } from "./helpers";

test("sign in, create a show, and see live presence from two browsers", async ({ browser }) => {
  const alice = await browser.newContext();
  const page = await alice.newPage();

  await login(page);
  const name = uniqueName("Some Like It Hot");
  const showId = await createShow(page, name);

  // The empty cue list page: header, presence, grid placeholder.
  await expect(page.getByTestId("cue-grid-placeholder")).toBeVisible();
  const presence = page.getByTestId("presence");
  await expect(presence).toHaveAttribute("data-status", "connected");
  await expect(page.getByTestId("presence-count")).toHaveText("1 client");

  // The show is in the list.
  await page.getByRole("link", { name: "Cuesheet" }).click();
  await expect(page.getByTestId("show-list")).toContainText(name);
  await page.getByRole("link", { name }).click();
  await expect(page.getByTestId("presence-count")).toHaveText("1 client");

  // A second browser context (separate cookies) on the same show.
  const bob = await browser.newContext();
  const page2 = await bob.newPage();
  await login(page2);
  await page2.goto(`/shows/${showId}`);
  await expect(page2.getByTestId("presence-count")).toHaveText("2 clients");
  await expect(page.getByTestId("presence-count")).toHaveText("2 clients");

  // Closing the second one drops the count back.
  await bob.close();
  await expect(page.getByTestId("presence-count")).toHaveText("1 client");
  await alice.close();
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
