// Saved views and conditional formatting (M2a: R16, R17): personal and shared views, the
// Filter / Color / Fields / Group panels, forks for viewers, filter holds on insert, 390 px.
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

async function newPage(browser: Browser, viewport = { width: 1400, height: 1000 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

/** After setup, cues "0.10", "0.30", "0.80" are Cued and the rest Rendered. */
const CUED = ["0.10", "0.30", "0.80"];

async function exampleShow(browser: Browser, viewport?: { width: number; height: number }) {
  const page = await newPage(browser, viewport);
  const showId = await apiCreateShow(page, uniqueName("Views"));
  await importExamples(page, showId);
  const cues = (await snapshot(page, showId)).tables.cues;
  const ops = cues.map((c) => ({
    op: "update",
    table: "cues",
    id: c.id,
    fields: { status: c.number && CUED.includes(c.number) ? "Cued" : "Rendered" },
  }));
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: { clientId: "e2e", ops },
  });
  expect(res.status(), await res.text()).toBe(200);
  await openCues(page, showId);
  return { page, showId };
}

async function openCues(page: Page, showId: string) {
  await page.goto(`/shows/${showId}/cues`);
  await expect(grid(page)).toBeVisible();
  await expect(grid(page).getByTestId("grid-row").first()).toBeVisible();
}

const grid = (page: Page) => page.getByRole("grid", { name: "Cue list" });
const rows = (page: Page) => grid(page).getByTestId("grid-row");
const rowByCue = (page: Page, cue: string) =>
  rows(page).filter({ has: page.locator('[data-col="number"]').getByText(cue, { exact: true }) });
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

/** Views menu → "Duplicate as my/shared view…" → name → Create. */
async function duplicateView(page: Page, name: string, shared = false) {
  await page.getByTestId("view-switcher").click();
  const menu = panel(page, "Views");
  await menu
    .getByRole("button", { name: shared ? "Duplicate as shared view…" : "Duplicate as my view…" })
    .click();
  await menu.getByRole("textbox").fill(name);
  await menu.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("current-view")).toHaveText(name);
}

async function addStatusFilter(page: Page, status: string) {
  const d = await openPanel(page, "Filter");
  await d.getByRole("button", { name: "+ Add filter" }).click();
  await d.getByLabel("Filter 1 field").selectOption({ label: "Status" });
  await d.getByLabel("Filter 1 operator").selectOption("is");
  await d.getByLabel("Filter 1 value").selectOption(status);
  await closePanel(page, "Filter");
}

/** The cue numbers of the rendered (non-section) rows. */
async function shownNumbers(page: Page) {
  return (await rows(page).locator('[data-col="number"]').allTextContents()).map((t) => t.trim());
}

test("a personal view with a filter and a color rule; hidden columns survive a reload", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  await expect(page.getByTestId("current-view")).toHaveText("All cues");
  await duplicateView(page, "Cued only");
  await expect(page).toHaveURL(/[?&]view=/);

  // Filter: status is Cued → only those cues.
  await addStatusFilter(page, "Cued");
  await expect(page.getByTestId("cue-count")).toHaveText("3 of 120 cues");
  await expect.poll(() => shownNumbers(page)).toEqual(CUED);
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toHaveText("Filter (1)");

  // Color: status is Cued → the row gets the green option background.
  const color = await openPanel(page, "Color");
  await color.getByRole("button", { name: "+ Add rule" }).click();
  await color.getByLabel("Rule 1 condition 1 field").selectOption({ label: "Status" });
  await color.getByLabel("Rule 1 condition 1 value").selectOption("Cued");
  await color.getByRole("radio", { name: "green" }).click();
  await closePanel(page, "Color");
  await expect(rowByCue(page, "0.30")).toHaveAttribute(
    "style",
    /--row-bg: var\(--option-green-bg\)/,
  );

  // Fields: hide SM call.
  await expect(grid(page).getByRole("columnheader", { name: "SM call" })).toBeVisible();
  const fields = await openPanel(page, "Fields");
  await fields.getByRole("checkbox", { name: "SM call" }).uncheck();
  await closePanel(page, "Fields");
  await expect(grid(page).getByRole("columnheader", { name: "SM call" })).toHaveCount(0);

  // Saved on the server (personal views save as you go).
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/shows/${showId}/snapshot`);
      const snap = (await res.json()) as {
        tables: {
          views: { name: string; config: { fields: { key: string; hidden?: boolean }[] } }[];
        };
      };
      const v = snap.tables.views.find((x) => x.name === "Cued only");
      return v?.config.fields.find((f) => f.key === "sm_call")?.hidden ?? false;
    })
    .toBe(true);

  await page.reload();
  await expect(page.getByTestId("current-view")).toHaveText("Cued only");
  await expect(grid(page).getByRole("columnheader", { name: "Description" })).toBeVisible();
  await expect(grid(page).getByRole("columnheader", { name: "SM call" })).toHaveCount(0);
  await expect.poll(() => shownNumbers(page)).toEqual(CUED);
  await expect(rowByCue(page, "0.10")).toHaveAttribute("style", /--option-green-bg/);

  // Back on the shared view everything shows again.
  await page.getByTestId("view-switcher").click();
  await panel(page, "Views")
    .getByRole("button", { name: /^All cues/ })
    .click();
  await expect(page.getByTestId("cue-count")).toHaveText("120 cues");
  await expect(grid(page).getByRole("columnheader", { name: "SM call" })).toBeVisible();
});

test("an inserted row under a filter stays until you leave it, then a toast offers to undo", async ({
  browser,
}) => {
  const { page } = await exampleShow(browser);
  await duplicateView(page, "Cued");
  await addStatusFilter(page, "Cued");
  await expect.poll(() => shownNumbers(page)).toEqual(CUED);

  await cellOf(rowByCue(page, "0.30"), "number").click();
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  // The new (unnumbered, no status) row is shown and focused though it doesn't match.
  await expect(rows(page)).toHaveCount(4);
  const fresh = rows(page).nth(2);
  await expect(cellOf(fresh, "number")).toBeFocused();
  await page.keyboard.type("0.35");
  await page.keyboard.press("Tab");
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // Leaving the row hides it and says why.
  await cellOf(rowByCue(page, "0.10"), "description").click();
  await expect(rows(page)).toHaveCount(3);
  const toast = page.getByTestId("toast").filter({ hasText: "Hidden by the current filter" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Undo filter" }).click();
  await expect(page.getByTestId("cue-count")).toHaveText("121 cues");
  await expect(rowByCue(page, "0.35")).toBeVisible();
});

test("the owner sets a shared default; another member opens the show on it", async ({
  browser,
}) => {
  const { page: owner, showId } = await exampleShow(browser);
  await duplicateView(owner, "Tech", true);
  await addStatusFilter(owner, "Cued");
  // An editor's change to a shared view is a draft until saved.
  await expect(owner.getByTestId("view-dirty")).toBeVisible();
  await owner.getByRole("button", { name: "Save view" }).click();
  await expect(owner.getByTestId("view-dirty")).toHaveCount(0);
  await owner.getByTestId("view-switcher").click();
  await panel(owner, "Views").getByRole("button", { name: "Set as default for everyone" }).click();
  await owner.getByTestId("view-switcher").click();
  await expect(panel(owner, "Views").getByRole("button", { name: "Tech · default" })).toBeVisible();
  await owner.keyboard.press("Escape");

  const { page: editor } = await addMember(browser, owner, showId, "editor");
  pages.push(editor);
  trackErrors(editor, errors);
  await openCues(editor, showId);
  await expect(editor.getByTestId("current-view")).toHaveText("Tech");
  await expect.poll(() => shownNumbers(editor)).toEqual(CUED);
});

test("a viewer changing a shared view gets their own copy; the shared one is unchanged", async ({
  browser,
}) => {
  const { page: owner, showId } = await exampleShow(browser);
  const { page: viewer } = await addMember(browser, owner, showId, "viewer");
  pages.push(viewer);
  trackErrors(viewer, errors);
  await openCues(viewer, showId);
  await expect(viewer.getByTestId("current-view")).toHaveText("All cues");

  const height = await openPanel(viewer, "Row height");
  await height.getByRole("radio", { name: "Tall" }).check();
  await expect(viewer.getByTestId("toast").filter({ hasText: "Saved as my view" })).toBeVisible();
  await expect(viewer.getByTestId("current-view")).toHaveText("All cues (mine)");
  await closePanel(viewer, "Row height");

  // Further changes go to the copy.
  await addStatusFilter(viewer, "Cued");
  await expect.poll(() => shownNumbers(viewer)).toEqual(CUED);

  const views = async () => {
    const res = await owner.request.get(`/api/shows/${showId}/snapshot`);
    return (
      (await res.json()) as {
        tables: {
          views: {
            table: string;
            name: string;
            owner_user_id: string | null;
            config: { rowHeight: string; filters: unknown[] };
          }[];
        };
      }
    ).tables.views.filter((v) => v.table === "cues");
  };
  await expect
    .poll(async () => (await views()).find((v) => v.owner_user_id !== null)?.config.filters.length)
    .toBe(1);
  const list = await views();
  const shared = list.find((v) => v.name === "All cues");
  expect(shared?.config).toMatchObject({ rowHeight: "normal", filters: [] });
  expect(list.find((v) => v.name === "All cues (mine)")?.config.rowHeight).toBe("tall");

  // The owner still sees the shared view as it was.
  await owner.reload();
  await expect(owner.getByTestId("current-view")).toHaveText("All cues");
  await expect(owner.getByTestId("cue-count")).toHaveText("120 cues");
});

test("notes can be grouped by assignee", async ({ browser }) => {
  const { page, showId } = await exampleShow(browser);
  await page.goto(`/shows/${showId}/notes`);
  const notes = page.getByRole("grid", { name: "Notes" });
  await expect(notes).toBeVisible();
  // Default: grouped by status.
  await expect(notes.getByTestId("group-header").first()).toBeVisible();
  const group = await openPanel(page, "Group");
  await group.getByRole("radio", { name: "Assignees" }).check();
  await closePanel(page, "Group");
  await expect(page.getByRole("button", { name: "Group", exact: true })).toHaveText(
    "Grouped by Assignees",
  );
  const headers = notes.getByTestId("group-header");
  await expect(headers.first()).toContainText("Unassigned");
  // Fold the (big) Unassigned group to see the people groups after it.
  await notes.getByRole("button", { name: "Collapse Unassigned" }).click();
  await expect.poll(async () => (await headers.allTextContents()).length).toBeGreaterThan(2);
  const titles = await headers.allTextContents();
  expect(titles.some((t) => /^(Open|In progress|Done)\b/.test(t.trim()))).toBe(false);
});

test.describe("at phone width", () => {
  test("view popovers are full-width sheets", async ({ browser }) => {
    const { page } = await exampleShow(browser, { width: 390, height: 844 });
    for (const name of ["Filter", "Color", "Fields"]) {
      const d = await openPanel(page, name);
      const box = await d.boundingBox();
      expect(box?.x).toBe(0);
      expect(box?.width).toBe(390);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(844, 0);
      await closePanel(page, name);
      await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
    }
    // Page never scrolls sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // Filtering works here too.
    await addStatusFilter(page, "Cued");
    await expect(page.getByTestId("cue-count")).toHaveText("3 of 120 cues");
  });
});
