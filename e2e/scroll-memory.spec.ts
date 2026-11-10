// Scroll memory (CLAUDE.md "Scroll memory"): leaving a tab and coming back lands where you
// were (the same rows in a grid, the same page in the script), a reload in the same browser
// tab too, and a jump that points somewhere ("Show in script", a link to another row) still
// goes there.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  apiCreateShow,
  apiLogin,
  importExamples,
  scrollGrid,
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

async function newPage(browser: Browser) {
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 900 } })
  ).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

const grid = (page: Page) => page.getByTestId("grid-scroll");
const tab = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Show" }).getByRole("link", { name, exact: true });

/**
 * Records the first animation frame (callbacks run just before a paint) in which the grid
 * named `name` is on the page: its scrollTop, and the row at its top.
 */
async function recordFirstFrame(page: Page, name: string) {
  await page.evaluate((name) => {
    const w = window as unknown as { firstFrame?: unknown };
    w.firstFrame = undefined;
    const tick = () => {
      const g = document.querySelector(`[role="grid"][aria-label="${name}"]`);
      const el = g?.querySelector<HTMLElement>('[data-testid="grid-scroll"]');
      if (!el) {
        requestAnimationFrame(tick);
        return;
      }
      const box = el.getBoundingClientRect();
      const y = box.top + 34 + 40 + 6;
      let hasRow: string | null = null;
      for (const r of Array.from(el.querySelectorAll<HTMLElement>("[data-row-id]"))) {
        const b = r.getBoundingClientRect();
        if (b.top <= y && y < b.bottom) hasRow = r.dataset.rowId ?? null;
      }
      w.firstFrame = { scrollTop: el.scrollTop, hasRow };
    };
    requestAnimationFrame(tick);
  }, name);
}

/**
 * The row under a line just below the stuck headers, and where its top is in the view:
 * what you see at the top of the grid.
 */
async function rowAtTop(page: Page, below = 34 + 40 + 6) {
  // Settled: the grid has laid out the offset it's at (read together, so no stale target).
  await expect
    .poll(() =>
      grid(page).evaluate((el) => Math.round(el.scrollTop) === Number(el.dataset.scrollOffset)),
    )
    .toBe(true);
  return grid(page).evaluate((el, below) => {
    const box = el.getBoundingClientRect();
    const y = box.top + below; // default: under the column header + stuck group header
    for (const r of Array.from(el.querySelectorAll<HTMLElement>("[data-row-id]"))) {
      const b = r.getBoundingClientRect();
      if (b.top <= y && y < b.bottom)
        return { id: r.dataset.rowId ?? "", top: Math.round(b.top - box.top) };
    }
    return null;
  }, below);
}

test("cue grid: back from another tab, and after a reload, on the same rows and cell", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Scroll memory"));
  await importExamples(page, showId);
  await page.goto(`/shows/${showId}/cues`);
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();
  await expect(page.locator("[data-row-id]").first()).toBeVisible();

  await scrollGrid(grid(page), 2400);
  const before = await rowAtTop(page);
  if (!before) throw new Error("no row at the top");
  // Make a cell in a visible row active (the click keeps the scroll: the row is in view).
  // The row nearest the middle that's fully in view, under the column header and the stuck
  // group header: what sits at a given pixel depends on the fonts (row heights are measured),
  // so the middle line itself can fall on a group header.
  const rows = page.locator("[data-row-id]");
  const activeId = await grid(page).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const top = box.top + 34 + 40;
    const bottom = box.top + el.clientHeight;
    const mid = (top + bottom) / 2;
    let best = "";
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const r of Array.from(el.querySelectorAll<HTMLElement>("[data-row-id]"))) {
      const b = r.getBoundingClientRect();
      if (b.top < top || b.bottom > bottom) continue;
      const distance = Math.abs((b.top + b.bottom) / 2 - mid);
      if (distance < bestDistance) {
        best = r.dataset.rowId ?? "";
        bestDistance = distance;
      }
    }
    return best;
  });
  if (!activeId) throw new Error("no row fully in view");
  await rows
    .and(page.locator(`[data-row-id="${activeId}"]`))
    .locator('[data-col="description"]')
    .click();
  await expect(page).toHaveURL(new RegExp(`cue=${activeId}`));
  const settled = await rowAtTop(page);
  expect(settled).toEqual(before);

  // --- Another tab and back: the same row at the same place, the same active cell ---
  await tab(page, "Notes").click();
  await expect(page.getByRole("grid", { name: "Notes" })).toBeVisible();
  await recordFirstFrame(page, "Cue list");
  await tab(page, "Cues").click();
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();
  await expect.poll(() => rowAtTop(page)).toEqual(before);
  const active = page.locator(`[data-row-id="${activeId}"] [data-col="description"]`);
  await expect(active).toHaveAttribute("data-active", "true");
  await expect(active).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`cue=${activeId}`));
  // No frame of the top first: the first painted frame of the cue list was already scrolled,
  // with the remembered row in it.
  expect(
    await page.evaluate(() => (window as unknown as { firstFrame: unknown }).firstFrame),
  ).toEqual({ scrollTop: expect.any(Number), hasRow: before.id });
  expect(
    await page.evaluate(
      () => (window as unknown as { firstFrame: { scrollTop: number } }).firstFrame.scrollTop,
    ),
  ).toBeGreaterThan(1000);

  // Notes kept its own place (the top: never scrolled), not the cue list's.
  await tab(page, "Notes").click();
  await expect(page.getByRole("grid", { name: "Notes" })).toBeVisible();
  await expect(grid(page)).toHaveAttribute("data-scroll-offset", "0");
  await tab(page, "Cues").click();
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();
  await expect.poll(() => rowAtTop(page)).toEqual(before);

  // --- A reload in the same browser tab ---
  await page.reload();
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();
  await expect.poll(() => rowAtTop(page)).toEqual(before);
  await expect(active).toHaveAttribute("data-active", "true");

  // --- A layout change (row height) keeps the row that was at the view's top edge ---
  const edge = await rowAtTop(page, 34 + 1);
  if (!edge) throw new Error("no row at the top edge");
  await page.getByRole("button", { name: "Row height" }).click();
  await page.getByRole("radio", { name: "Compact · 1 line" }).check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("grid", { name: "Cue list" })).toHaveAttribute(
    "data-row-height",
    "compact",
  );
  await expect.poll(async () => (await rowAtTop(page, 34 + 1))?.id).toBe(edge.id);

  // --- A link to another row goes to that row, not to the remembered place ---
  const first = await page.request
    .get(`/api/shows/${showId}/snapshot`)
    .then((r) => r.json() as Promise<{ tables: { cues: { id: string; is_section: boolean }[] } }>)
    .then((s) => s.tables.cues.find((c) => !c.is_section)?.id ?? "");
  await page.goto(`/shows/${showId}/cues?cue=${first}`);
  const firstCell = page.locator(`[data-row-id="${first}"] [data-active]`);
  await expect(firstCell).toBeFocused();
  await expect(firstCell).toBeInViewport();
  await expect(page.locator(`[data-row-id="${before.id}"]`)).not.toBeInViewport();
});

test("content gallery: back from another tab on the same cards", async ({ browser }) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Scroll memory gallery"));
  await importExamples(page, showId);
  await page.goto(`/shows/${showId}/content`);
  await expect(page.getByRole("grid", { name: "Content list", exact: true })).toBeVisible();
  await page.getByTestId("view-layout").click();
  const gallery = page.getByTestId("gallery");
  await expect(gallery.getByTestId("gallery-card").first()).toBeVisible();
  await gallery.evaluate((el) => {
    el.scrollTop = 1500;
  });
  /** The first card whose top is at or below the gallery's top edge. */
  const topCard = () =>
    gallery.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      let best: { id: string; top: number } | null = null;
      for (const c of Array.from(el.querySelectorAll<HTMLElement>("[data-card-id]"))) {
        const t = Math.round(c.getBoundingClientRect().top - top);
        if (t >= -1 && (!best || t < best.top)) best = { id: c.dataset.cardId ?? "", top: t };
      }
      return best;
    });
  await expect.poll(() => gallery.evaluate((el) => el.scrollTop)).toBe(1500);
  const before = await topCard();
  expect(before).not.toBeNull();
  await tab(page, "Cues").click();
  await expect(page.getByRole("grid", { name: "Cue list" })).toBeVisible();
  await tab(page, "Content").click();
  await expect(gallery).toBeVisible();
  await expect.poll(topCard).toEqual(before);
});

/** A PDF of `n` pages, each with its number printed at the top right and a few lines. */
async function longPdf(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(String(i), { x: 530, y: 750, size: 10, font: roman });
    let y = 690;
    for (let l = 0; l < 6; l++) {
      page.drawText(`Line ${l + 1} of scene ${i}: the band plays on and on.`, {
        x: 100,
        y,
        size: 12,
        font: roman,
      });
      y -= 28;
    }
  }
  return Buffer.from(await doc.save());
}

const reader = (page: Page) => page.getByTestId("pdf-reader");

/** The text reader: the page (1-based) at the top of the view, under its sticky header. */
function textPageAtTop(page: Page) {
  return page.getByTestId("script-reader").evaluate((el) => {
    const header = el.querySelector<HTMLElement>("[data-testid=script-page-header]");
    const y = el.getBoundingClientRect().top + (header?.offsetHeight ?? 0) + 4;
    for (const slot of Array.from(el.querySelectorAll<HTMLElement>("[data-index]"))) {
      const b = slot.getBoundingClientRect();
      if (b.top <= y && y < b.bottom) return Number(slot.dataset.index) + 1;
    }
    return null;
  });
}

test("script PDF view: back on the same page after another tab and a reload; Show in script wins", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Scroll memory PDF"));
  await page.goto(`/shows/${showId}/script`);
  await page.getByTestId("script-file-input").setInputFiles({
    name: "long.pdf",
    mimeType: "application/pdf",
    buffer: await longPdf(12),
  });
  await expect(page.getByTestId("import-preview")).toContainText("12 pages", { timeout: 20_000 });
  await page.getByLabel("Version label").fill("v1");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.locator('[data-testid="pdf-page"][data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
    { timeout: 20_000 },
  );

  // A cue on page 1 (select its text, New cue), for "Show in script" later.
  await page.evaluate(() => {
    const span = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-page="1"] [data-testid="pdf-text"] [data-item]',
      ),
    ).find((s) => (s.textContent ?? "").includes("band plays"));
    const node = span?.firstChild;
    if (!span || !node) throw new Error("no text on page 1");
    const at = (span.textContent ?? "").indexOf("band plays");
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + "band plays".length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r);
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  const pop = page.getByTestId("place-popover");
  await pop.getByRole("button", { name: "New cue on this line" }).click();
  await pop.getByLabel("Cue number").fill("1");
  await pop.getByRole("button", { name: "Create cue" }).click();
  await expect(pop).toBeHidden();
  const marker = page.locator('[data-testid="pdf-marker"]', { hasText: "1" }).first();
  const cueId = (await marker.getAttribute("data-cue")) as string;

  // Read down to page 8, a bit into it.
  const scale = Number(await reader(page).getAttribute("data-scale"));
  const pageStep = 792 * scale + 16;
  await reader(page).evaluate(
    (el, t) => {
      el.scrollTop = t;
    },
    Math.round(pageStep * 7.3),
  );
  await expect(page.getByTestId("current-page")).toHaveText("8");
  const at = await reader(page).evaluate((el) => el.scrollTop);

  // --- Another tab and back ---
  await tab(page, "Notes").click();
  await expect(page.getByRole("grid", { name: "Notes" })).toBeVisible();
  await tab(page, "Script").click();
  await expect(reader(page)).toBeVisible();
  await expect
    .poll(() => reader(page).evaluate((el, a) => Math.abs(el.scrollTop - a), at))
    .toBeLessThan(4);
  await expect(page.getByTestId("current-page")).toHaveText("8");
  await expect(page.locator('[data-testid="pdf-page"][data-page="8"]')).toHaveAttribute(
    "data-rendered",
    "true",
  );

  // --- The text view and back: the same page ---
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByTestId("script-reader")).toBeVisible();
  // (The header names the page at the middle of the view; text pages are short.)
  await expect.poll(() => textPageAtTop(page)).toBe(8);
  await page.getByRole("button", { name: "PDF pages" }).click();
  await expect(reader(page)).toBeVisible();
  await expect(page.getByTestId("current-page")).toHaveText("8");

  // --- A reload ---
  await reader(page).evaluate((el, t) => {
    el.scrollTop = t;
  }, at);
  await expect(page.getByTestId("current-page")).toHaveText("8");
  await page.reload();
  await expect(reader(page)).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => reader(page).evaluate((el, a) => Math.abs(el.scrollTop - a), at))
    .toBeLessThan(4);
  await expect(page.getByTestId("current-page")).toHaveText("8");

  // --- "Show in script" from the cue list goes to the cue on page 1, not page 8 ---
  await tab(page, "Cues").click();
  const cell = page.locator(`[data-row-id="${cueId}"] [data-col="number"]`);
  await cell.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show in script" }).click();
  await expect(page).toHaveURL(new RegExp(`/script\\?cue=${cueId}`));
  await expect(page.locator(`[data-testid="pdf-marker"][data-cue="${cueId}"]`)).toHaveAttribute(
    "data-flash",
    "true",
  );
  await expect(page.getByTestId("current-page")).toHaveText("1");
});
