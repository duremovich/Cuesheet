// Row height: "Fit to content" (auto, the default) grows a row to show its cells' text,
// keeps an inline editor (and its caret) in view while you type, and still sticks group
// headers correctly with rows of every height; the fixed heights (Compact / Normal / Tall)
// stay fixed. Also the row panel's long-text field, which grows instead of hiding text.
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import {
  apiCreateShow,
  apiLogin,
  recordId,
  trackErrors,
  uniqueName,
  waitForShowReady,
} from "./helpers";

let errors: string[] = [];

test.beforeEach(() => {
  errors = [];
});

test.afterEach(() => {
  expect(errors, "console errors").toEqual([]);
});

const SENTENCE =
  "The stage-left projector blend drifts after intermission; re-check the warp before the half. ";

interface NoteSpec {
  body: string;
  status?: "Open" | "In progress" | "Done";
}

/** A show with these notes; returns the page (signed in) and the note ids in order. */
async function notesShow(browser: Browser, notes: NoteSpec[]) {
  const page = await (
    await browser.newContext({ viewport: { width: 1400, height: 900 } })
  ).newPage();
  trackErrors(page, errors);
  await apiLogin(page);
  const showId = await apiCreateShow(page, uniqueName("Rows"));
  const ids = notes.map(() => recordId());
  const ops = notes.map((n, i) => ({
    op: "create",
    table: "notes",
    id: ids[i],
    fields: { body: n.body, status: n.status ?? "Open" },
  }));
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "e2e", ops },
  });
  expect(res.status(), await res.text()).toBe(200);
  return { page, showId, ids };
}

async function openNotes(page: Page, showId: string, query = "") {
  await page.goto(`/shows/${showId}/notes${query}`);
  await waitForShowReady(page);
  await expect(notesGrid(page).getByTestId("grid-row").first()).toBeVisible();
}

const notesGrid = (page: Page) => page.getByRole("grid", { name: "Notes" });
const rowOf = (page: Page, id: string) => notesGrid(page).locator(`[data-row-id="${id}"]`);
const scroller = (page: Page) => page.getByTestId("grid-scroll");

/** Height, top and bottom of a row, plus the top of the row right below it in the view. */
async function geometry(row: Locator) {
  return row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const below = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="grid-row"]'))
      .map((e) => e.getBoundingClientRect().top)
      .filter((t) => t >= r.top + 1)
      .sort((a, b) => a - b)[0];
    const text = el.querySelector<HTMLElement>('[data-col="body"] > span');
    return {
      height: Math.round(r.height),
      bottom: Math.round(r.bottom),
      nextTop: below === undefined ? null : Math.round(below),
      clipped: text ? text.scrollHeight > text.clientHeight + 1 : null,
    };
  });
}

/** Sets the grid's scrollTop and waits until the grid has laid out that offset. */
async function scrollGrid(page: Page, top: number): Promise<number> {
  const actual = await scroller(page).evaluate((el, t) => {
    el.scrollTop = t;
    return Math.round(el.scrollTop);
  }, top);
  await expect(scroller(page)).toHaveAttribute("data-scroll-offset", String(actual));
  return actual;
}

test("fit to content is the default: a long note grows its row, short ones stay one line", async ({
  browser,
}) => {
  const { page, showId, ids } = await notesShow(browser, [
    { body: "short note" },
    { body: SENTENCE.repeat(4).trim() },
    { body: SENTENCE.repeat(60).trim() },
  ]);
  const [short, long, huge] = ids as [string, string, string];
  await openNotes(page, showId);
  await page.getByRole("button", { name: "Row height" }).click();
  await expect(page.getByRole("radio", { name: "Fit to content" })).toBeChecked();
  await page.keyboard.press("Escape");

  // Measured, so wait for the grid to settle on the real heights.
  await expect.poll(async () => (await geometry(rowOf(page, long))).height).toBeGreaterThan(80);
  const s = await geometry(rowOf(page, short));
  expect(s.height).toBe(40);
  const l = await geometry(rowOf(page, long));
  // Every line of it shows, and the next row starts where it ends (no overlap).
  expect(l.clipped).toBe(false);
  if (l.nextTop !== null) expect(l.nextTop).toBe(l.bottom);
  // A very long note stops at the cap (12 lines) with an ellipsis; the panel has the rest.
  const h = await geometry(rowOf(page, huge));
  expect(h.height).toBe(12 * 18 + 22);
  expect(h.clipped).toBe(true);
});

test("typing a long note inline grows the row and keeps the caret in view", async ({ browser }) => {
  const notes = Array.from({ length: 30 }, (_, i) => ({ body: `note ${i}` }));
  const { page, showId, ids } = await notesShow(browser, notes);
  await openNotes(page, showId);
  // Bring a row to the very bottom of the grid's view.
  const id = ids[12] as string;
  const row = rowOf(page, id);
  await expect(row).toBeVisible();
  const top = await scroller(page).evaluate((el, rowId) => {
    const r = el.querySelector<HTMLElement>(`[data-row-id="${rowId}"]`);
    if (!r) return el.scrollTop;
    const box = el.getBoundingClientRect();
    return el.scrollTop + r.getBoundingClientRect().bottom - (box.top + el.clientHeight);
  }, id);
  await scrollGrid(page, top);

  await row.locator('[data-col="body"]').click();
  await page.keyboard.press("Enter");
  const editor = row.getByRole("textbox", { name: "Note" });
  await expect(editor).toBeFocused();
  await page.keyboard.press("End");
  // 11 lines: under the 12 a cell shows once committed.
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`line ${i} of a note typed straight into the grid`);
  }
  const m = await editor.evaluate((el) => {
    const ed = el as HTMLTextAreaElement;
    const sc = ed.closest<HTMLElement>('[data-testid="grid-scroll"]') as HTMLElement;
    const e = ed.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    const rowEl = ed.closest<HTMLElement>('[data-testid="grid-row"]') as HTMLElement;
    return {
      editorBottom: e.bottom,
      viewBottom: s.top + sc.clientHeight,
      hidden: ed.scrollHeight - ed.clientHeight,
      rowHeight: rowEl.offsetHeight,
      caretAtEnd: ed.selectionEnd === ed.value.length,
    };
  });
  // The row grew with the text (11 lines), the editor shows all of it, and its bottom
  // (where the caret is) is inside the grid's view.
  expect(m.rowHeight).toBeGreaterThan(11 * 18);
  expect(m.hidden).toBeLessThanOrEqual(1);
  expect(m.caretAtEnd).toBe(true);
  expect(m.editorBottom).toBeLessThanOrEqual(m.viewBottom + 1);
  // The rows below moved down instead of being covered.
  const g = await geometry(row);
  if (g.nextTop !== null) expect(g.nextTop).toBeGreaterThanOrEqual(g.bottom);

  await page.keyboard.press("Enter");
  await expect(row.locator('[data-col="body"]')).toContainText("line 9 of a note");
  const after = await geometry(row);
  expect(after.height).toBeGreaterThan(11 * 18);
  expect(after.clipped).toBe(false);
});

test("the row panel's note field shows the whole note and follows the caret", async ({
  browser,
}) => {
  const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${SENTENCE}`).join("\n");
  const { page, showId, ids } = await notesShow(browser, [{ body }]);
  const id = ids[0] as string;
  await openNotes(page, showId);
  await rowOf(page, id).locator('[data-col="body"]').click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  const field = panel.getByRole("textbox", { name: "Note" });
  await expect(field).toHaveValue(body);
  // Nothing is cut off: the field is as tall as its text (it used to stop at 320 px with
  // the rest hidden), and the panel scrolls to reach it.
  const view = await field.evaluate((el) => ({
    height: el.clientHeight,
    hidden: el.scrollHeight - el.clientHeight,
  }));
  expect(view.height).toBeGreaterThan(600);
  expect(view.hidden).toBeLessThanOrEqual(1);

  // Typing at the end: the field grows and the panel scrolls with it.
  await field.click();
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`added line ${i}`);
  }
  const typed = await field.evaluate((el) => {
    const ta = el as HTMLTextAreaElement;
    let p = ta.parentElement;
    while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
    const box = (p as HTMLElement).getBoundingClientRect();
    return {
      hidden: ta.scrollHeight - ta.clientHeight,
      bottom: ta.getBoundingClientRect().bottom,
      viewBottom: box.top + (p as HTMLElement).clientHeight,
      caretAtEnd: ta.selectionEnd === ta.value.length,
    };
  });
  expect(typed.hidden).toBeLessThanOrEqual(1);
  expect(typed.caretAtEnd).toBe(true);
  expect(typed.bottom).toBeLessThanOrEqual(typed.viewBottom + 1);
  await page.keyboard.press("Enter");
  await expect(rowOf(page, id).locator('[data-col="body"]')).toContainText("added line 7");
});

test("Compact gives fixed rows again; Fit to content brings the tall rows back", async ({
  browser,
}) => {
  const { page, showId, ids } = await notesShow(browser, [
    { body: "short" },
    { body: SENTENCE.repeat(6).trim() },
  ]);
  const long = rowOf(page, ids[1] as string);
  await openNotes(page, showId);
  await expect.poll(async () => (await geometry(long)).height).toBeGreaterThan(80);

  const choose = async (name: string) => {
    await page.getByRole("button", { name: "Row height" }).click();
    await page.getByRole("radio", { name }).check();
    await page.keyboard.press("Escape");
  };
  await choose("Compact · 1 line");
  await expect(notesGrid(page)).toHaveAttribute("data-row-height", "compact");
  await expect.poll(async () => (await geometry(long)).height).toBe(30);
  const heights = await notesGrid(page)
    .getByTestId("grid-row")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight));
  expect(new Set(heights)).toEqual(new Set([30]));
  const g = await geometry(long);
  if (g.nextTop !== null) expect(g.nextTop).toBe(g.bottom);

  await choose("Fit to content");
  await expect(notesGrid(page)).toHaveAttribute("data-row-height", "auto");
  await expect.poll(async () => (await geometry(long)).height).toBeGreaterThan(80);
});

test("tall rows: the stuck group header names the group under it, and jumps land on the row", async ({
  browser,
}) => {
  const statuses = ["Open", "In progress", "Done"] as const;
  const notes: NoteSpec[] = [];
  for (const status of statuses)
    for (let i = 0; i < 12; i++)
      notes.push({ status, body: `${status} ${i}: ${SENTENCE.repeat([1, 6, 2, 12][i % 4] ?? 1)}` });
  const { page, showId, ids } = await notesShow(browser, notes);
  await openNotes(page, showId);
  const stuck = notesGrid(page).locator('[data-testid="group-header"][data-stuck]');
  const total = await scroller(page).evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(total).toBeGreaterThan(2000);
  for (const y of [0, 15, 400, 1100, 1900, Math.round(total / 2), total - 50]) {
    const top = await scrollGrid(page, y);
    await expect(stuck).toHaveCount(1);
    const layout = await stuck.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const first = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="grid-row"], [data-testid="group-header"]:not([data-stuck])',
        ),
      )
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        // The first item still showing below the stuck header (it may start above it).
        .filter((c) => c.r.bottom > box.bottom + 1)
        .sort((p, q) => p.r.top - q.r.top)[0];
      return {
        stuckGroup: el.dataset.groupId ?? null,
        below: first?.e.dataset.group ?? first?.e.dataset.groupId ?? null,
        belowIsHeader: first?.e.dataset.testid === "group-header",
      };
    });
    expect(layout.below, `something under the stuck header at ${top}`).not.toBeNull();
    if (!layout.belowIsHeader) expect(layout.stuckGroup, `at ${top}`).toBe(layout.below);
  }

  // Opening a far note from the URL scrolls it into view (estimated heights get corrected
  // as the rows around it are measured; it must still end up on screen).
  const far = ids[ids.length - 3] as string;
  await openNotes(page, showId, `?note=${far}`);
  const row = rowOf(page, far);
  await expect(row).toHaveAttribute("data-active-row", "true");
  await expect
    .poll(async () =>
      row.evaluate((el) => {
        const sc = el.closest<HTMLElement>('[data-testid="grid-scroll"]') as HTMLElement;
        const s = sc.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.top >= s.top + 34 && r.top < s.top + sc.clientHeight;
      }),
    )
    .toBe(true);

  // ↓ through tall rows keeps the active cell in view.
  await scrollGrid(page, 0);
  await notesGrid(page).getByTestId("grid-row").first().locator('[data-col="body"]').click();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown");
  const active = notesGrid(page).locator('[data-cell][data-active="true"]');
  await expect(active).toBeFocused();
  const inView = await active.evaluate((el) => {
    const sc = el.closest<HTMLElement>('[data-testid="grid-scroll"]') as HTMLElement;
    const s = sc.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= s.top + 34 && r.bottom <= s.top + sc.clientHeight + 1;
  });
  expect(inView).toBe(true);
});
