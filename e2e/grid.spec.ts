// The DataGrid on its dev page (/dev/grid), which runs against an in-memory copy of the
// Some Like It Hot cue list. The e2e build includes the page (VITE_DEV_PAGES=1).
import { expect, type Locator, type Page, test } from "@playwright/test";

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/dev/grid");
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

const grid = (page: Page) => page.getByRole("grid", { name: "Cue list" });
const rowByCue = (page: Page, cue: string) =>
  grid(page)
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText(cue, { exact: true }) });
const cellOf = (row: Locator, key: string) => row.locator(`[data-col="${key}"]`);
const rowIndex = async (row: Locator) => Number(await row.getAttribute("aria-rowindex"));

async function ungroup(page: Page) {
  await page.getByLabel("Group by scene").uncheck();
  await expect(grid(page).getByTestId("group-header")).toHaveCount(0);
}

test("typing into a cell and Enter commits the edit and moves down", async ({ page }) => {
  await ungroup(page);
  const row = rowByCue(page, "2.00");
  await cellOf(row, "lx").click();
  await page.keyboard.type("LX 5");
  await expect(cellOf(row, "lx").getByRole("textbox")).toHaveValue("LX 5");
  await page.keyboard.press("Enter");
  await expect(cellOf(row, "lx")).toHaveText("LX 5");
  await expect(page.getByTestId("grid-log")).toHaveText("Edited 2.00 · lx");
  // Focus moved to the same column one row down.
  const next = rowByCue(page, "2.10");
  await expect(cellOf(next, "lx")).toBeFocused();
  // Undo restores the old (empty) value.
  await page.keyboard.press("Control+z");
  await expect(cellOf(row, "lx")).toHaveText("");
});

test("an inserted row stays where it was inserted under a live sort until focus leaves it", async ({
  page,
}) => {
  await ungroup(page);
  await page.getByLabel("Live sort by cue number").check();
  const anchor = rowByCue(page, "2.00");
  await cellOf(anchor, "number").click();
  await page.keyboard.press("Control+Shift+Enter");
  await expect(page.getByTestId("grid-log")).toHaveText("Inserted a row");

  // The new row is right below 2.00, with its cue number focused.
  const at = await rowIndex(anchor);
  const fresh = grid(page).locator(`[role="row"][aria-rowindex="${at + 1}"]`);
  await expect(cellOf(fresh, "number")).toBeFocused();
  await expect(cellOf(fresh, "number")).toHaveText("");

  // Give it a number that sorts far away; Tab stays in the row, so it holds its place.
  await page.keyboard.type("65");
  await page.keyboard.press("Tab");
  await expect(cellOf(fresh, "number")).toHaveText("65");
  await expect(rowByCue(page, "65")).toHaveAttribute("aria-rowindex", String(at + 1));

  // Leaving the row (Escape) lets it slide to its sorted place.
  await page.keyboard.press("Escape");
  await expect(rowByCue(page, "2.10")).toHaveAttribute("aria-rowindex", String(at + 1));
  const moved = rowByCue(page, "65");
  await moved.scrollIntoViewIfNeeded();
  expect(await rowIndex(moved)).toBeGreaterThan(at + 50);
  await expect(rowByCue(page, "60.00")).toHaveAttribute(
    "aria-rowindex",
    String((await rowIndex(moved)) - 1),
  );
});

test("dragging a row by its handle reorders it", async ({ page }) => {
  await ungroup(page);
  const numbers = () =>
    grid(page).locator('[data-testid="grid-row"] [data-col="number"]').allInnerTexts();
  expect((await numbers()).slice(0, 4)).toEqual(["0.10", "0.30", "0.80", "0.90"]);

  const source = rowByCue(page, "0.30");
  await source.hover();
  const handle = await source.getByTestId("drag-handle").boundingBox();
  const target = await rowByCue(page, "0.90").boundingBox();
  if (!handle || !target) throw new Error("no boxes");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 10, target.y + target.height - 6, { steps: 12 });
  await expect(grid(page).getByTestId("drop-line")).toBeVisible();
  await page.mouse.up();

  await expect(page.getByTestId("grid-log")).toHaveText("Moved 0.30");
  expect((await numbers()).slice(0, 4)).toEqual(["0.10", "0.80", "0.90", "0.30"]);
});

test("dragging a row into another group re-links its scene", async ({ page }) => {
  await grid(page).getByRole("button", { name: "Collapse Unassigned" }).click();
  const source = rowByCue(page, "2.00");
  await expect(cellOf(source, "scene")).toHaveText("100 Overture");
  await source.hover();
  const handle = await source.getByTestId("drag-handle").boundingBox();
  const target = await rowByCue(page, "5.00").boundingBox();
  if (!handle || !target) throw new Error("no boxes");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 10, target.y + target.height - 6, { steps: 12 });
  await page.mouse.up();

  await expect(page.getByTestId("grid-log")).toHaveText("Moved 2.00");
  await expect(cellOf(source, "scene")).toHaveText("102 Scene Two: The Street");
  const five = await rowIndex(rowByCue(page, "5.00"));
  await expect(source).toHaveAttribute("aria-rowindex", String(five + 1));
});

test("dragging is disabled under a live sort, with a hint", async ({ page }) => {
  await page.getByLabel("Live sort by cue number").check();
  const row = rowByCue(page, "0.30");
  await row.hover();
  const handle = row.getByTestId("drag-handle");
  await expect(handle).toHaveAttribute("aria-disabled", "true");
  await handle.click({ force: true }); // it's aria-disabled; press it anyway
  await expect(grid(page).getByRole("status")).toContainText("live sort");
});

test("the content picker links existing content and creates new content", async ({ page }) => {
  const row = rowByCue(page, "2.10");
  const content = cellOf(row, "content");
  await content.click();
  await page.keyboard.type("vamp");
  const picker = page.getByTestId("record-picker");
  await expect(picker.getByRole("option", { name: /105-001-VAMP/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(content).toContainText("105-001-VAMP");

  // Still open (multi-link): type a new name and create it.
  await page.keyboard.type("999-001-NEWLOOK");
  const create = picker.getByRole("option", { name: "Create “999-001-NEWLOOK”" });
  await expect(create).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(content).toContainText("999-001-NEWLOOK");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(content).toBeFocused();

  // The new record is searchable from another row, and recent picks come first.
  await cellOf(rowByCue(page, "2.20"), "content").click();
  await page.keyboard.type("9");
  await expect(picker.getByRole("option").first()).toContainText("999-001-NEWLOOK");
  await page.keyboard.press("Escape");
});

test("group headers collapse and expand, and stay stuck while scrolling", async ({ page }) => {
  // Unassigned comes first; fold it away to bring scene 100 into view.
  await expect(rowByCue(page, "0.10")).toBeVisible();
  await grid(page).getByRole("button", { name: "Collapse Unassigned" }).click();
  await expect(rowByCue(page, "0.10")).toHaveCount(0);
  const header = grid(page).getByTestId("group-header").filter({ hasText: "100 Overture" });
  await expect(rowByCue(page, "2.00")).toBeVisible();
  await header.getByRole("button", { name: "Collapse 100 Overture" }).click();
  await expect(rowByCue(page, "2.00")).toHaveCount(0);
  await expect(header.getByRole("button", { name: "Expand 100 Overture" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await header.getByRole("button", { name: "Expand 100 Overture" }).click();
  await expect(rowByCue(page, "2.00")).toBeVisible();

  // Scroll into the middle of the list: the current group's header sits under the column header.
  const scroller = page.getByTestId("grid-scroll");
  await scroller.evaluate((el) => {
    el.scrollTop = 3000;
  });
  const top = await scroller.boundingBox();
  const stuck = grid(page).getByTestId("group-header").first();
  await expect
    .poll(async () => Math.round(((await stuck.boundingBox())?.y ?? 0) - (top?.y ?? 0)))
    .toBeLessThanOrEqual(40);
});

test("5,000 rows scroll smoothly to the last row", async ({ page }) => {
  await page.getByLabel("5,000 rows").check();
  await ungroup(page);
  const rendered = await grid(page).getByTestId("grid-row").count();
  expect(rendered).toBeLessThan(200); // virtualized

  const scroller = page.getByTestId("grid-scroll");
  const elapsed = await scroller.evaluate(async (el) => {
    const t0 = performance.now();
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 1; i <= 40; i++) {
      el.scrollTop = (el.scrollHeight * i) / 40;
      await frame();
    }
    return performance.now() - t0;
  });
  expect(elapsed).toBeLessThan(4000);
  await expect(rowByCue(page, "5000")).toBeVisible();
  await expect(rowByCue(page, "5000")).toHaveAttribute("aria-rowindex", "5001");
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the page doesn't scroll sideways; the grid does, with the first column frozen", async ({
    page,
  }) => {
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scroll).toBeLessThanOrEqual(client);

    const scroller = page.getByTestId("grid-scroll");
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const cue = cellOf(rowByCue(page, "0.10"), "number");
    const before = await cue.boundingBox();
    await scroller.evaluate((el) => {
      el.scrollLeft = 500;
    });
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(400);
    const after = await cue.boundingBox();
    expect(after?.x).toBe(before?.x);
  });
});
