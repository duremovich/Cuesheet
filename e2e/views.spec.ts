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
  // (A duplicate's cell also holds visually hidden "Warning: …" text.)
  return (await rows(page).locator('[data-col="number"]').allTextContents()).map((t) =>
    t.replace(/Warning:.*$/, "").trim(),
  );
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
  await expect(toast.getByRole("button", { name: "Keep shown" })).toBeVisible();
  await toast.getByRole("button", { name: "Clear filters" }).click();
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

  const views = async (as: Page = viewer) => {
    const res = await as.request.get(`/api/shows/${showId}/snapshot`);
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
  // Personal views are private: the owner's snapshot doesn't carry the viewer's copy.
  expect((await views(owner)).map((v) => v.name)).toEqual(["All cues"]);

  // The owner still sees the shared view as it was.
  await owner.reload();
  await expect(owner.getByTestId("current-view")).toHaveText("All cues");
  await expect(owner.getByTestId("cue-count")).toHaveText("120 cues");
});

test("a viewer's column widths and frozen columns are theirs, without copying the view", async ({
  browser,
}) => {
  const { page: owner, showId } = await exampleShow(browser);
  const { page: viewer } = await addMember(browser, owner, showId, "viewer");
  pages.push(viewer);
  trackErrors(viewer, errors);
  await openCues(viewer, showId);
  const header = grid(viewer).getByRole("columnheader", { name: /^Description/ });
  const before = (await header.boundingBox())?.width ?? 0;
  const resizer = grid(viewer).getByRole("separator", { name: "Resize Description column" });
  await resizer.focus();
  await viewer.keyboard.press("Shift+ArrowRight");
  await viewer.keyboard.press("Shift+ArrowRight");
  await expect
    .poll(async () => (await header.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before + 60);

  const fields = await openPanel(viewer, "Fields");
  await fields.getByLabel("Frozen columns").fill("2");
  await closePanel(viewer, "Fields");
  await expect(grid(viewer).getByRole("columnheader", { name: /^Description/ })).toHaveAttribute(
    "data-frozen",
    "true",
  );
  // Still the shared view, no copy.
  await expect(viewer.getByTestId("current-view")).toHaveText("All cues");
  await expect(viewer.getByTestId("toast").filter({ hasText: "Saved as my view" })).toHaveCount(0);

  await viewer.reload();
  await expect(viewer.getByTestId("current-view")).toHaveText("All cues");
  await expect
    .poll(async () => (await header.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before + 60);
  await expect(header).toHaveAttribute("data-frozen", "true");
  const snap = await owner.request.get(`/api/shows/${showId}/snapshot`);
  const views = ((await snap.json()) as { tables: { views: { table: string }[] } }).tables.views;
  expect(views.filter((v) => v.table === "cues")).toHaveLength(1);
  // The owner's layout is untouched.
  await owner.reload();
  await expect(grid(owner).getByRole("columnheader", { name: /^Description/ })).not.toHaveAttribute(
    "data-frozen",
    "true",
  );
});

test("an editor's unsaved changes to a shared view survive a reload until discarded", async ({
  browser,
}) => {
  const { page } = await exampleShow(browser);
  await addStatusFilter(page, "Cued");
  await expect(page.getByTestId("view-dirty")).toBeVisible();
  await expect(page.getByTestId("cue-count")).toHaveText("3 of 120 cues");
  await page.reload();
  await expect(page.getByTestId("view-dirty")).toBeVisible();
  await expect(page.getByTestId("cue-count")).toHaveText("3 of 120 cues");
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("view-dirty")).toHaveCount(0);
  await expect(page.getByTestId("cue-count")).toHaveText("120 cues");
  await page.reload();
  await expect(grid(page).getByTestId("grid-row").first()).toBeVisible();
  await expect(page.getByTestId("view-dirty")).toHaveCount(0);
  await expect(page.getByTestId("cue-count")).toHaveText("120 cues");
});

test("a link filter keeps working when the record is renamed; sorting by a hidden field", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  await duplicateView(page, "By scene");
  const d = await openPanel(page, "Filter");
  await d.getByRole("button", { name: "+ Add filter" }).click();
  await d.getByLabel("Filter 1 field").selectOption({ label: "Scene" });
  await d.getByLabel("Filter 1 operator").selectOption("is");
  const value = d.getByLabel("Filter 1 value");
  const sceneId = await value.locator("option").nth(1).getAttribute("value");
  await value.selectOption({ index: 1 });
  await closePanel(page, "Filter");
  const count = page.getByTestId("cue-count");
  await expect(count).toHaveText(/ of 120 cues$/);
  const filtered = await count.textContent();

  // Saved with the scene's id (and its label for display).
  await expect
    .poll(async () => {
      const saved = await page.request.get(`/api/shows/${showId}/snapshot`);
      const view = (
        (await saved.json()) as {
          tables: { views: { name: string; config: { filters: { value: unknown }[] } }[] };
        }
      ).tables.views.find((v) => v.name === "By scene");
      return view?.config.filters[0]?.value;
    })
    .toBe(sceneId);

  // Rename the scene elsewhere (the API): the filter holds the id, so nothing changes.
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: [{ op: "update", table: "scenes", id: sceneId, fields: { name: "Renamed" } }],
    },
  });
  expect(res.status()).toBe(200);
  await page.reload();
  await expect(count).toHaveText(filtered ?? "");

  // Sort by cue number descending, then hide the Cue column: still sorted by it.
  const sort = await openPanel(page, "Sort");
  await sort.getByRole("button", { name: "+ Add sort" }).click();
  await sort.getByLabel("Sort 1 field").selectOption({ label: "Cue" });
  await sort.getByLabel("Sort 1 direction").selectOption("desc");
  await closePanel(page, "Sort");
  const numbersBefore = await shownNumbers(page);
  const numeric = numbersBefore.map(Number.parseFloat);
  expect(numeric).toEqual([...numeric].sort((a, b) => b - a));
  const descBefore = await rows(page).locator('[data-col="description"]').allTextContents();
  const fields = await openPanel(page, "Fields");
  await fields.getByRole("checkbox", { name: "Cue", exact: true }).uncheck();
  await closePanel(page, "Fields");
  await expect(grid(page).getByRole("columnheader", { name: /^Cue\b/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sort", exact: true })).toHaveText(
    "Sorted by Cue ↓",
  );
  // Same rows in the same (descending cue number) order with the Cue column hidden.
  await expect
    .poll(() => rows(page).locator('[data-col="description"]').allTextContents())
    .toEqual(descBefore);
  await expect
    .poll(async () => {
      const saved = await page.request.get(`/api/shows/${showId}/snapshot`);
      const v = (
        (await saved.json()) as {
          tables: {
            views: {
              name: string;
              config: { sorts: unknown[]; fields: { key: string; hidden?: boolean }[] };
            }[];
          };
        }
      ).tables.views.find((x) => x.name === "By scene");
      return [v?.config.sorts.length, v?.config.fields.find((f) => f.key === "number")?.hidden];
    })
    .toEqual([1, true]);
  await page.reload();
  await expect
    .poll(() => rows(page).locator('[data-col="description"]').allTextContents())
    .toEqual(descBefore);
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

  for (const theme of ["dark", "light"] as const) {
    test(`checkboxes and radios sit on one line with their labels (${theme})`, async ({
      browser,
    }) => {
      const { page } = await exampleShow(browser, { width: 390, height: 844 });
      await page.evaluate((t) => localStorage.setItem("cuesheet.theme", t), theme);
      await page.reload();
      await expect(grid(page)).toBeVisible();
      const heights = async (name: string) => {
        const d = await openPanel(page, name);
        const hs = await d
          .locator("label:has(input[type=checkbox]), label:has(input[type=radio])")
          .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
        await closePanel(page, name);
        return hs;
      };
      for (const name of ["Fields", "Group", "Row height"]) {
        const hs = await heights(name);
        expect(hs.length).toBeGreaterThan(1);
        expect(Math.max(...hs)).toBeLessThan(32);
      }
      // The frozen-columns control comes before the field list on phones.
      const fields = await openPanel(page, "Fields");
      const frozen = await fields.getByLabel("Frozen columns").boundingBox();
      const firstField = await fields.getByRole("checkbox").first().boundingBox();
      expect(frozen?.y ?? 0).toBeLessThan(firstField?.y ?? 0);
    });
  }
});

test("a filter doesn't change ghost numbers or hide duplicates; Enter commits then hides", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  // Only 0.10, 0.80 and one of the two 51.50s are Cued.
  const cues = (await snapshot(page, showId)).tables.cues;
  const byNumber = (n: string) => cues.filter((c) => c.number === n);
  const [dup] = byNumber("51.50");
  const ops = [
    ...byNumber("0.30").map((c) => ({
      op: "update",
      table: "cues",
      id: c.id,
      fields: { status: "Rendered" },
    })),
    { op: "update", table: "cues", id: dup?.id, fields: { status: "Cued" } },
  ];
  expect(
    (
      await page.request.post(`/api/shows/${showId}/mutate`, { data: { clientId: "e2e", ops } })
    ).status(),
  ).toBe(200);
  await page.reload();
  await duplicateView(page, "Cued");
  await addStatusFilter(page, "Cued");
  await expect.poll(() => shownNumbers(page)).toEqual(["0.10", "0.80", "51.50"]);
  // The other 51.50 is filtered out, but this one still warns.
  await expect(cellOf(rowByCue(page, "51.50"), "number")).toHaveAttribute("data-warning", "true");

  // Insert below 0.10: the ghost is between 0.10 and 0.30 (the next cue in the show), not
  // the next shown one (0.80).
  await cellOf(rowByCue(page, "0.10"), "number").click();
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  const fresh = rows(page).nth(1);
  await expect(cellOf(fresh, "number")).toBeFocused();
  await expect(cellOf(fresh, "number").getByTestId("ghost")).toHaveText("0.20");

  // Enter commits and moves down: the new (not Cued) cue is hidden, with the toast.
  await page.keyboard.type("0.20");
  await page.keyboard.press("Enter");
  const toast = page.getByTestId("toast").filter({ hasText: "Hidden by the current filter" });
  await expect(toast).toBeVisible();
  await expect.poll(() => shownNumbers(page)).toEqual(["0.10", "0.80", "51.50"]);
  await expect(cellOf(rowByCue(page, "0.80"), "number")).toBeFocused();
  await expect
    .poll(async () => (await snapshot(page, showId)).tables.cues.some((c) => c.number === "0.20"))
    .toBe(true);
  // "Keep shown" brings it back and puts you in it.
  await toast.getByRole("button", { name: "Keep shown" }).click();
  await expect(rowByCue(page, "0.20")).toBeVisible();

  // A remote change that unmatches the row you're editing: it stays until Enter moves you on.
  await cellOf(rowByCue(page, "0.80"), "description").click();
  await page.keyboard.type(" (edited)");
  const eighty = cues.find((c) => c.number === "0.80");
  const remote = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "remote",
      ops: [{ op: "update", table: "cues", id: eighty?.id, fields: { status: "Rendered" } }],
    },
  });
  expect(remote.status()).toBe(200);
  await expect(cellOf(rowByCue(page, "0.80"), "status")).toHaveText("Rendered");
  await expect(rowByCue(page, "0.80")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(rowByCue(page, "0.80")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await snapshot(page, showId)).tables.cues.find((c) => c.id === eighty?.id)?.description,
    )
    .toMatch(/\(edited\)$/);
});

test("⌘K / ?cue= to a row the filter hides shows it with Keep shown / Clear filters; stale ?view", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  await duplicateView(page, "Cued");
  await addStatusFilter(page, "Cued");
  await expect.poll(() => shownNumbers(page)).toEqual(CUED);
  const hidden = (await snapshot(page, showId)).tables.cues.find((c) => c.number === "14.20");
  const url = new URL(page.url());
  url.searchParams.set("cue", hidden?.id ?? "");
  await page.goto(url.toString());
  await expect(cellOf(rowByCue(page, "14.20"), "number")).toHaveAttribute("data-active", "true");
  const toast = page.getByTestId("toast").filter({ hasText: "Hidden by the current filter" });
  await expect(toast.getByRole("button", { name: "Keep shown" })).toBeVisible();
  // Leaving it hides it again.
  await cellOf(rowByCue(page, "0.10"), "description").click();
  await expect(rowByCue(page, "14.20")).toHaveCount(0);
  await toast.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId("cue-count")).toHaveText("120 cues");

  // A ?view= you can't see (deleted, someone else's) is dropped with a note.
  await page.goto(`/shows/${showId}/cues?view=0190a1b2-0000-7000-8000-000000000099`);
  await expect(
    page.getByTestId("toast").filter({ hasText: "That view no longer exists." }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/view=/);
});

test("a shared view saved by someone else while you have a draft: rebase, then save both", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  await addStatusFilter(page, "Cued");
  await expect(page.getByTestId("view-dirty")).toBeVisible();
  // Someone else changes the shared view meanwhile.
  const snap = (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
    tables: {
      views: { id: string; table: string; name: string; config: Record<string, unknown> }[];
    };
  };
  const shared = snap.tables.views.find((v) => v.name === "All cues");
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "other",
      ops: [
        {
          op: "update",
          table: "views",
          id: shared?.id,
          fields: { config: { ...shared?.config, rowHeight: "tall" } },
        },
      ],
    },
  });
  expect(res.status()).toBe(200);
  await expect(page.getByTestId("view-conflict")).toHaveText("This view changed since your draft");
  await expect(page.getByRole("button", { name: "Save view" })).toHaveCount(0);
  // Still there after a reload.
  await page.reload();
  await expect(page.getByTestId("view-conflict")).toBeVisible();
  await page.getByRole("button", { name: "Rebase" }).click();
  await expect(page.getByTestId("view-dirty")).toBeVisible();
  await page.getByRole("button", { name: "Save view" }).click();
  await expect
    .poll(async () => {
      const s = (await (
        await page.request.get(`/api/shows/${showId}/snapshot`)
      ).json()) as typeof snap;
      const v = s.tables.views.find((x) => x.id === shared?.id);
      return [v?.config.rowHeight, (v?.config.filters as unknown[] | undefined)?.length];
    })
    .toEqual(["tall", 1]);
  await expect(page.getByTestId("view-dirty")).toHaveCount(0);
});

test("a viewer's further changes reuse their copy of the shared view", async ({ browser }) => {
  const { page: owner, showId } = await exampleShow(browser);
  const { page: viewer } = await addMember(browser, owner, showId, "viewer");
  pages.push(viewer);
  trackErrors(viewer, errors);
  await openCues(viewer, showId);
  const height = await openPanel(viewer, "Row height");
  await height.getByRole("radio", { name: "Tall" }).check();
  await closePanel(viewer, "Row height");
  await expect(viewer.getByTestId("current-view")).toHaveText("All cues (mine)");
  // Back on the shared view, another change goes to the same copy.
  await viewer.getByTestId("view-switcher").click();
  await panel(viewer, "Views")
    .getByRole("button", { name: /^All cues · default/ })
    .click();
  await expect(viewer.getByTestId("current-view")).toHaveText("All cues");
  const again = await openPanel(viewer, "Row height");
  await again.getByRole("radio", { name: "Compact" }).check();
  await closePanel(viewer, "Row height");
  await expect(viewer.getByTestId("current-view")).toHaveText("All cues (mine)");
  await expect
    .poll(async () => {
      const s = (await (await viewer.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
        tables: {
          views: { table: string; owner_user_id: string | null; config: { rowHeight: string } }[];
        };
      };
      const mine = s.tables.views.filter((v) => v.table === "cues" && v.owner_user_id !== null);
      return mine.map((v) => v.config.rowHeight);
    })
    .toEqual(["compact"]);
});

test("popover focus: first safe control, new filter row, wrap-around, Escape; ⌘K switches views", async ({
  browser,
}) => {
  const { page, showId } = await exampleShow(browser);
  const d = await openPanel(page, "Filter");
  await expect(d.getByRole("button", { name: "+ Add filter" })).toBeFocused();
  await d.getByRole("button", { name: "+ Add filter" }).click();
  await expect(d.getByLabel("Filter 1 field")).toBeFocused();
  // Reopening: the first control isn't the × that removes the filter.
  await closePanel(page, "Filter");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await expect(d.getByLabel("Filter 1 field")).toBeFocused();
  // Shift+Tab from the first control wraps to the last, Tab from there back to the first.
  await page.keyboard.press("Shift+Tab");
  const inside = () =>
    page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Filter"]'));
  expect(await inside()).toBe(true);
  await page.keyboard.press("Tab");
  expect(await inside()).toBe(true);
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Filter", exact: true })).toBeFocused();

  // ⌘K: "Switch view: …" for this tab's views.
  await duplicateView(page, "Tech notes");
  await page.getByTestId("view-switcher").click();
  await panel(page, "Views")
    .getByRole("button", { name: /^All cues/ })
    .click();
  await expect(page.getByTestId("current-view")).toHaveText("All cues");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await palette.getByRole("combobox").fill("switch view");
  await palette.getByRole("option", { name: /Switch view: Tech notes/ }).click();
  await expect(page.getByTestId("current-view")).toHaveText("Tech notes");
  expect(new URL(page.url()).pathname).toBe(`/shows/${showId}/cues`);
});
