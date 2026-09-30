// Shot lists (M5a: R14): make a list, add shots with ghost numbers, group them, drag across
// groups, the "Shot list" print preset, and the tab at 390 px.
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { apiCreateShow, apiLogin, trackErrors, uniqueName } from "./helpers";

let errors: string[] = [];
const pages: Page[] = [];

test.beforeEach(() => {
  errors = [];
  pages.length = 0;
});

test.afterEach(async () => {
  expect(errors, "console errors").toEqual([]);
  for (const p of pages) await p.context().close();
});

async function newPage(browser: Browser, viewport = { width: 1500, height: 1000 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

const grid = (page: Page) => page.getByRole("grid", { name: "Shot list" });
const rows = (page: Page) => grid(page).getByTestId("grid-row");
const cellOf = (row: Locator, key: string) => row.locator(`[data-col="${key}"]`);
const rowByShot = (page: Page, n: string) =>
  rows(page).filter({ has: page.locator('[data-col="number"]').getByText(n, { exact: true }) });

interface SnapShot {
  id: string;
  number: string | null;
  group: string | null;
  shot_list_id: string;
}

async function serverShots(page: Page, showId: string): Promise<SnapShot[]> {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  return ((await res.json()) as { tables: { shots: SnapShot[] } }).tables.shots;
}

async function newList(page: Page, name: string) {
  page.once("dialog", (d) => void d.accept(name));
  await page.getByRole("button", { name: "+ New list" }).click();
  await expect(page.getByLabel("Current shot list")).toHaveValue(/.+/);
  await expect(
    page.getByLabel("Current shot list").locator("option:checked"),
  ).toHaveText(name);
}

test("shots: a list, ghost numbers, groups, drag across groups, print preset", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Shots"));
  await page.goto(`/shows/${showId}/shots`);
  await expect(page.getByTestId("shot-empty")).toContainText("No shot lists yet");
  await newList(page, "Day 1");
  await expect(page.getByTestId("shot-empty")).toContainText("No shots in this list yet");

  // First shot: the ghost suggests 1; Tab accepts it.
  await page.getByRole("button", { name: "+ Add shot" }).click();
  const first = rows(page).first();
  await expect(cellOf(first, "number").getByTestId("ghost")).toHaveText("1");
  await page.keyboard.press("Tab");
  await expect(cellOf(first, "number")).toHaveText("1");
  await page.keyboard.type("Car");
  await page.keyboard.press("Enter");
  await expect(cellOf(first, "group")).toHaveText("Car");

  // Second and third: ghosts 2 and 3, in group Car then Street.
  await page.getByRole("button", { name: "+ Add shot" }).click();
  await expect(rows(page)).toHaveCount(2);
  const second = rows(page).nth(1);
  await expect(cellOf(second, "number").getByTestId("ghost")).toHaveText("2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Street");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "+ Add shot" }).click();
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Street");
  await page.keyboard.press("Enter");
  // A duplicate number warns (never blocks).
  await expect(cellOf(rowByShot(page, "2").first(), "number")).toContainText("Duplicate of shot 2");

  // Grouped by `group` (the default view).
  const headers = grid(page).getByTestId("group-header");
  await expect(headers.filter({ hasText: "Car" })).toBeVisible();
  await expect(headers.filter({ hasText: "Street" })).toBeVisible();
  await expect
    .poll(async () => (await serverShots(page, showId)).map((s) => [s.number, s.group]))
    .toEqual([
      ["1", "Car"],
      ["2", "Street"],
      ["2", "Street"],
    ]);

  // Drag the last shot up into Car (below shot 1): its group follows.
  const source = rows(page).nth(2);
  await source.hover();
  const handle = await source.getByTestId("drag-handle").boundingBox();
  const target = await rowByShot(page, "1").boundingBox();
  if (!handle || !target) throw new Error("no boxes");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 10, target.y + target.height - 6, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => (await serverShots(page, showId)).map((s) => [s.number, s.group]))
    .toEqual([
      ["1", "Car"],
      ["2", "Car"],
      ["2", "Street"],
    ]);

  // The "Shot list" preset (a personal view) → Print shows it by group.
  await page.getByTestId("view-switcher").click();
  await page.getByRole("dialog", { name: "Views" }).getByRole("button", { name: "+ Shot list" }).click();
  await expect(page.getByTestId("current-view")).toHaveText("Shot list");
  await expect(grid(page).getByRole("columnheader", { name: "Camera" })).toHaveCount(0);
  await page.getByTestId("print-view-link").click();
  await expect(page.getByTestId("print-view")).toBeVisible();
  await expect(page.getByTestId("print-group")).toHaveCount(2);
  await expect(page.getByTestId("print-view")).toContainText("Shots: Day 1");
  await expect(page.getByTestId("print-view")).toContainText("Shot list");
  await expect(page.getByTestId("print-group").first()).toContainText("Car");
});

test("shot lists: rename, a second list, delete; the tab at 390 px", async ({ browser }) => {
  const page = await newPage(browser, { width: 390, height: 844 });
  const showId = await apiCreateShow(page, uniqueName("Phone shots"));
  await page.goto(`/shows/${showId}/shots`);
  await newList(page, "Day 1");
  await page.getByRole("button", { name: "+ Add shot" }).click();
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  page.once("dialog", (d) => void d.accept("Pickups"));
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByLabel("Current shot list").locator("option:checked")).toHaveText(
    "Pickups",
  );
  await newList(page, "Day 2");
  await expect(page.getByTestId("shot-empty")).toContainText("No shots in this list yet");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const bar = await page.getByTestId("shot-list-bar").boundingBox();
  expect(bar && bar.x + bar.width <= 390).toBe(true);

  // Deleting the first list deletes its shot.
  await page.getByLabel("Current shot list").selectOption({ label: "Pickups" });
  await expect(rows(page)).toHaveCount(1);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Delete list" }).click();
  await expect.poll(async () => (await serverShots(page, showId)).length).toBe(0);
  await expect(page.getByLabel("Current shot list").locator("option:checked")).toHaveText(
    "Day 2",
  );
});
