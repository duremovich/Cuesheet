// Multi-row selection and bulk actions on the real tables: select notes by clicking cells
// (⌘/Ctrl+click, Shift+click), set their status from the selection bar, bulk-delete with
// the in-grid confirmation and Undo; the cue list's select-all, quick set and Backspace.
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  apiCreateShow,
  apiLogin,
  recordId,
  trackErrors,
  uniqueName,
  waitForShowReady,
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

async function mutate(page: Page, showId: string, ops: unknown[]) {
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "e2e", ops },
  });
  expect(res.status(), await res.text()).toBe(200);
}

type Row = { id: string; status: string | null; body?: string | null; number?: string | null };
async function rowsOf(page: Page, showId: string, table: "notes" | "cues"): Promise<Row[]> {
  const res = await page.request.get(`/api/shows/${showId}/snapshot`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { tables: Record<string, Row[]> }).tables[table] ?? [];
}

const bar = (page: Page) => page.getByTestId("selection-bar");
const confirmStrip = (page: Page) => page.getByRole("alertdialog");

test("notes: ⌘/Ctrl+click rows, set Done for all of them, bulk delete + Undo", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Multi notes"));
  const names = ["alpha", "bravo", "charlie", "delta", "echo"];
  const ids = names.map(() => recordId());
  await mutate(
    page,
    showId,
    names.map((body, i) => ({
      op: "create",
      table: "notes",
      id: ids[i],
      fields: { body, status: "Open" },
    })),
  );
  const [a, b, c, d, e] = ids as [string, string, string, string, string];
  await page.goto(`/shows/${showId}/notes`);
  await waitForShowReady(page);
  const grid = page.getByRole("grid", { name: "Notes" });
  const row = (id: string) => grid.locator(`[data-row-id="${id}"]`);
  const body = (id: string) => row(id).locator('[data-col="body"]');
  await expect(body(e)).toBeVisible();

  // Click one, ⌘/Ctrl+click two more: three rows selected, the bar replaces the toolbar.
  await body(a).click();
  await expect(bar(page)).toHaveCount(0);
  await body(c).click({ modifiers: ["ControlOrMeta"] });
  await body(d).click({ modifiers: ["ControlOrMeta"] });
  for (const id of [a, c, d]) await expect(row(id)).toHaveAttribute("data-selected", "true");
  await expect(row(b)).not.toHaveAttribute("data-selected", "true");
  await expect(bar(page).getByTestId("selection-count")).toHaveText("3 notes selected");

  // Status → Done on all three, in one batch.
  await bar(page).getByRole("button", { name: "Set Status for 3 notes" }).click();
  await page.getByRole("menuitem", { name: "Done", exact: true }).click();
  await expect
    .poll(async () =>
      (await rowsOf(page, showId, "notes"))
        .filter((n) => n.status === "Done")
        .map((n) => n.id)
        .sort(),
    )
    .toEqual([a, c, d].sort());
  // Escape (in the bar) clears the selection; the bar goes.
  await bar(page).getByRole("button", { name: "Clear selection" }).press("Escape");
  await expect(bar(page)).toHaveCount(0);

  // A Shift+click range over the two remaining open notes counts as selected rows too.
  await body(b).click();
  await body(e).click({ modifiers: ["Shift"] });
  await expect(bar(page).getByTestId("selection-count")).toHaveText("2 notes selected");
  await bar(page).getByRole("button", { name: "Delete 2 notes" }).click();
  // Notes can be restored, so the confirmation doesn't say "can't be undone".
  await expect(confirmStrip(page)).toHaveText(/Delete 2 rows\?/);
  await expect(confirmStrip(page)).not.toContainText("can't be undone");
  await confirmStrip(page).getByRole("button", { name: "Delete 2 rows" }).click();
  await expect(row(b)).toHaveCount(0);
  await expect(row(e)).toHaveCount(0);
  await expect
    .poll(async () => (await rowsOf(page, showId, "notes")).map((n) => n.id).sort())
    .toEqual([a, c, d].sort());

  const toast = page.getByTestId("toast").filter({ hasText: "Deleted 2 notes." });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(body(b)).toHaveText("bravo");
  await expect(body(e)).toHaveText("echo");
  await expect
    .poll(async () =>
      (await rowsOf(page, showId, "notes"))
        .filter((n) => n.id === b || n.id === e)
        .map((n) => `${n.body}:${n.status}`)
        .sort(),
    )
    .toEqual(["bravo:Open", "echo:Open"]);
});

test("cues: select all, quick-set status, Backspace deletes the selection after a confirm", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Multi cues"));
  const ids = [1, 2, 3, 4].map(() => recordId());
  await mutate(
    page,
    showId,
    ids.map((id, i) => ({
      op: "create",
      table: "cues",
      id,
      fields: { number: String(i + 1), description: `cue ${i + 1}` },
    })),
  );
  await page.goto(`/shows/${showId}/cues`);
  await waitForShowReady(page);
  const grid = page.getByRole("grid", { name: "Cue list" });
  const row = (id: string) => grid.locator(`[data-row-id="${id}"]`);
  const cell = (id: string) => row(id).locator('[data-col="description"]');
  await expect(cell(ids[3] as string)).toBeVisible();

  await grid.getByRole("checkbox", { name: "Select all rows" }).click();
  await expect(bar(page).getByTestId("selection-count")).toHaveText("4 cues selected");
  await bar(page).getByRole("button", { name: "Set Status for 4 cues" }).click();
  await page.getByRole("menuitem", { name: "Cued", exact: true }).click();
  await expect
    .poll(async () => (await rowsOf(page, showId, "cues")).map((q) => q.status))
    .toEqual(["Cued", "Cued", "Cued", "Cued"]);
  await expect(page.getByTestId("toast").filter({ hasText: "Set Status on 4 cues" })).toBeVisible();

  // Click cue 2, ⌘/Ctrl+click cue 4, Backspace: confirm, then both go.
  await cell(ids[1] as string).click();
  await cell(ids[3] as string).click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page).getByTestId("selection-count")).toHaveText("2 cues selected");
  await page.keyboard.press("Backspace");
  await expect(confirmStrip(page)).toContainText("Delete 2 rows? This can't be undone.");
  await confirmStrip(page).getByRole("button", { name: "Delete 2 rows" }).click();
  await expect(row(ids[1] as string)).toHaveCount(0);
  await expect
    .poll(async () => (await rowsOf(page, showId, "cues")).map((q) => q.number))
    .toEqual(["1", "3"]);
  await expect(bar(page)).toHaveCount(0);
});
