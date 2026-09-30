import { expect, test } from "@playwright/test";
import { createShow, login, uniqueName } from "./helpers";

test("admin invites a teammate who accepts, signs in, and can't see others' shows", async ({
  browser,
}) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin);
  const privateShow = uniqueName("Admin only");
  await createShow(admin, privateShow);
  await admin.getByRole("link", { name: "Cuesheet" }).click();

  const email = `${uniqueName("sm").replace(/\s+/g, "-")}@cuesheet.test`;
  await admin.getByRole("textbox", { name: "Email" }).fill(email);
  await admin.getByRole("button", { name: "Create invite link" }).click();
  const link = (await admin.getByTestId("invite-link").textContent()) ?? "";
  expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);

  const newCtx = await browser.newContext();
  const page = await newCtx.newPage();
  await page.goto(link);
  await expect(page.getByTestId("invite-email")).toHaveText(email.toLowerCase());
  await page.getByLabel("Your name").fill("Stage Manager");
  await page.getByLabel("Password").fill("a-long-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Shows" })).toBeVisible();
  await expect(page.getByTestId("current-user")).toHaveText("Stage Manager");
  await expect(page.getByText("No shows yet")).toBeVisible();
  await expect(page.getByText(privateShow)).toHaveCount(0);
  // Non-admins don't get the invite form.
  await expect(page.getByRole("heading", { name: "Invite a teammate" })).toHaveCount(0);

  // The link is single-use.
  const again = await (await browser.newContext()).newPage();
  await again.goto(link);
  await expect(again.getByRole("alert")).toContainText("invalid or has already been used");

  await adminCtx.close();
  await newCtx.close();
});
