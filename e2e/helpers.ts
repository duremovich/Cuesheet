import { expect, type Page } from "@playwright/test";

export const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? "",
  password: process.env.E2E_ADMIN_PASSWORD ?? "",
};

/** Unique per test run so tests can share one server without colliding. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function login(page: Page, email = ADMIN.email, password = ADMIN.password) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Shows" })).toBeVisible();
}

export async function createShow(page: Page, name: string): Promise<string> {
  await page.getByLabel("Show name").fill(name);
  await page.getByRole("button", { name: "New show" }).click();
  await expect(page.getByTestId("show-name")).toHaveText(name);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  if (!id) throw new Error(`no show id in ${page.url()}`);
  return id;
}
