// Surfaces, units and formulas (M3b: R11, R12, S2): the Surfaces tab after import, the
// m / cm / ft-in toggle, typing feet and inches, pixel sizes → PPI, the calculator,
// regions, measurement filters, a color rule on PPI, scene links, show default unit, 390 px.
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { apiCreateShow, apiLogin, importExamples, trackErrors, uniqueName } from "./helpers";

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

async function newPage(browser: Browser, viewport = { width: 1600, height: 1000 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

interface SnapSurface {
  id: string;
  name: string | null;
  channel: string | null;
  parent_id: string | null;
  width: number | null;
  height: number | null;
  pixel_width: number | null;
  pixel_height: number | null;
}

async function surfaces(page: Page, showId: string): Promise<SnapSurface[]> {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { tables: { surfaces: SnapSurface[] } }).tables.surfaces;
}

async function mutate(page: Page, showId: string, ops: unknown[]) {
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "e2e", ops },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function surfaceShow(browser: Browser, viewport?: { width: number; height: number }) {
  const page = await newPage(browser, viewport);
  const showId = await apiCreateShow(page, uniqueName("Surfaces"));
  await importExamples(page, showId, ["Surfaces-Gallery.csv", "Breakdown-Grid view.csv"]);
  await page.goto(`/shows/${showId}/surfaces`);
  await expect(rows(page).first()).toBeVisible();
  return { page, showId };
}

const grid = (page: Page) => page.getByRole("grid", { name: "Surface list" });
const rows = (page: Page) => grid(page).getByTestId("grid-row");
const rowByName = (page: Page, name: string) =>
  rows(page).filter({ has: page.locator('[data-col="name"]').getByText(name, { exact: true }) });
const cellOf = (row: Locator, key: string) => row.locator(`[data-col="${key}"]`);
const panel = (page: Page, name: string) => page.getByRole("dialog", { name });

async function openPanel(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  const d = panel(page, name);
  await expect(d).toBeVisible();
  return d;
}

async function closePanel(page: Page, name: string) {
  await page.keyboard.press("Escape");
  await expect(panel(page, name)).toHaveCount(0);
}

/** Type into a grid cell (typing starts the edit) and commit with Enter. */
async function typeInto(page: Page, cell: Locator, text: string) {
  await cell.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const unitButton = (page: Page, unit: string) =>
  page.getByTestId("unit-toggle").getByRole("button", { name: unit, exact: true });

test("import → 15 surfaces in meters; ft-in toggle; typing 4'6\" stores meters", async ({
  browser,
}) => {
  const { page, showId } = await surfaceShow(browser);
  // Surfaces-Gallery.csv has 16 rows; the last is blank.
  await expect(page.getByTestId("row-count")).toHaveText("15 surfaces");
  const lpro = rowByName(page, "L PRO");
  await expect(cellOf(lpro, "width")).toHaveText("4.50 m");
  await expect(cellOf(lpro, "channel")).toHaveText("CH02");
  await expect(cellOf(rowByName(page, "FULL WALL"), "width")).toHaveText("16.50 m");

  // The toolbar toggle is your unit (this browser): the grid switches, the view doesn't.
  await expect(unitButton(page, "m")).toHaveAttribute("aria-pressed", "true");
  await unitButton(page, "ft-in").click();
  await expect(cellOf(lpro, "width")).toHaveText(`14' 9 1/8"`);
  await expect(cellOf(lpro, "height")).toHaveText(`13' 1 1/2"`);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await unitButton(page, "cm").click();
  await expect(cellOf(lpro, "width")).toHaveText("450.0 cm");
  // Kept across a reload.
  await page.reload();
  await expect(cellOf(rowByName(page, "L PRO"), "width")).toHaveText("450.0 cm");
  await unitButton(page, "m").click();

  // Feet and inches typed into a meters column: stored in meters, shown in m.
  const truss = rowByName(page, "L TRUSS WALL");
  await typeInto(page, cellOf(truss, "width"), `4'6"`);
  await expect(cellOf(truss, "width")).toHaveText("1.37 m");
  await expect
    .poll(async () => (await surfaces(page, showId)).find((s) => s.name === "L TRUSS WALL")?.width)
    .toBeCloseTo(1.3716, 6);
  // Bad input stays in the editor and changes nothing.
  await typeInto(page, cellOf(truss, "height"), "tall");
  await page.keyboard.press("Escape");
  await expect(cellOf(truss, "height")).toHaveText("1.50 m");

  // History shows lengths in the active unit.
  await unitButton(page, "ft-in").click();
  await cellOf(truss, "name").click();
  await page.keyboard.press("Space");
  const rp = page.getByTestId("row-panel");
  await rp.getByRole("tab", { name: "History" }).click();
  await expect(rp.getByTestId("history")).toContainText(`1' 7 5/8" → 4' 6"`);
  await rp.getByRole("button", { name: "Close panel" }).click();

  // A view-level override (Fields → Unit override) wins over your unit; a chip says so.
  const fields = await openPanel(page, "Fields");
  await fields.getByLabel("Unit override").selectOption("cm");
  await closePanel(page, "Fields");
  await expect(page.getByTestId("view-unit-chip")).toHaveText("View unit: cm");
  await expect(cellOf(lpro, "width")).toHaveText("450.0 cm");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("view-unit-chip")).toHaveCount(0);
  await expect(cellOf(lpro, "width")).toHaveText(`14' 9 1/8"`);
});

test("pixel size → PPI, calculator with a PPI lock, regions", async ({ browser }) => {
  const { page, showId } = await surfaceShow(browser);
  const lpro = rowByName(page, "L PRO");
  await typeInto(page, cellOf(lpro, "pixels"), "1920 x 1080");
  await expect(cellOf(lpro, "pixels")).toHaveText("1920×1080");
  // 1920 px over 4.5 m (177.17 in).
  await expect(cellOf(lpro, "ppi")).toHaveText("10.84");
  await expect(cellOf(lpro, "aspect_ratio")).toHaveText("16:9");
  await expect(cellOf(lpro, "pixel_pitch")).toHaveText("2.34");

  // Calculator: lock PPI, widen to 9 m → pixel width doubles; the grid follows.
  await cellOf(lpro, "name").click();
  await page.keyboard.press("Space");
  const rp = page.getByTestId("row-panel");
  await rp.getByRole("tab", { name: "Calculator" }).click();
  const calc = rp.getByTestId("surface-calculator");
  await expect(calc.getByTestId("calc-ppi")).toHaveValue("10.84");
  await calc.getByRole("button", { name: "Keep the PPI fixed" }).click();
  await expect(calc.getByRole("button", { name: "Keep the PPI fixed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const w = calc.getByTestId("calc-width");
  await w.click();
  await w.fill("9 m");
  await w.press("Enter");
  await expect(calc.getByTestId("calc-pixel-width")).toHaveValue("3840");
  await expect(cellOf(lpro, "pixels")).toHaveText("3840×1080");
  await expect(cellOf(lpro, "width")).toHaveText("9.00 m");
  await expect(cellOf(lpro, "ppi")).toHaveText("10.84");
  await expect
    .poll(async () => (await surfaces(page, showId)).find((s) => s.name === "L PRO")?.pixel_width)
    .toBe(3840);

  // Lock the physical size and change PPI: pixels follow.
  await calc.getByRole("button", { name: "Keep the physical size fixed" }).click();
  const ppi = calc.getByTestId("calc-ppi");
  await ppi.click();
  await ppi.fill("20");
  await ppi.press("Enter");
  await expect(calc.getByTestId("calc-pixel-width")).toHaveValue("7087");
  await expect(cellOf(lpro, "ppi")).toHaveText("20");

  // Projector: 9 m throw at 1.5:1 → a 6 m image.
  const t = calc.getByTestId("calc-throw");
  await t.fill("9");
  await t.press("Enter");
  const l = calc.getByTestId("calc-lens");
  await l.fill("1.5");
  await l.press("Enter");
  await expect(calc.getByTestId("calc-image-width")).toHaveText("6.00 m");
  await expect(cellOf(lpro, "throw_width")).toHaveText("6.00 m");

  // A region: parent shown in the grid; its calculator starts with the pixel size locked.
  const top = rowByName(page, "L PRO TOP");
  await expect(cellOf(top, "parent")).toHaveText("L PRO");
  await cellOf(top, "name").click();
  await expect(rp.getByRole("heading", { name: "L PRO TOP" })).toBeVisible();
  const region = rp.getByTestId("calc-region");
  await expect(region).toContainText("Region of L PRO");
  await expect(region).toContainText("50% of the width");
  await expect(rp.getByRole("button", { name: "Keep the pixel size fixed" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("filter width > 4 m, color rule on PPI < 30, show default unit", async ({ browser }) => {
  const { page, showId } = await surfaceShow(browser);
  const all = await surfaces(page, showId);
  const byName = (n: string) => all.find((s) => s.name === n)?.id as string;
  await mutate(page, showId, [
    {
      op: "update",
      table: "surfaces",
      id: byName("C WALL"),
      fields: { pixel_width: 3840, pixel_height: 2160 },
    },
    {
      op: "update",
      table: "surfaces",
      id: byName("FULL WALL"),
      fields: { pixel_width: 1920, pixel_height: 480 },
    },
  ]);

  const f = await openPanel(page, "Filter");
  await f.getByRole("button", { name: "+ Add filter" }).click();
  await f.getByLabel("Filter 1 field").selectOption({ label: "Width" });
  await f.getByLabel("Filter 1 operator").selectOption("gt");
  await f.getByLabel("Filter 1 value").fill("4 m");
  await closePanel(page, "Filter");
  // Everything but the two 0.5 m truss walls.
  await expect(page.getByTestId("row-count")).toHaveText("13 of 15 surfaces");
  await expect(rowByName(page, "L TRUSS WALL")).toHaveCount(0);

  // Color rows with PPI < 30 red: C WALL is 15 PPI, FULL WALL 2.96; the rest have none.
  const color = await openPanel(page, "Color");
  await color.getByRole("button", { name: "+ Add rule" }).click();
  await color.getByLabel("Rule 1 condition 1 field").selectOption({ label: "PPI" });
  await color.getByLabel("Rule 1 condition 1 operator").selectOption("lt");
  await color.getByLabel("Rule 1 condition 1 value").fill("30");
  await color.getByRole("radio", { name: "red" }).click();
  await closePanel(page, "Color");
  await expect(rowByName(page, "C WALL")).toHaveAttribute(
    "style",
    /--row-bg: var\(--option-red-bg\)/,
  );
  await expect(rowByName(page, "L PRO")).not.toHaveAttribute("style", /--row-bg/);
  await expect(cellOf(rowByName(page, "FULL WALL"), "ppi")).toHaveText("2.96");

  // The show's default unit (no view override, no personal preference) → cm everywhere.
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("button", { name: "Show settings" }).click();
  await page.getByLabel("Show default").selectOption("cm");
  await page.keyboard.press("Escape");
  await expect(cellOf(rowByName(page, "C WALL"), "width")).toHaveText("650.0 cm");
  await expect(unitButton(page, "cm")).toHaveAttribute("aria-pressed", "true");
  // Your own preference wins over the show's.
  await page.getByRole("button", { name: "Show settings" }).click();
  await page.getByLabel("My unit").selectOption("ft-in");
  await page.keyboard.press("Escape");
  await expect(cellOf(rowByName(page, "C WALL"), "width")).toHaveText(`21' 3 7/8"`);
});

test("scenes ↔ surfaces link chips; parent/child cycles refused", async ({ browser }) => {
  const { page, showId } = await surfaceShow(browser);
  await page.getByRole("link", { name: "Scenes", exact: true }).click();
  const scenes = page.getByRole("grid", { name: "Scene list" });
  const overture = scenes
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText("100", { exact: true }) });
  const cell = overture.locator('[data-col="surfaces"]');
  await cell.click();
  await page.keyboard.type("C WALL");
  const picker = page.getByTestId("record-picker");
  await picker.getByRole("option", { name: /^C WALL/ }).click();
  await page.keyboard.press("Escape");
  await expect(cell).toContainText("C WALL");

  await page.getByRole("link", { name: "Surfaces", exact: true }).click();
  await expect(cellOf(rowByName(page, "C WALL"), "scenes")).toContainText("100 Overture");

  // Making L PRO a region of its own region is refused (picker doesn't offer it; the API 400s).
  const all = await surfaces(page, showId);
  const lpro = all.find((s) => s.name === "L PRO")?.id;
  const top = all.find((s) => s.name === "L PRO TOP")?.id;
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [{ op: "update", table: "surfaces", id: lpro, fields: { parent_id: top } }],
    },
  });
  expect(res.status()).toBe(400);
  await cellOf(rowByName(page, "L PRO"), "parent").click();
  await page.keyboard.type("L PRO");
  await expect(picker.getByRole("option", { name: /^L PRO TOP/ })).toHaveCount(0);
  await expect(picker.getByRole("option", { name: /^R PRO TOP/ })).toHaveCount(0);
  await expect(picker.getByRole("option", { name: /^FULL PRO/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("surfaces at 390px: grid and calculator fit", async ({ browser }) => {
  const { page } = await surfaceShow(browser, { width: 390, height: 844 });
  await expect(page.getByTestId("row-count")).toHaveText("15 surfaces");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const lpro = rowByName(page, "L PRO");
  await cellOf(lpro, "name").click();
  await page.keyboard.press("Space");
  const rp = page.getByTestId("row-panel");
  await rp.getByRole("tab", { name: "Calculator" }).click();
  const calc = rp.getByTestId("surface-calculator");
  await expect(calc.getByTestId("calc-width")).toBeVisible();
  for (const id of ["calc-width", "calc-height", "calc-pixel-width", "calc-ppi"]) {
    const box = await calc.getByTestId(id).boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  }
  const unit = rp.getByRole("button", { name: "ft-in", exact: true });
  await unit.click();
  await expect(calc.getByTestId("calc-width")).toHaveValue(`14' 9 1/8"`);
});
