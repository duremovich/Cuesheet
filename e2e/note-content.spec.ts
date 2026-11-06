// A note links several content items (notes.content, a multi-link like its cues): link two
// in the Notes grid and two in the note's row panel, see them in both places and on the
// content side, filter by one, unlink one, undo.
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { apiCreateShow, apiLogin, recordId, trackErrors, uniqueName } from "./helpers";

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
    await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  ).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

async function noteContent(page: Page, showId: string, noteId: string): Promise<string[]> {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  expect(res.status()).toBe(200);
  const snap = (await res.json()) as { joins: { noteContent: Record<string, string[]> } };
  return snap.joins.noteContent[noteId] ?? [];
}

const notesGrid = (page: Page) => page.getByRole("grid", { name: "Notes" });
const noteRow = (page: Page, body: string) =>
  notesGrid(page).getByTestId("grid-row").filter({ hasText: body });
const cellOf = (row: Locator, key: string) => row.locator(`[data-col="${key}"]`);

test("link several content items to a note in the grid and the panel; filter, unlink, undo", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Note content"));
  const [scene, k1, k2, k3, n1, n2, n3] = [
    recordId(),
    recordId(),
    recordId(),
    recordId(),
    recordId(),
    recordId(),
    recordId(),
  ];
  const [a, b, c] = ["101-001-ALPHA", "101-002-BRAVO", "101-003-CHARLIE"];
  const [inGrid, inPanel, other] = [
    uniqueName("grid note"),
    uniqueName("panel note"),
    uniqueName("other note"),
  ];
  const seeded = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "seed",
      ops: [
        { op: "create", table: "scenes", id: scene, fields: { number: "101", name: "Overture" } },
        ...[
          [k1, a],
          [k2, b],
          [k3, c],
        ].map(([id, name]) => ({
          op: "create",
          table: "content",
          id,
          fields: { name, scene_id: scene },
        })),
        ...[
          [n1, inGrid],
          [n2, inPanel],
          [n3, other],
        ].map(([id, body]) => ({
          op: "create",
          table: "notes",
          id,
          fields: { body, status: "Open" },
        })),
      ],
    },
  });
  expect(seeded.status(), await seeded.text()).toBe(200);

  // Grid: the Content cell is a multi-link picker; it stays open after each pick.
  await page.goto(`/shows/${showId}/notes?note=${n1}`);
  const row1 = noteRow(page, inGrid);
  const cell1 = cellOf(row1, "content");
  await cell1.click();
  await page.keyboard.type("ALPHA");
  const picker = page.getByTestId("record-picker");
  await expect(picker.getByRole("option", { name: new RegExp(a) })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(cell1).toContainText(a);
  await page.keyboard.type("BRAVO");
  await expect(picker.getByRole("option", { name: new RegExp(b) })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(cell1).toContainText(a);
  await expect(cell1).toContainText(b);
  await expect.poll(() => noteContent(page, showId, n1)).toEqual([k1, k2]);

  // Panel: the note's Fields tab has the same picker.
  const row2 = noteRow(page, inPanel);
  await cellOf(row2, "created_by").click();
  await page.keyboard.press("Space");
  const panel = page.getByTestId("row-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Set Content" }).click();
  const search = page.getByRole("combobox", { name: "Content: search" });
  await search.fill("CHARLIE");
  await expect(picker.getByRole("option", { name: new RegExp(c) })).toBeVisible();
  await page.keyboard.press("Enter");
  await search.fill("BRAVO");
  await expect(picker.getByRole("option", { name: new RegExp(b) })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Change Content" })).toBeVisible();
  await expect(panel).toContainText(c);
  await expect(panel).toContainText(b);
  const cell2 = cellOf(row2, "content");
  await expect(cell2).toContainText(c);
  await expect(cell2).toContainText(b);
  await expect.poll(() => noteContent(page, showId, n2)).toEqual([k3, k2]);
  // The links are in the note's history.
  await panel.getByRole("tab", { name: "History" }).click();
  await expect(panel.getByTestId("history")).toContainText(`added ${b} (Content)`);
  await expect(panel.getByTestId("history")).toContainText(`added ${c} (Content)`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Filter by one content item: notes linked to it (among others) match.
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  const filter = page.getByRole("dialog", { name: "Filter" });
  await filter.getByRole("button", { name: "+ Add filter" }).click();
  await filter.getByLabel("Filter 1 field").selectOption({ label: "Content" });
  await filter.getByLabel("Filter 1 operator").selectOption("is");
  await filter.getByLabel("Filter 1 value").selectOption({ label: b });
  await expect(row1).toBeVisible();
  await expect(row2).toBeVisible();
  await expect(noteRow(page, other)).toHaveCount(0);
  await filter.getByLabel("Filter 1 value").selectOption({ label: a });
  await expect(row1).toBeVisible();
  await expect(row2).toHaveCount(0);
  await filter.getByRole("button", { name: "Remove filter 1" }).click();
  // (The removed row's button had focus: put it back in the dialog so Escape closes it.)
  await filter.getByRole("button", { name: "+ Add filter" }).focus();
  await page.keyboard.press("Escape");
  await expect(filter).toHaveCount(0);
  await expect(noteRow(page, other)).toBeVisible();

  // Unlink one in the grid (its chip's ×), then undo brings it back.
  await cell1.click();
  await page.keyboard.press("Enter");
  await picker.getByRole("button", { name: `Remove ${a}` }).click();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(cell1).not.toContainText(a);
  await expect(cell1).toContainText(b);
  await expect.poll(() => noteContent(page, showId, n1)).toEqual([k2]);
  await expect(cell1).toBeFocused();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(cell1).toContainText(a);
  await expect.poll(() => noteContent(page, showId, n1)).toEqual([k1, k2]);

  // The content side: Bravo has both notes, Alpha one.
  await page.goto(`/shows/${showId}/content?content=${k2}`);
  const contentGrid = page.getByRole("grid", { name: "Content list" });
  const bravo = contentGrid.getByTestId("grid-row").filter({ hasText: b });
  await expect(cellOf(bravo, "notes")).toHaveText("2");
  const alpha = contentGrid.getByTestId("grid-row").filter({ hasText: a });
  await expect(cellOf(alpha, "notes")).toHaveText("1");
  await cellOf(bravo, "name").click();
  await page.keyboard.press("Space");
  const contentPanel = page.getByTestId("row-panel");
  await contentPanel.getByRole("tab", { name: /Notes/ }).click();
  const list = contentPanel.getByTestId("notes-panel");
  await expect(list.getByTestId("note").filter({ hasText: inGrid })).toBeVisible();
  await expect(list.getByTestId("note").filter({ hasText: inPanel })).toBeVisible();
  await expect(list.getByTestId("note")).toHaveCount(2);
});
