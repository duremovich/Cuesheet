import { expect, type Locator, test } from "@playwright/test";
import { createShow, login, uniqueName } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no box");
  return b;
}

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function noHorizontalScroll(page: import("@playwright/test").Page) {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(client);
}

test("show page header works at 390×844", async ({ page }) => {
  await login(page);
  await createShow(page, uniqueName("Some Like It Hot: The Musical, Olney Theatre Center"));
  await expect(page.getByTestId("presence")).toHaveAttribute("data-status", "connected");

  const title = await box(page.getByTestId("show-name"));
  const toggle = await box(page.getByTestId("theme-toggle"));
  const presence = await box(page.getByTestId("presence"));
  expect(title.width).toBeGreaterThan(0);
  expect(intersects(title, toggle)).toBe(false);
  expect(intersects(presence, toggle)).toBe(false);
  expect(intersects(title, presence)).toBe(false);
  await expect(page.getByTestId("current-user")).toBeHidden();
  await noHorizontalScroll(page);
});

test("long unbroken show names ellipsize in the shows list at 390px", async ({ page }) => {
  await login(page);
  const name = uniqueName(`Supercalifragilistic${"x".repeat(80)}`);
  await createShow(page, name);
  await page.getByRole("link", { name: "Cuesheet" }).click();

  const item = page.getByTestId("show-list").getByRole("link", { name });
  await expect(item).toBeVisible();
  const nameSpan = item.getByText(name);
  const truncated = await nameSpan.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(truncated).toBe(true);
  const itemBox = await box(item);
  expect(intersects(await box(nameSpan), await box(item.getByText("owner")))).toBe(false);
  expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(390);
  await noHorizontalScroll(page);
});
