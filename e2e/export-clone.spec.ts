// CSV export, show templates and bulk edit (M5a: R26, R27, S8): export a filtered cue view
// and check the rows; save a show as a template and make a new show from it (structure,
// no cues); set a field on a selection of cues, then Undo.
import { readFileSync } from "node:fs";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import Papa from "papaparse";
import {
  apiCreateShow,
  apiLogin,
  importExamples,
  recordId,
  snapshot,
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

async function newPage(browser: Browser, viewport = { width: 1500, height: 1000 }) {
  const page = await (await browser.newContext({ viewport, acceptDownloads: true })).newPage();
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

const CUED = ["0.10", "0.30", "0.80"];
const grid = (page: Page) => page.getByRole("grid", { name: "Cue list" });
const rows = (page: Page) => grid(page).getByTestId("grid-row");
const rowByCue = (page: Page, cue: string) =>
  rows(page).filter({ has: page.locator('[data-col="number"]').getByText(cue, { exact: true }) });
const cellOf = (row: Locator, key: string) => row.locator(`[data-col="${key}"]`);
const panel = (page: Page, name: string) => page.getByRole("dialog", { name });

async function statusedShow(browser: Browser) {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Export"));
  await importExamples(page, showId);
  const cues = (await snapshot(page, showId)).tables.cues;
  await mutate(
    page,
    showId,
    cues.map((c) => ({
      op: "update",
      table: "cues",
      id: c.id,
      fields: { status: c.number && CUED.includes(c.number) ? "Cued" : "Rendered" },
    })),
  );
  await page.goto(`/shows/${showId}/cues`);
  await expect(rows(page).first()).toBeVisible();
  return { page, showId };
}

test("export a filtered cue view as CSV: the view's rows and columns", async ({ browser }) => {
  const { page, showId } = await statusedShow(browser);
  const filter = page.getByRole("button", { name: "Filter", exact: true });
  await filter.click();
  const d = panel(page, "Filter");
  await d.getByRole("button", { name: "+ Add filter" }).click();
  await d.getByLabel("Filter 1 field").selectOption({ label: "Status" });
  await d.getByLabel("Filter 1 operator").selectOption("is");
  await d.getByLabel("Filter 1 value").selectOption("Cued");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cue-count")).toHaveText("3 of 120 cues");

  await page.getByRole("button", { name: "Export CSV" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel(page, "Export CSV").getByRole("button", { name: "Download CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^Cues - All cues\.csv$/);
  const raw = readFileSync((await download.path()) as string, "utf8");
  // A byte order mark for Excel (on by default), CRLF line ends.
  expect(raw.startsWith("﻿")).toBe(true);
  expect(raw).toContain("\r\n");
  const parsed = Papa.parse<string[]>(raw.slice(1), { skipEmptyLines: true });
  const [header, ...data] = parsed.data;
  expect(header?.slice(0, 4)).toEqual(["Scene", "Cue", "Description", "Trigger"]);
  expect(data.map((r) => r[1])).toEqual(CUED);
  expect(data.every((r) => r[header?.indexOf("Status") ?? -1] === "Cued")).toBe(true);
  // Links as labels: the export's content matches the server's.
  const snap = await snapshot(page, showId);
  const cue = snap.tables.cues.find((c) => c.number === "0.10");
  const row = data.find((r) => r[1] === "0.10");
  expect(row?.[header?.indexOf("Description") ?? -1]).toBe(cue?.description ?? "");
});

test("set a field for a selection of cues, then Undo", async ({ browser }) => {
  const { page, showId } = await statusedShow(browser);
  const a = rowByCue(page, "0.10");
  const c = rowByCue(page, "0.80");
  await a.getByRole("rowheader").click();
  await c.getByRole("rowheader").click({ modifiers: ["Shift"] });
  await cellOf(c, "description").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set field for selection…" }).click();
  const dialog = page.getByTestId("bulk-edit");
  await expect(dialog).toContainText(/for \d+ rows/);
  await dialog.getByLabel("Field").selectOption({ label: "MSR" });
  const input = dialog.getByRole("textbox", { name: "MSR" });
  await input.fill("m. 12");
  await input.press("Enter");
  await dialog.getByRole("button", { name: /Apply to/ }).click();
  await expect(cellOf(a, "measure")).toHaveText("m. 12");
  await expect(cellOf(c, "measure")).toHaveText("m. 12");
  const selected = async () =>
    (await snapshot(page, showId)).tables.cues.filter(
      (x) => (x as { measure?: string | null }).measure === "m. 12",
    ).length;
  await expect.poll(selected).toBeGreaterThanOrEqual(3);
  await page.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
  await expect(cellOf(a, "measure")).toHaveText("");
  await expect.poll(selected).toBe(0);
});

test("save as template → new show from it: structure, no cues", async ({ browser }) => {
  const page = await newPage(browser);
  const name = uniqueName("Source");
  const showId = await apiCreateShow(page, name);
  await importExamples(page, showId, [
    "Breakdown-Grid view.csv",
    "Surfaces-Gallery.csv",
    "Cue List-Video Cue List View.csv",
  ]);
  const viewId = recordId();
  await mutate(page, showId, [
    {
      op: "create",
      table: "custom_fields",
      id: recordId(),
      fields: { table: "cues", key: "camera", label: "Camera", type: "text", options: {} },
    },
    {
      op: "create",
      table: "views",
      id: viewId,
      fields: {
        table: "cues",
        name: "Camera view",
        config: {
          filters: [],
          filterMode: "and",
          sorts: [{ key: "custom.camera", dir: "asc" }],
          sortMode: "live",
          group: { key: null },
          fields: [],
          rowHeight: "normal",
          frozenCount: 1,
          colorRules: [],
        },
      },
    },
  ]);
  await page.goto(`/shows/${showId}/cues`);
  await waitForShowReady(page);
  await page.getByRole("button", { name: "Show settings" }).click();
  const settings = page.getByRole("dialog", { name: "Show settings" });
  const template = uniqueName("Template");
  await settings.getByLabel("Template name").fill(template);
  await settings.getByRole("button", { name: "Save as template" }).click();
  await expect(page.getByTestId("toast")).toContainText(`Saved the template "${template}"`);

  await page.goto("/");
  const templates = page.getByTestId("templates");
  await expect(templates.getByRole("link", { name: template })).toBeVisible();
  await expect(page.getByTestId("show-list").getByRole("link", { name: template })).toHaveCount(0);
  const form = page.getByRole("form", { name: "New from template" });
  await form.getByLabel("Template").selectOption({ label: template });
  const fresh = uniqueName("From template");
  await form.getByLabel("Name of the copy").fill(fresh);
  await form.getByRole("button", { name: "New from template" }).click();
  await waitForShowReady(page);
  await expect(page.getByTestId("show-name")).toHaveText(fresh);
  await expect(page.getByTestId("cue-count")).toHaveText("0 cues");
  // Its views and custom field came along.
  await page.getByTestId("view-switcher").click();
  await expect(panel(page, "Views").getByRole("button", { name: "Camera view" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(grid(page).getByRole("columnheader", { name: "Camera" })).toBeVisible();
  await page.getByRole("link", { name: "Scenes", exact: true }).click();
  await expect(page.getByTestId("row-count")).toHaveText("28 scenes");
  await page.getByRole("link", { name: "Surfaces", exact: true }).click();
  await expect(page.getByTestId("row-count")).toHaveText("15 surfaces");
});
