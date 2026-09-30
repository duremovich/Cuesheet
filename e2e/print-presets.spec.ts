// M5b: built-in print layouts (R21, S3) on the example show: notes by person (session
// filter, one person, distribute by email), notes by cue, content list, surface sheet.
// Light theme, rows present, and — rendered to PDF by Chromium — the running footer with
// "Page N of M". Plus the 390 px preview.
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  apiCreateShow,
  apiLogin,
  EXAMPLE_FILES,
  importExamples,
  openShow,
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

async function newPage(browser: Browser, viewport = { width: 1300, height: 900 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  pages.push(page);
  trackErrors(page, errors);
  await apiLogin(page);
  return page;
}

interface Snap {
  tables: {
    notes: { id: string; body: string | null }[];
    persons: { id: string; name: string | null }[];
  };
  joins: { noteCues: Record<string, string[]> };
}

/** The example show, with three notes in session "Tech 1" (two on cues, one not). */
async function exampleShow(page: Page) {
  const name = uniqueName("Presets");
  const showId = await apiCreateShow(page, name);
  await importExamples(page, showId, [...EXAMPLE_FILES, "Surfaces-Gallery.csv"]);
  const snap = (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as Snap;
  const onCue = snap.tables.notes.filter((n) => snap.joins.noteCues[n.id]?.length);
  const noCue = snap.tables.notes.filter((n) => !snap.joins.noteCues[n.id]?.length);
  const tech = [...onCue.slice(0, 2), ...noCue.slice(0, 1)];
  expect(tech).toHaveLength(3);
  const res = await page.request.post(`/api/shows/${showId}/mutate`, {
    data: {
      clientId: "e2e",
      ops: tech.map((n) => ({
        op: "update",
        table: "notes",
        id: n.id,
        fields: { session: "Tech 1" },
      })),
    },
  });
  expect(res.status()).toBe(200);
  return { showId, name, snap };
}

/** The text of a PDF (every page), through pdf.js. */
async function pdfText(pdf: Buffer): Promise<{ pages: number; text: string }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
  let text = "";
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    text += `${content.items.map((i) => ("str" in i ? i.str : "")).join(" ")}\n`;
  }
  return { pages: doc.numPages, text };
}

async function expectLight(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
}

test("notes by person and by cue: session filter, one person, page numbers in the PDF", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const page = await newPage(browser);
  const { showId, name } = await exampleShow(page);

  await page.goto(`/shows/${showId}/print/notes?preset=by-person`);
  const layout = page.getByTestId("print-notes");
  await expect(layout).toBeVisible();
  await expectLight(page);
  await expect(page.getByTestId("print-row").first()).toBeVisible();
  const all = await page.getByTestId("print-row").count();
  expect(all).toBeGreaterThan(10);
  await expect(page.getByTestId("print-group").last()).toContainText("Unassigned");
  await expect(page.getByTestId("print-notes-summary")).toContainText("All sessions");

  // One session.
  await page.getByLabel("Session").selectOption("Tech 1");
  await expect(page).toHaveURL(/session=Tech\+1/);
  await expect(page.getByTestId("print-notes-summary")).toContainText("Tech 1 · 3 notes");
  // Every row has a tick box; open notes first within a person.
  const firstGroup = page.getByTestId("print-group").first();
  await expect(firstGroup.getByRole("columnheader", { name: "Cue" })).toBeVisible();

  // The PDF: running header / footer and "Page N of M" in the margins.
  await page.emulateMedia({ media: "print" });
  const pdf = await pdfText(await page.pdf({ preferCSSPageSize: true }));
  expect(pdf.text).toContain(`Page 1 of ${pdf.pages}`);
  expect(pdf.text).toContain(`${name} · Tech 1`);
  expect(pdf.text).toContain("Notes by person");
  await page.emulateMedia({ media: "screen" });

  // Just one person; a page per person.
  const person = page.getByLabel("Person", { exact: true });
  const option = await person.locator("option").nth(1).textContent();
  await person.selectOption({ index: 1 });
  await expect(page.getByTestId("print-group")).toHaveCount(1);
  await expect(page.getByTestId("print-group")).toContainText(option ?? "");
  await person.selectOption({ index: 0 });
  await page.getByLabel("A page per person").check();
  await expect(page.getByTestId("print-group").nth(1)).toHaveAttribute("data-break", "");

  // By cue.
  await page.getByTestId("print-switch-layout").click();
  await expect(page.getByTestId("print-notes")).toContainText("Notes by cue");
  await expect(page.getByTestId("print-group").first()).toContainText("Q ");
  await expect(page.getByTestId("print-notes-summary")).toContainText("Tech 1");
});

test("distribute notes: an email per person, with the share link once there is one", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const { showId } = await exampleShow(page);
  await page.goto(`/shows/${showId}/print/notes?preset=by-person&session=Tech+1`);
  await page.getByTestId("distribute-notes").click();
  const panel = page.getByTestId("distribute-panel");
  await expect(panel.getByTestId("distribute-person").first()).toBeVisible();
  const mail = panel.getByTestId("distribute-person").first().getByRole("link", { name: /Email/ });
  await expect(mail).toHaveAttribute("href", /^mailto:.*subject=.*notes%20%E2%80%93%20Tech%201/);
  await panel.getByTestId("distribute-create-link").click();
  await expect(panel.getByTestId("distribute-share-link")).toContainText("/s/");
  await expect(mail).toHaveAttribute("href", /Printable%20list%3A%20http.*%2Fs%2F.*person%3D/);

  // The link from the email opens that person's notes, signed out.
  const href = (await mail.getAttribute("href")) ?? "";
  const body = decodeURIComponent(/body=([^&]*)/.exec(href)?.[1] ?? "");
  const link = /Printable list: (\S+)/.exec(body)?.[1] ?? "";
  const anon = await (await browser.newContext()).newPage();
  pages.push(anon);
  trackErrors(anon, errors);
  await anon.goto(link);
  await expect(anon.getByTestId("print-notes")).toBeVisible();
  await expect(anon.getByTestId("print-group")).toHaveCount(1);
  await expect(anon.getByTestId("print-notes-summary")).toContainText("Tech 1");
});

test("content list and surface sheet", async ({ browser }) => {
  const page = await newPage(browser);
  const { showId } = await exampleShow(page);

  await page.goto(`/shows/${showId}/print/content?preset=content`);
  await expect(page.getByTestId("print-content")).toBeVisible();
  await expectLight(page);
  await expect(page.getByTestId("print-row").first()).toBeVisible();
  expect(await page.getByTestId("print-row").count()).toBeGreaterThan(10);
  for (const h of ["Name", "Version", "Status", "Scene", "Cues", "Surfaces"]) {
    await expect(page.getByRole("columnheader", { name: h, exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole("cell", { name: "V02", exact: true }).first()).toBeVisible();

  await page.goto(`/shows/${showId}/print/surfaces?preset=surfaces`);
  await expect(page.getByTestId("print-surfaces")).toBeVisible();
  await expectLight(page);
  await expect(page.getByTestId("print-row")).toHaveCount(15);
  const sized = page.getByTestId("surface-size-ft").filter({ hasText: "'" }).first();
  await expect(sized).toBeVisible();
  await expect(page.getByTestId("surface-size-m").filter({ hasText: " m" }).first()).toBeVisible();

  // ⌘K has the layouts.
  await openShow(page, showId, "/cues");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search and commands" });
  await palette.getByRole("combobox").fill("Print surface sheet");
  await expect(palette.getByRole("option").first()).toHaveText("Print surface sheet");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("print-surfaces")).toBeVisible();
});

test("print presets fit a 390 px phone", async ({ browser }) => {
  const page = await newPage(browser, { width: 390, height: 844 });
  const { showId } = await exampleShow(page);
  for (const [path, id] of [
    ["notes?preset=by-person", "print-notes"],
    ["notes?preset=by-cue", "print-notes"],
    ["content?preset=content", "print-content"],
    ["surfaces?preset=surfaces", "print-surfaces"],
  ] as const) {
    await page.goto(`/shows/${showId}/print/${path}`);
    await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("print-row").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
