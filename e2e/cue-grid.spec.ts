// The cue list on the live store (M1c): the Some Like It Hot example imported through the
// API into a fresh show per test, then driven through the grid.
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import {
  addMember,
  apiCreateShow,
  apiLogin,
  importExamples,
  snapshot,
  trackErrors,
  uniqueName,
} from "./helpers";

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

/** A signed-in page in its own browser context, with console errors tracked. */
async function newPage(browser: Browser): Promise<Page> {
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  ).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

/** A new show with the example data; the page is on its Cues tab. */
async function exampleShow(browser: Browser, files?: string[]) {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Some Like It Hot"));
  await importExamples(page, showId, files);
  await openCues(page, showId);
  return { page, showId };
}

async function openCues(page: Page, showId: string, query = "") {
  await page.goto(`/shows/${showId}${query}`);
  await expect(page).toHaveURL(new RegExp(`/shows/${showId}/cues`));
  await expect(grid(page)).toBeVisible();
  await expect(rowByCue(page, "0.10")).toBeVisible();
}

/** Opens the cue list at a cue (`?cue=<id>` scrolls to it and makes it active). */
async function goToCue(page: Page, showId: string, number: string) {
  const cue = (await snapshot(page, showId)).tables.cues.find((c) => c.number === number);
  if (!cue) throw new Error(`no cue ${number}`);
  await page.goto(`/shows/${showId}/cues?cue=${cue.id}`);
  await expect(cellOf(rowByCue(page, number), "number")).toHaveAttribute("data-active", "true");
  return cue.id;
}

const grid = (page: Page) => page.getByRole("grid", { name: "Cue list" });
const rowByCue = (page: Page, cue: string) =>
  grid(page)
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText(cue, { exact: true }) });
const cellOf = (row: Locator, key: string) => row.locator(`[data-col="${key}"]`);
const rowIndex = async (row: Locator) => Number(await row.getAttribute("aria-rowindex"));
const rowAt = (page: Page, index: number) =>
  grid(page).locator(`[role="row"][aria-rowindex="${index}"]`);
const groupHeader = (page: Page, title: string) =>
  grid(page).getByTestId("group-header").filter({ hasText: title });

async function collapse(page: Page, title: string) {
  await groupHeader(page, title)
    .getByRole("button", { name: `Collapse ${title}` })
    .click();
}

/** Cue numbers in show order, from the server. */
async function serverNumbers(page: Page, showId: string) {
  return (await snapshot(page, showId)).tables.cues.map((c) => c.number);
}

async function sortMenu(page: Page, item: string) {
  await page.getByRole("button", { name: "Sort" }).click();
  await page
    .getByRole("menu", { name: "Sort" })
    .getByRole("menuitem", { name: item })
    .or(page.getByRole("menu", { name: "Sort" }).getByRole("menuitemcheckbox", { name: item }))
    .click();
}

test("insert between 14.20 and 14.25: in place, ghost 14.22, Tab accepts, survives reload", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  await goToCue(page, showId, "14.20");
  const anchor = rowByCue(page, "14.20");
  const at = await rowIndex(anchor);
  await cellOf(anchor, "number").click();
  await page.keyboard.press("ControlOrMeta+Shift+Enter");

  const fresh = rowAt(page, at + 1);
  await expect(cellOf(fresh, "number")).toBeFocused();
  await expect(cellOf(fresh, "number").getByTestId("ghost")).toHaveText("14.22");
  await expect(rowAt(page, at + 2)).toContainText("14.25");
  // In the same scene group.
  await page.keyboard.press("Tab");
  await expect(cellOf(fresh, "number")).toHaveText("14.22");
  await expect(cellOf(fresh, "description")).toBeFocused();
  await expect(page).toHaveURL(/\?cue=/);

  await expect
    .poll(async () => {
      const cues = (await snapshot(page, showId)).tables.cues;
      const i = cues.findIndex((c) => c.number === "14.22");
      return [cues[i - 1]?.number, cues[i]?.number, cues[i + 1]?.number];
    })
    .toEqual(["14.20", "14.22", "14.25"]);
  await page.reload();
  const again = rowByCue(page, "14.22");
  await expect(again).toBeVisible();
  const i = await rowIndex(again);
  await expect(rowAt(page, i - 1)).toContainText("14.20");
  await expect(rowAt(page, i + 1)).toContainText("14.25");
  // The URL still names the row, so it's the active one after the reload.
  await expect(cellOf(again, "number")).toHaveAttribute("data-active", "true");
});

test("an unnumbered cue stays where it was inserted (show order)", async ({ browser }) => {
  const { page, showId } = await exampleShow(browser);
  await goToCue(page, showId, "14.20");
  const anchor = rowByCue(page, "14.20");
  const at = await rowIndex(anchor);
  await cellOf(anchor, "description").click();
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  const fresh = rowAt(page, at + 1);
  await expect(cellOf(fresh, "number")).toBeFocused();
  // Leave it empty and click elsewhere.
  await cellOf(rowByCue(page, "13.00"), "description").click();
  await expect(cellOf(fresh, "number")).toHaveText("");
  await expect(rowAt(page, at + 2)).toContainText("14.25");

  await expect
    .poll(async () => {
      const cues = (await snapshot(page, showId)).tables.cues;
      const i = cues.findIndex((c) => c.number === "14.20");
      const next = cues[i + 1];
      return [next ? next.number : "missing", cues[i + 2]?.number];
    })
    .toEqual([null, "14.25"]);
  await goToCue(page, showId, "14.20");
  const reloaded = await rowIndex(rowByCue(page, "14.20"));
  await expect(cellOf(rowAt(page, reloaded + 1), "number")).toHaveText("");
  await expect(rowAt(page, reloaded + 2)).toContainText("14.25");
});

test("live sort holds an edited row until focus leaves it", async ({ browser }) => {
  const { page } = await exampleShow(browser);
  await sortMenu(page, "Sort by cue number (live)");
  await expect(page.getByRole("button", { name: "Sort" })).toHaveText(/Sorted by cue number/);
  const row = rowByCue(page, "0.30");
  const at = await rowIndex(row);
  await cellOf(row, "number").click();
  await page.keyboard.type("0.95");
  await page.keyboard.press("Tab");
  const edited = rowByCue(page, "0.95");
  await expect(edited).toHaveAttribute("aria-rowindex", String(at)); // held in place
  await expect(cellOf(edited, "description")).toBeFocused();

  // Clicking another row lets it settle after 0.90.
  await cellOf(rowByCue(page, "0.10"), "description").click();
  await expect(edited).toHaveAttribute("data-moved", "true");
  const ninety = await rowIndex(rowByCue(page, "0.90"));
  await expect(edited).toHaveAttribute("aria-rowindex", String(ninety + 1));
  await expect(rowAt(page, at)).toContainText("0.80");

  // Remove sort: back to show order (0.95 is where 0.30 was).
  await sortMenu(page, "Remove sort");
  await expect(edited).toHaveAttribute("aria-rowindex", String(at));
});

test("Sort now rewrites show order to match cue numbers", async ({ browser }) => {
  const { page, showId } = await exampleShow(browser);
  const numeric = (xs: (string | null)[]) =>
    [...xs].sort((a, b) => Number.parseFloat(a ?? "Infinity") - Number.parseFloat(b ?? "Infinity"));
  const before = await serverNumbers(page, showId);
  expect(before).not.toEqual(numeric(before)); // 51.50 sits after 0.90 in the export

  page.on("dialog", (d) => void d.accept()); // in case unnumbered cues need confirming
  await sortMenu(page, "Sort now by cue number");
  await expect(page.getByTestId("toast")).toContainText("Show order now follows cue numbers");
  await expect.poll(() => serverNumbers(page, showId)).toEqual(numeric(before));

  // Unassigned (in show order) now reads 0.10 0.30 0.80 0.90 14.80 …
  await page.reload();
  await expect(rowByCue(page, "0.90")).toBeVisible();
  const ninety = await rowIndex(rowByCue(page, "0.90"));
  await expect(cellOf(rowAt(page, ninety + 1), "number")).toHaveText("14.80");
});

test("dragging a cue into another scene group re-links its scene", async ({ browser }) => {
  const { page, showId } = await exampleShow(browser);
  await collapse(page, "Unassigned");
  // Drag 5.00 (scene 102) up to just below 2.00 (scene 100).
  const source = rowByCue(page, "5.00");
  await expect(cellOf(source, "scene")).toHaveText("102 Scene Two: The Street");
  await source.hover();
  const handle = await source.getByTestId("drag-handle").boundingBox();
  const target = await rowByCue(page, "2.00").boundingBox();
  if (!handle || !target) throw new Error("no boxes");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 10, target.y + target.height - 6, { steps: 12 });
  await page.mouse.up();

  await expect(cellOf(source, "scene")).toHaveText("100 Overture");
  const two = await rowIndex(rowByCue(page, "2.00"));
  await expect(source).toHaveAttribute("aria-rowindex", String(two + 1));
  await expect
    .poll(async () => {
      const snap = await snapshot(page, showId);
      const cue = snap.tables.cues.find((c) => c.number === "5.00");
      const scene = snap.tables.scenes.find((s) => s.id === cue?.scene_id);
      const i = snap.tables.cues.findIndex((c) => c.number === "5.00");
      return [scene?.number, snap.tables.cues[i - 1]?.number];
    })
    .toEqual(["100", "2.00"]);
});

test("content picker creates content in the cue's scene with the scene prefix", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  await goToCue(page, showId, "14.30");
  const content = cellOf(rowByCue(page, "14.30"), "content");
  await content.click();
  const name = `LOOK${Date.now().toString(36).toUpperCase()}`;
  await page.keyboard.type(name);
  const picker = page.getByTestId("record-picker");
  await picker.getByRole("option", { name: `Create “${name}”` }).click();
  // Scene 105 already has 105-001-VAMP and 105-002-…: the next number is 003.
  await expect(content).toContainText(`105-003-${name}`);
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Content", exact: true }).click();
  const list = page.getByRole("grid", { name: "Content list" });
  await expect(list).toBeVisible();
  // Open it at the new item (?content=<id>), which scrolls it into view.
  const created = (await snapshot(page, showId)).tables.content.find(
    (c) => c.name === `105-003-${name}`,
  );
  expect(created).toBeTruthy();
  await page.goto(`/shows/${showId}/content?content=${created?.id}`);
  const row = list.getByTestId("grid-row").filter({ hasText: `105-003-${name}` });
  await expect(row).toBeVisible();
  await expect(cellOf(row, "scene")).toHaveText("105 Scene Five: Backstage");
  await expect(cellOf(row, "cues")).toContainText("14.30");
});

test("two browsers: inserts and edits appear live, in place", async ({ browser }) => {
  const { page: a, showId } = await exampleShow(browser, [
    "Breakdown-Grid view.csv",
    "Content-Grid view.csv",
    "Cue List-Video Cue List View.csv",
  ]);
  const b = await newPage(browser);
  await goToCue(b, showId, "14.20");
  await goToCue(a, showId, "14.20");
  await expect(b.getByTestId("presence-count")).toHaveText("2 clients");

  // A inserts below 14.20 and numbers it.
  await cellOf(rowByCue(a, "14.20"), "number").click();
  await a.keyboard.press("ControlOrMeta+Shift+Enter");
  await a.keyboard.type("14.21");
  await a.keyboard.press("Enter");
  const inB = rowByCue(b, "14.21");
  await expect(inB).toBeVisible();
  const i = await rowIndex(inB);
  await expect(rowAt(b, i - 1)).toContainText("14.20");
  await expect(rowAt(b, i + 1)).toContainText("14.25");

  // B edits a description; A sees it.
  await cellOf(rowByCue(b, "14.25"), "description").click();
  await b.keyboard.type("Edited in B");
  await b.keyboard.press("Enter");
  await expect(cellOf(rowByCue(a, "14.25"), "description")).toHaveText("Edited in B");
});

test("⌘K finds a cue by number and focuses it, expanding its group", async ({ browser }) => {
  const { page, showId } = await exampleShow(browser, [
    "Breakdown-Grid view.csv",
    "Content-Grid view.csv",
    "Cue List-Video Cue List View.csv",
    "Personnel-Grid view.csv",
  ]);
  await goToCue(page, showId, "14.00");
  await collapse(page, "105 Scene Five: Backstage");
  await expect(rowByCue(page, "14.20")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await palette.getByRole("combobox").fill("14.2");
  await expect(palette.getByRole("option").first()).toContainText("Cue 14.20");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  const row = rowByCue(page, "14.20");
  await expect(cellOf(row, "number")).toBeFocused();
  await expect(page).toHaveURL(/\?cue=/);

  // Jumping to another table: a person on the People tab.
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("Casey");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/people\?person=/);
  const people = page.getByRole("grid", { name: "People" });
  await expect(people.locator('[data-active="true"]')).toContainText("Casey");
});

test("a viewer gets a read-only cue list with no insert", async ({ browser }) => {
  const { page: admin, showId } = await exampleShow(browser, [
    "Breakdown-Grid view.csv",
    "Cue List-Video Cue List View.csv",
  ]);
  const { page: viewer } = await addMember(browser, admin, showId, "viewer");
  pages.push(viewer);
  trackErrors(viewer, errors);
  await openCues(viewer, showId);
  await expect(viewer.getByRole("button", { name: "+ Add cue" })).toHaveCount(0);
  await expect(grid(viewer).getByRole("button", { name: /^Add row to/ })).toHaveCount(0);
  await expect(viewer.getByLabel("Import Airtable CSVs…")).toHaveCount(0);
  const cell = cellOf(rowByCue(viewer, "0.10"), "description");
  await expect(cell).toHaveAttribute("aria-readonly", "true");
  await cell.click();
  await viewer.keyboard.type("x");
  await expect(cell.getByRole("textbox")).toHaveCount(0);
  await viewer.keyboard.press("ControlOrMeta+Shift+Enter");
  await expect(cell).toHaveAttribute("data-active", "true"); // nothing was inserted
  await expect(viewer.getByTestId("cue-count")).toHaveText("120 cues");
  const res = await viewer.request.get(`/api/shows/${showId}/snapshot`);
  expect(((await res.json()) as { tables: { cues: unknown[] } }).tables.cues).toHaveLength(120);
  // "Sort now" isn't offered either (live sort is a personal view setting, so it is).
  await viewer.getByRole("button", { name: "Sort" }).click();
  await expect(viewer.getByRole("menuitem", { name: "Sort now by cue number" })).toHaveCount(0);
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the Cues tab doesn't overflow the page", async ({ browser }) => {
    const page = await newPage(browser);
    await page.setViewportSize({ width: 390, height: 844 });
    const showId = await apiCreateShow(page, uniqueName("Phone"));
    await importExamples(page, showId, [
      "Breakdown-Grid view.csv",
      "Cue List-Video Cue List View.csv",
    ]);
    await openCues(page, showId);
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scroll).toBeLessThanOrEqual(client);
    // The grid itself fits and scrolls sideways.
    const box = await grid(page).boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await expect(page.getByRole("link", { name: "Cues", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "People", exact: true })).toBeVisible();
    // The row panel opens over the grid, not off-screen.
    await cellOf(rowByCue(page, "0.10"), "number").click();
    await page.keyboard.press("Space");
    const panel = page.getByTestId("row-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Cue 0.10");
    const pb = await panel.boundingBox();
    expect((pb?.x ?? 0) + (pb?.width ?? 0)).toBeLessThanOrEqual(390);
  });
});
