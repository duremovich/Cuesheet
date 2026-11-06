// One user, one browser, two tabs of the same show: the Cues tab in one, the Notes tab in
// the other, both editing. Tabs of one browser share cookies and localStorage (unlike the
// separate contexts in cue-grid.spec.ts), so this checks nothing per-browser leaks between
// them: each tab's store has its own clientId (its own echoes only), its own undo stack, and
// view drafts / collapsed groups are per view and synced between tabs on the same view.
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import {
  apiCreateShow,
  apiLogin,
  importExamples,
  recordId,
  trackErrors,
  uniqueName,
  waitForShowReady,
} from "./helpers";

let errors: string[] = [];
let context: BrowserContext | null = null;

test.beforeEach(() => {
  errors = [];
});

test.afterEach(async () => {
  expect(errors, "console errors").toEqual([]);
  await context?.close();
  context = null;
});

interface Snap {
  tables: {
    cues: { id: string; number: string | null; description: string | null }[];
    notes: { id: string; body: string | null; status: string | null }[];
    views: {
      id: string;
      table: string;
      owner_user_id: string | null;
      updated_at: number;
      config: Record<string, unknown>;
    }[];
  };
  joins: { noteCues: Record<string, string[]> };
}

async function snap(page: Page, showId: string): Promise<Snap> {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  expect(res.status()).toBe(200);
  return (await res.json()) as Snap;
}

/** A show with scenes and cues (no notes yet), and two tabs of one signed-in browser. */
async function twoTabs(browser: import("@playwright/test").Browser) {
  context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const a = await context.newPage();
  trackErrors(a, errors);
  await apiLogin(a);
  const showId = await apiCreateShow(a, uniqueName("Two tabs"));
  await importExamples(a, showId, [
    "Breakdown-Grid view.csv",
    "Content-Grid view.csv",
    "Cue List-Video Cue List View.csv",
  ]);
  const b = await context.newPage();
  trackErrors(b, errors);
  return { a, b, showId };
}

async function createNote(page: Page, showId: string, body: string, status = "Open") {
  const id = recordId();
  const ops: unknown[] = [{ op: "create", table: "notes", id, fields: { body, status } }];
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "e2e", ops },
  });
  expect(res.status(), await res.text()).toBe(200);
  return id;
}

const cueGrid = (page: Page) => page.getByRole("grid", { name: "Cue list" });
const notesGrid = (page: Page) => page.getByRole("grid", { name: "Notes" });
const rowByCue = (page: Page, cue: string) =>
  cueGrid(page)
    .getByTestId("grid-row")
    .filter({ has: page.locator('[data-col="number"]').getByText(cue, { exact: true }) });
const noteRow = (page: Page, id: string) => notesGrid(page).locator(`[data-row-id="${id}"]`);
const cellOf = (row: Locator, key: string) => row.locator(`[data-col="${key}"]`);
const presence = (page: Page) => page.getByTestId("presence");

async function cueId(page: Page, showId: string, number: string) {
  const c = (await snap(page, showId)).tables.cues.find((x) => x.number === number);
  if (!c) throw new Error(`no cue ${number}`);
  return c.id;
}

/** Opens the cue list at a cue, with its row panel on the Notes tab. */
async function openCueNotes(page: Page, showId: string, number: string) {
  const id = await cueId(page, showId, number);
  await page.goto(`/shows/${showId}/cues?cue=${id}`);
  await waitForShowReady(page);
  const cell = cellOf(rowByCue(page, number), "number");
  await expect(cell).toHaveAttribute("data-active", "true");
  await cell.click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(`Cue ${number}`);
  await panel.getByRole("tab", { name: /Notes/ }).click();
  return panel;
}

async function openNotes(page: Page, showId: string) {
  await page.goto(`/shows/${showId}/notes`);
  await waitForShowReady(page);
  await expect(notesGrid(page)).toBeVisible();
}

/** Types into a grid cell's editor (F2 keeps the text, the typing goes at the end). */
async function appendToCell(page: Page, cell: Locator, text: string) {
  await cell.click();
  await page.keyboard.press("F2");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/**
 * Replaces a grid cell's text (typing on a cell starts editing with that text). Commits
 * with Tab by default, which stays on the row (Enter moves down, and the row panel follows).
 */
async function typeIntoCell(page: Page, cell: Locator, text: string, commit = "Tab") {
  await cell.click();
  await page.keyboard.type(text);
  await page.keyboard.press(commit);
}

/** Picks one option in a cell's picker by typing its label. */
async function pick(page: Page, cell: Locator, label: string, multi = false) {
  await cell.click();
  await page.keyboard.type(label);
  await expect(page.getByRole("option", { name: label, exact: false }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  if (multi) await page.keyboard.press("Escape");
}

test("Cues in one tab, Notes in another: both edit, each sees the other's changes live", async ({
  browser,
}) => {
  const { a, b, showId } = await twoTabs(browser);
  const panel = await openCueNotes(a, showId, "14.20");
  await expect(panel.getByTestId("note")).toHaveCount(0);
  await openNotes(b, showId);
  await expect(presence(a)).toHaveAttribute("data-clients", "2");
  await expect(presence(b)).toHaveAttribute("data-clients", "2");

  // B adds a note on the Notes tab and links it to 14.20: A's cue panel lists it.
  const body = uniqueName("blend drifts");
  await b.getByRole("button", { name: "+ Add note" }).click();
  await b.keyboard.type(body);
  await b.keyboard.press("Enter");
  const bRow = notesGrid(b).getByTestId("grid-row").filter({ hasText: body });
  await expect(bRow).toBeVisible();
  const noteId = (await bRow.getAttribute("data-row-id")) as string;
  await pick(b, cellOf(bRow, "cues"), "14.20", true);
  await expect(cellOf(bRow, "cues")).toHaveText("14.20");
  const card = panel.getByTestId("note").filter({ hasText: body });
  await expect(card).toBeVisible();
  await expect(panel.getByRole("tab", { name: /Notes/ }).getByTitle("1 open")).toHaveText("1");

  // B edits its text and status: A follows.
  await appendToCell(b, cellOf(bRow, "body"), " (rev)");
  await expect(card).toContainText(`${body} (rev)`);
  const row = notesGrid(b)
    .getByTestId("grid-row")
    .filter({ hasText: `${body} (rev)` });
  await pick(b, cellOf(row, "status"), "In progress");
  await expect(cellOf(row, "status")).toHaveText("In progress");
  await expect(card).toHaveAttribute("data-status", "In progress");

  // A renumbers the cue and inserts one after it: B's chip and picker follow.
  await typeIntoCell(a, cellOf(rowByCue(a, "14.20"), "number"), "14.22");
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Cue 14.22");
  await expect(cellOf(row, "cues")).toHaveText("14.22");
  await cellOf(rowByCue(a, "14.22"), "number").click();
  await a.keyboard.press("ControlOrMeta+Shift+Enter");
  await a.keyboard.type("14.23");
  await a.keyboard.press("Enter");
  await expect(rowByCue(a, "14.23")).toBeVisible();
  // (The panel followed the new row; back to 14.22.)
  await cellOf(rowByCue(a, "14.22"), "description").click();
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("Cue 14.22");
  await pick(b, cellOf(row, "cues"), "14.23", true);
  await expect(cellOf(row, "cues")).toContainText("14.22");
  await expect(cellOf(row, "cues")).toContainText("14.23");

  // Both at once, on different records: both survive, in both tabs and on the server.
  await cellOf(rowByCue(a, "14.22"), "description").click();
  await cellOf(row, "body").click();
  const desc = uniqueName("cue from A");
  const body2 = uniqueName("note from B");
  await Promise.all([
    (async () => {
      await a.keyboard.type(desc);
      await a.keyboard.press("Tab");
    })(),
    (async () => {
      await b.keyboard.type(body2);
      await b.keyboard.press("Enter");
    })(),
  ]);
  await expect(cellOf(rowByCue(a, "14.22"), "description")).toHaveText(desc);
  await expect(panel.getByTestId("note").filter({ hasText: body2 })).toBeVisible();
  await expect(cellOf(noteRow(b, noteId), "body")).toHaveText(body2);
  await expect
    .poll(async () => {
      const s = await snap(a, showId);
      return [
        s.tables.cues.find((c) => c.number === "14.22")?.description,
        s.tables.notes.find((n) => n.id === noteId)?.body,
      ];
    })
    .toEqual([desc, body2]);

  // Both at once on the same field (the note's text: A in its card, B in the grid): the
  // write that lands last wins, both tabs settle on it, and History has both.
  const aCard = panel.locator(`[data-note-id="${noteId}"]`);
  const bRow2 = noteRow(b, noteId);
  const fromA = uniqueName("text from A");
  const fromB = uniqueName("text from B");
  await aCard.getByRole("button", { name: "Edit note" }).click();
  await aCard.getByRole("textbox", { name: "Edit note" }).fill(fromA);
  await cellOf(bRow2, "body").click();
  await b.keyboard.type(fromB);
  await Promise.all([a.keyboard.press("Enter"), b.keyboard.press("Enter")]);
  let final: string | null | undefined;
  await expect
    .poll(async () => {
      final = (await snap(a, showId)).tables.notes.find((n) => n.id === noteId)?.body;
      const shownA = await aCard.locator("p").textContent();
      const shownB = await cellOf(bRow2, "body").textContent();
      return (final === fromA || final === fromB) && shownA === final && shownB === final;
    })
    .toBe(true);
  await cellOf(bRow2, "status").click();
  await b.keyboard.press("Space");
  const bPanel = b.getByTestId("row-panel");
  await bPanel.getByRole("tab", { name: "History" }).click();
  const textChanges = bPanel
    .getByTestId("history")
    .getByRole("listitem", { name: /changed Note:/ });
  const to = (text: string) =>
    bPanel.getByTestId("history").getByRole("listitem", { name: new RegExp(`→ ${text}$`) });
  await expect(to(fromA)).toHaveCount(1);
  await expect(to(fromB)).toHaveCount(1);
  // Newest first: the last write is the one both tabs show.
  await expect(textChanges.first()).toHaveAccessibleName(new RegExp(`→ ${final}$`));

  // Closing one tab: the other keeps working, alone.
  await b.close();
  await expect(presence(a)).toHaveAttribute("data-clients", "1");
  await expect(a.getByTestId("presence-count")).toHaveText("1 client");
  const desc2 = uniqueName("after B closed");
  await typeIntoCell(a, cellOf(rowByCue(a, "14.25"), "description"), desc2);
  await expect
    .poll(async () => (await snap(a, showId)).tables.cues.find((c) => c.number === "14.25"))
    .toMatchObject({ description: desc2 });
});

test("undo in one tab undoes only that tab's own edits", async ({ browser }) => {
  const { a, b, showId } = await twoTabs(browser);
  const original = uniqueName("note as it was");
  const noteId = await createNote(a, showId, original);
  const before = (await snap(a, showId)).tables.cues.find((c) => c.number === "14.25");
  await a.goto(`/shows/${showId}/cues?cue=${before?.id}`);
  await waitForShowReady(a);
  await openNotes(b, showId);
  await expect(presence(a)).toHaveAttribute("data-clients", "2");

  const descCell = cellOf(rowByCue(a, "14.25"), "description");
  const bodyCell = cellOf(noteRow(b, noteId), "body");
  const desc = uniqueName("A's description");
  const body = uniqueName("B's note");
  await typeIntoCell(a, descCell, desc);
  await typeIntoCell(b, bodyCell, body);
  await expect(descCell).toHaveText(desc);
  await expect
    .poll(async () => (await snap(a, showId)).tables.notes.find((n) => n.id === noteId)?.body)
    .toBe(body);

  // A undoes: its description goes back; B's note (the newer edit) stays.
  await descCell.click();
  await a.keyboard.press("ControlOrMeta+z");
  await expect(descCell).toHaveText(before?.description ?? "");
  await expect
    .poll(async () => {
      const s = await snap(a, showId);
      return [
        s.tables.cues.find((c) => c.number === "14.25")?.description ?? null,
        s.tables.notes.find((n) => n.id === noteId)?.body,
      ];
    })
    .toEqual([before?.description ?? null, body]);
  await expect(bodyCell).toHaveText(body);

  // B undoes: only its note goes back (A's description stays undone, not redone).
  await bodyCell.click();
  await b.keyboard.press("ControlOrMeta+z");
  await expect(bodyCell).toHaveText(original);
  await expect
    .poll(async () => {
      const s = await snap(a, showId);
      return [
        s.tables.cues.find((c) => c.number === "14.25")?.description ?? null,
        s.tables.notes.find((n) => n.id === noteId)?.body,
      ];
    })
    .toEqual([before?.description ?? null, original]);
  await expect(descCell).toHaveText(before?.description ?? "");
});

// ---- View drafts (unsaved changes to the shared views) ----

/** The shared views' saved configs, by table. */
async function savedViews(page: Page, showId: string) {
  const views = (await snap(page, showId)).tables.views.filter((v) => v.owner_user_id === null);
  return Object.fromEntries(views.map((v) => [v.table, v.config]));
}

async function rowHeight(page: Page, name: string) {
  await page.getByRole("button", { name: "Row height" }).click();
  await page.getByRole("radio", { name }).check();
  await page.keyboard.press("Escape");
}

/** Widens a column by two keyboard steps on its resizer; returns the new width. */
async function widen(page: Page, grid: Locator, column: string) {
  const header = grid.getByRole("columnheader", { name: new RegExp(`^${column}`) });
  const before = (await header.boundingBox())?.width ?? 0;
  await grid.getByRole("separator", { name: `Resize ${column} column` }).focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await header.boundingBox())?.width ?? 0).toBeGreaterThan(before);
  return (await header.boundingBox())?.width ?? 0;
}

const columnWidth = async (grid: Locator, column: string) =>
  Math.round(
    (await grid.getByRole("columnheader", { name: new RegExp(`^${column}`) }).boundingBox())
      ?.width ?? 0,
  );

const groupHeader = (grid: Locator, title: string) =>
  grid.getByTestId("group-header").filter({ hasText: title });

async function openCueList(page: Page, showId: string) {
  await page.goto(`/shows/${showId}/cues`);
  await waitForShowReady(page);
  await expect(rowByCue(page, "0.10")).toBeVisible();
}

const SCENE = "100 Overture";

test("view drafts: the Cues tab's and the Notes tab's stay apart, across reloads", async ({
  browser,
}) => {
  const { a, b, showId } = await twoTabs(browser);
  await createNote(a, showId, uniqueName("open note"));
  await createNote(a, showId, uniqueName("busy note"), "In progress");
  const saved = await savedViews(a, showId);
  await openCueList(a, showId);
  await openNotes(b, showId);
  const noteWidth = await columnWidth(notesGrid(b), "Note");

  // A, on Cues: Compact rows, a wider Description, a scene collapsed.
  await rowHeight(a, "Compact · 1 line");
  const descWidth = Math.round(await widen(a, cueGrid(a), "Description"));
  await groupHeader(cueGrid(a), SCENE)
    .getByRole("button", { name: /^Collapse / })
    .click();
  await expect(a.getByTestId("view-dirty")).toBeVisible();
  await expect(cueGrid(a)).toHaveAttribute("data-row-height", "compact");

  // B's Notes view is untouched.
  await expect(notesGrid(b)).toHaveAttribute("data-row-height", "auto");
  await expect(b.getByTestId("view-dirty")).toHaveCount(0);
  expect(await columnWidth(notesGrid(b), "Note")).toBe(noteWidth);

  // B, on Notes: Tall rows, a wider Note, In progress collapsed. A's Cues view keeps its own.
  await rowHeight(b, "Tall · 3 lines");
  await widen(b, notesGrid(b), "Note");
  await groupHeader(notesGrid(b), "In progress")
    .getByRole("button", { name: /^Collapse / })
    .click();
  await expect(b.getByTestId("view-dirty")).toBeVisible();
  await expect(cueGrid(a)).toHaveAttribute("data-row-height", "compact");
  expect(await columnWidth(cueGrid(a), "Description")).toBe(descWidth);
  await expect(
    groupHeader(cueGrid(a), SCENE).getByRole("button", { name: /^Expand / }),
  ).toBeVisible();

  // Both survive a reload of both tabs, each on its own tab.
  await a.reload();
  await b.reload();
  await waitForShowReady(a);
  await waitForShowReady(b);
  await expect(cueGrid(a)).toHaveAttribute("data-row-height", "compact");
  await expect(notesGrid(b)).toHaveAttribute("data-row-height", "tall");
  await expect(a.getByTestId("view-dirty")).toBeVisible();
  await expect(b.getByTestId("view-dirty")).toBeVisible();
  await expect(
    groupHeader(cueGrid(a), SCENE).getByRole("button", { name: /^Expand / }),
  ).toBeVisible();
  await expect(
    groupHeader(notesGrid(b), "In progress").getByRole("button", { name: /^Expand / }),
  ).toBeVisible();

  // Discarding A's draft leaves B's alone; nothing reached the saved views.
  await a.getByRole("button", { name: "Discard" }).click();
  await expect(cueGrid(a)).toHaveAttribute("data-row-height", "auto");
  await expect(b.getByTestId("view-dirty")).toBeVisible();
  await expect(notesGrid(b)).toHaveAttribute("data-row-height", "tall");
  expect(await savedViews(a, showId)).toEqual(saved);
});

test("two tabs on the same view share one draft, live; saving in one saves both tabs' changes", async ({
  browser,
}) => {
  const { a, b, showId } = await twoTabs(browser);
  await openCueList(a, showId);
  await openCueList(b, showId);

  // A's change shows in B at once (one draft per view in this browser, like after a reload).
  await rowHeight(a, "Compact · 1 line");
  await expect(cueGrid(b)).toHaveAttribute("data-row-height", "compact");
  await expect(b.getByTestId("view-dirty")).toBeVisible();

  // B's change builds on it, and A sees B's.
  const width = Math.round(await widen(b, cueGrid(b), "Description"));
  await expect.poll(() => columnWidth(cueGrid(a), "Description")).toBe(width);
  await expect(cueGrid(a)).toHaveAttribute("data-row-height", "compact");

  // Collapsed groups follow too.
  await groupHeader(cueGrid(b), SCENE)
    .getByRole("button", { name: /^Collapse / })
    .click();
  await expect(
    groupHeader(cueGrid(a), SCENE).getByRole("button", { name: /^Expand / }),
  ).toBeVisible();

  // A saves: both changes are in the saved view, and neither tab has a draft left.
  await a.getByRole("button", { name: "Save view" }).click();
  await expect(a.getByTestId("view-dirty")).toHaveCount(0);
  await expect(b.getByTestId("view-dirty")).toHaveCount(0);
  await expect(b.getByTestId("view-conflict")).toHaveCount(0);
  await expect
    .poll(async () => {
      const cfg = (await savedViews(a, showId)).cues as {
        rowHeight?: string;
        fields?: { key: string; width?: number }[];
      };
      return [cfg.rowHeight, cfg.fields?.find((f) => f.key === "description")?.width];
    })
    .toEqual(["compact", expect.any(Number)]);
  await b.reload();
  await waitForShowReady(b);
  await expect(cueGrid(b)).toHaveAttribute("data-row-height", "compact");
  await expect(b.getByTestId("view-dirty")).toHaveCount(0);
  expect(await columnWidth(cueGrid(b), "Description")).toBe(width);
});
