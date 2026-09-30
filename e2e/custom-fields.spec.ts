// Custom fields and custom tables (M5a: R9): a select field on Cues (column, edit, filter,
// color, reload), a formula field on Surfaces reading PPI, a custom table with URL and
// sensitive fields (masked, reveal, not exported), the Network CSV imported into a custom
// table through the import preview, and the Fields manager at 390 px.
import { readFileSync } from "node:fs";
import path from "node:path";
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

async function newPage(browser: Browser, viewport = { width: 1500, height: 1000 }) {
  const page = await (await browser.newContext({ viewport, acceptDownloads: true })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

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

/** Fields → + Add field → name, type (and what `fill` sets) → Add field. */
async function addField(
  page: Page,
  name: string,
  type: string,
  fill?: (form: Locator) => Promise<void>,
) {
  const fields = await openPanel(page, "Fields");
  await fields.getByRole("button", { name: "+ Add field" }).click();
  const form = fields.getByTestId("field-form");
  await form.getByLabel("Field name").fill(name);
  await form.getByLabel("Type").selectOption({ label: type });
  if (fill) await fill(form);
  await form.getByRole("button", { name: "Add field" }).click();
  await expect(fields.getByTestId("custom-field").filter({ hasText: name })).toBeVisible();
  await closePanel(page, "Fields");
}

test("a select custom field on Cues: column, edit, filter, color, reload", async ({ browser }) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Custom"));
  await importExamples(page, showId);
  await page.goto(`/shows/${showId}/cues`);
  const grid = page.getByRole("grid", { name: "Cue list" });
  const rows = grid.getByTestId("grid-row");
  await expect(rows.first()).toBeVisible();

  await addField(page, "Camera", "Single select", async (form) => {
    await form.getByRole("button", { name: "+ Add option" }).click();
    await form.getByLabel("Option 1", { exact: true }).fill("Cam A");
    await form.getByLabel("Option 1 color").selectOption("green");
    await form.getByRole("button", { name: "+ Add option" }).click();
    await form.getByLabel("Option 2", { exact: true }).fill("Cam B");
  });
  await expect(grid.getByRole("columnheader", { name: "Camera" })).toBeVisible();

  // Edit: typing opens the option picker, Enter picks.
  const row = rows.filter({ has: page.locator('[data-col="number"]').getByText("0.10", { exact: true }) });
  const cell = cellOf(row, "custom.camera");
  await cell.click();
  await page.keyboard.type("Cam A");
  await page.keyboard.press("Enter");
  await expect(cell).toHaveText("Cam A");

  // Filter by it.
  const filter = await openPanel(page, "Filter");
  await filter.getByRole("button", { name: "+ Add filter" }).click();
  await filter.getByLabel("Filter 1 field").selectOption({ label: "Camera" });
  await filter.getByLabel("Filter 1 operator").selectOption("is");
  await filter.getByLabel("Filter 1 value").selectOption("Cam A");
  await closePanel(page, "Filter");
  await expect(page.getByTestId("cue-count")).toHaveText("1 of 120 cues");

  // Color rows by it (the one-click preset from its options' colors).
  const color = await openPanel(page, "Color");
  await color.getByRole("button", { name: /Color rows by camera/i }).click();
  await closePanel(page, "Color");
  await expect(row).toHaveAttribute("style", /--row-bg: var\(--option-green-bg\)/);

  // Reload: the value, the field and the draft view come back.
  await page.reload();
  await expect(cellOf(row, "custom.camera")).toHaveText("Cam A");
  await expect(page.getByTestId("cue-count")).toHaveText("1 of 120 cues");
  await expect(row).toHaveAttribute("style", /--row-bg: var\(--option-green-bg\)/);
  // The row panel shows the field too.
  await cellOf(row, "number").click();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("row-panel").getByText("Camera", { exact: true })).toBeVisible();
});

test("a formula custom field on Surfaces reads PPI", async ({ browser }) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Formula"));
  await importExamples(page, showId, ["Surfaces-Gallery.csv"]);
  await page.goto(`/shows/${showId}/surfaces`);
  const grid = page.getByRole("grid", { name: "Surface list" });
  const lpro = grid
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="name"]').getByText("L PRO", { exact: true }) });
  await expect(lpro).toBeVisible();
  await cellOf(lpro, "pixels").click();
  await page.keyboard.type("1920x1080");
  await page.keyboard.press("Enter");
  await expect(cellOf(lpro, "ppi")).toHaveText("10.84");

  await addField(page, "Double PPI", "Formula", async (form) => {
    await form.getByLabel("Formula", { exact: true }).fill("{PPI} * 2");
  });
  await expect(cellOf(lpro, "custom.double_ppi")).toHaveText("21.67");
  // Follows its input.
  await cellOf(lpro, "pixels").click();
  await page.keyboard.type("3840x2160");
  await page.keyboard.press("Enter");
  await expect(cellOf(lpro, "custom.double_ppi")).toHaveText("43.35");
  // A formula error is a value, not a crash.
  const fields = await openPanel(page, "Fields");
  await fields.getByRole("button", { name: "Edit field Double PPI" }).click();
  await fields.getByLabel("Formula", { exact: true }).fill("{PPI} / 0");
  await fields.getByRole("button", { name: "Save field" }).click();
  await closePanel(page, "Fields");
  await expect(cellOf(lpro, "custom.double_ppi")).toHaveText(/#DIV\/0/);
});

test("a custom table with URL and sensitive fields: masked, reveal, left out of the export", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Tables"));
  await page.goto(`/shows/${showId}/cues`);
  await page.getByRole("button", { name: "Show settings" }).click();
  page.once("dialog", (d) => void d.accept("Network"));
  await page.getByRole("button", { name: "+ New table" }).click();
  await expect(page).toHaveURL(/\/tables\//);
  await expect(page.getByRole("link", { name: "Network", exact: true })).toBeVisible();
  const table = page.getByTestId("custom-table");
  await expect(table.getByRole("heading", { name: "Network" })).toBeVisible();

  await addField(page, "Admin page", "URL");
  await addField(page, "Password", "Text", async (form) => {
    await form.getByLabel(/Sensitive/).check();
  });
  await page.getByRole("button", { name: "+ Add row" }).click();
  const grid = page.getByRole("grid", { name: "Network" });
  const row = grid.getByTestId("grid-row").first();
  await expect(row).toBeVisible();
  await page.keyboard.type("Switch");
  await page.keyboard.press("Tab");
  await page.keyboard.type("example.com/admin");
  await page.keyboard.press("Tab");
  await page.keyboard.type("hunter2");
  await page.keyboard.press("Enter");
  await expect(cellOf(row, "custom.name")).toHaveText("Switch");
  await expect(cellOf(row, "custom.admin_page").getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com/admin",
  );
  // Masked in the grid.
  await expect(cellOf(row, "custom.password")).not.toContainText("hunter2");
  await expect(cellOf(row, "custom.password")).toContainText("••••••");

  // The row panel reveals it.
  await cellOf(row, "custom.name").click();
  await page.keyboard.press("Space");
  const rp = page.getByTestId("row-panel");
  const masked = rp.getByTestId("masked-field");
  await expect(masked).not.toContainText("hunter2");
  await masked.getByRole("button", { name: "Reveal Password" }).click();
  await expect(masked.getByRole("textbox", { name: "Password" })).toHaveValue("hunter2");
  // History never shows it.
  await rp.getByRole("tab", { name: "History" }).click();
  await expect(rp.getByTestId("history")).toContainText("(hidden)");
  await expect(rp.getByTestId("history")).not.toContainText("hunter2");
  await rp.getByRole("button", { name: "Close panel" }).click();

  // Export: sensitive fields are left out (an editor can't include them).
  const exp = await openPanel(page, "Export CSV");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exp.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  const text = readFileSync((await download.path()) as string, "utf8");
  expect(text).toContain("Switch");
  expect(text).toContain("https://example.com/admin");
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("Password");
});

test("the Network CSV imports into a custom table from the preview", async ({ browser }) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Import"));
  await page.goto(`/shows/${showId}/cues`);
  await page.getByRole("button", { name: "Show settings" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("dialog", { name: "Show settings" })
    .getByRole("button", { name: "Import Airtable CSVs…" })
    .click();
  const csv = path.join("examples", "Network-Grid view.csv");
  await (await chooser).setFiles(csv);
  const preview = page.getByTestId("import-preview");
  await expect(preview).toContainText("a new custom table");
  await expect(preview.getByLabel("Type of IP")).toHaveValue("text");
  await expect(preview.getByLabel("Type of Type")).toHaveValue("select");
  await expect(preview).toContainText("Password (sensitive)");
  await preview.getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("import-result")).toContainText("1 custom table (10 rows)");
  await page.getByRole("link", { name: "Network", exact: true }).click();
  const grid = page.getByRole("grid", { name: "Network" });
  await expect(page.getByTestId("row-count")).toHaveText("10 rows");
  const mac = grid
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="custom.name"]').getByText("Mac pro", { exact: true }) });
  await expect(cellOf(mac, "custom.ip")).toHaveText("192.168.11.162");
  await expect(cellOf(mac, "custom.type")).toHaveText("Media Server");
  await expect(cellOf(mac, "custom.password")).toContainText("••••••");
  await expect(cellOf(mac, "custom.password")).not.toContainText("REDACTED");
});

test("the Fields manager at 390 px", async ({ browser }) => {
  const page = await newPage(browser, { width: 390, height: 844 });
  const showId = await apiCreateShow(page, uniqueName("Phone fields"));
  await page.goto(`/shows/${showId}/scenes`);
  await expect(page.getByTestId("view-bar")).toBeVisible();
  await addField(page, "Mood", "Multiple select", async (form) => {
    await form.getByRole("button", { name: "+ Add option" }).click();
    await form.getByLabel("Option 1", { exact: true }).fill("Dark");
  });
  const fields = await openPanel(page, "Fields");
  await fields.getByRole("button", { name: "Edit field Mood" }).click();
  await expect(fields.getByTestId("field-form")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await fields.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  page.once("dialog", (d) => void d.accept());
  await fields.getByRole("button", { name: "Cancel" }).click();
  await fields.getByRole("button", { name: "Delete field Mood" }).click();
  await expect(fields.getByTestId("custom-field")).toHaveCount(0);
});
