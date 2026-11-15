// "Add pages" (R20): a PDF script gets replacement pages after the fact. A generated
// 4-page PDF is imported, two cues are placed (one on a page that stays, one on a line the
// replacement page rewrites); then a replacement for page 3 (edited text) and a new page 3a
// come in as two files and page 4 is removed. The plan proposes Replace 3 / Insert after 3,
// the preview shows the revised pages, and the import goes through the normal path: the new
// version is current with labels 1, 2, 3, 3a, its original is the merged PDF, the cue on the
// unchanged page stays matched, the one on the rewritten line goes to Resolve, and the
// changed pages carry "Revised" tags (PDF and text views) and are listed in the navigator.
import { type Browser, expect, type Page, test } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { apiCreateShow, apiLogin, trackErrors, uniqueName } from "./helpers";

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

/** Script pages: a running header and the label on one line at the top, then the lines. */
async function scriptPdf(content: [string, string[]][]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (const [label, lines] of content) {
    const page = doc.addPage([612, 792]);
    page.drawText("RAILWAY - Rehearsal draft", { x: 72, y: 750, size: 9, font });
    page.drawText(label, { x: 530, y: 750, size: 10, font });
    let y = 690;
    for (const text of lines) {
      const caps = text === text.toUpperCase();
      page.drawText(text, { x: caps ? 280 : 150, y, size: 12, font });
      y -= 14;
    }
  }
  return Buffer.from(await doc.save());
}

const BASE: [string, string[]][] = [
  ["1", ["JOE", "Keep your head down and your case up."]],
  ["2", ["SUE", "Sweet Sue needs a sax and a bass player."]],
  ["3", ["JOE", "The train leaves at nine sharp tonight, so pack light."]],
  ["4", ["SUE", "Nobody is perfect, not even the band."]],
];

/** Selects `needle` in the PDF text layer (inside one text item) and releases the mouse. */
async function selectPdfText(page: Page, needle: string) {
  await page.evaluate((needle) => {
    const span = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="pdf-text"] [data-item]'),
    ).find((s) => (s.textContent ?? "").includes(needle));
    const node = span?.firstChild;
    if (!span || !node) throw new Error(`no text item with "${needle}"`);
    const at = (span.textContent ?? "").indexOf(needle);
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + needle.length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    span.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, needle);
}

async function goToPage(page: Page, label: string, physical: number) {
  await page.keyboard.press("g");
  await page.getByLabel("Go to page").fill(label);
  await page.keyboard.press("Enter");
  await expect(page.locator(`[data-testid="pdf-page"][data-page="${physical}"]`)).toHaveAttribute(
    "data-rendered",
    "true",
    { timeout: 20_000 },
  );
}

async function placeCue(page: Page, needle: string, number: string) {
  await selectPdfText(page, needle);
  const pop = page.getByTestId("place-popover");
  await pop.getByRole("button", { name: "New cue on this line" }).click();
  await pop.getByLabel("Cue number").fill(number);
  await pop.getByRole("button", { name: "Create cue" }).click();
  await expect(pop).toBeHidden();
  await expect(page.locator('[data-testid="pdf-marker"]', { hasText: number })).toBeVisible();
}

test("Add pages: replace, insert and remove pages of a PDF script; cues carried over; Revised tags", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Add pages"));

  // --- A 4-page PDF script with two cues ---
  await page.goto(`/shows/${showId}/script`);
  await page.getByTestId("script-file-input").setInputFiles({
    name: "railway.pdf",
    mimeType: "application/pdf",
    buffer: await scriptPdf(BASE),
  });
  await expect(page.getByTestId("import-preview")).toContainText("4 pages", { timeout: 20_000 });
  await page.getByLabel("Version label").fill("v1");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("pdf-view")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await goToPage(page, "2", 2);
  await placeCue(page, "a sax and a bass", "10");
  await goToPage(page, "3", 3);
  await placeCue(page, "nine sharp tonight", "20");
  // The first version has no predecessor: nothing is revised.
  await expect(page.getByTestId("revised-tag")).toHaveCount(0);

  // --- Add pages: a replacement 3 (rewritten line) and a new 3a, two files; remove 4 ---
  await page.getByRole("button", { name: "Add pages…" }).click();
  const panel = page.getByTestId("add-pages");
  await expect(panel.getByTestId("add-pages-input")).toBeAttached();
  await panel.getByTestId("add-pages-input").setInputFiles([
    {
      name: "new 3.pdf",
      mimeType: "application/pdf",
      buffer: await scriptPdf([["3", ["JOE", "We take the midnight bus instead, so pack light."]]]),
    },
    {
      name: "new 3a.pdf",
      mimeType: "application/pdf",
      buffer: await scriptPdf([["3a", ["SUE", "A whole new page about the bus depot."]]]),
    },
  ]);
  const rows = panel.getByTestId("add-pages-row");
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(rows.nth(0)).toHaveAttribute("data-label", "3");
  await expect(rows.nth(0)).toHaveAttribute("data-action", "Replace 3");
  await expect(rows.nth(1)).toHaveAttribute("data-label", "3a");
  await expect(rows.nth(1)).toHaveAttribute("data-action", "Insert after 3");
  await panel.getByLabel("Remove a page").selectOption({ label: "4" });
  await expect(panel.getByRole("button", { name: "Keep page 4" })).toBeVisible();
  await expect(panel.getByLabel("Version label")).toHaveValue("Pages 3, 3a (removed 4)");

  await panel.getByRole("button", { name: "Preview" }).click();
  const preview = panel.getByTestId("add-pages-preview");
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview.getByTestId("preview-pages")).toHaveText("4 pages");
  await expect(preview.getByTestId("add-pages-revised")).toHaveText(
    "Revised: 3, 3a · 1 page removed",
  );
  await preview.getByRole("button", { name: "Import", exact: true }).click();

  // --- The new version: current, re-anchored, its original the merged PDF ---
  await expect(page.getByTestId("import-report")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("add-pages")).toHaveCount(0);
  await expect(page.getByLabel("Script version")).toContainText(
    "Pages 3, 3a (removed 4) (current)",
  );
  await expect(page.getByTestId("report-counts")).toContainText("1 matched");
  await expect(page.getByTestId("open-resolve")).toHaveText("Resolve (1)");

  const snap = (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
    tables: {
      scripts: { current_version_id: string }[];
      script_versions: { id: string; label: string; attachment_id: string | null }[];
      attachments: { id: string; filename: string; content_type: string }[];
      cues: { id: string; number: string; page: string | null }[];
      cue_anchors: { cue_id: string; script_version_id: string; state: string }[];
    };
  };
  const current = snap.tables.scripts[0]?.current_version_id as string;
  const v2 = snap.tables.script_versions.find((v) => v.id === current);
  expect(v2?.label).toBe("Pages 3, 3a (removed 4)");
  const original = snap.tables.attachments.find((a) => a.id === v2?.attachment_id);
  expect(original?.content_type).toBe("application/pdf");
  expect(original?.filename).toBe("railway (Pages 3, 3a (removed 4)).pdf");
  const text = (await (
    await page.request.get(`/api/shows/${showId}/script/versions/${current}/text`)
  ).json()) as { pages: { label: string }[]; blocks: { text: string }[] };
  expect(text.pages.map((p) => p.label)).toEqual(["1", "2", "3", "3a"]);
  expect(text.blocks.map((b) => b.text)).toContain(
    "We take the midnight bus instead, so pack light.",
  );
  expect(text.blocks.map((b) => b.text)).not.toContain("Nobody is perfect, not even the band.");
  const stateOf = (number: string) => {
    const cue = snap.tables.cues.find((c) => c.number === number);
    return snap.tables.cue_anchors.find(
      (a) => a.cue_id === cue?.id && a.script_version_id === current,
    )?.state;
  };
  expect(stateOf("10")).toBe("matched");
  expect(["changed", "missing"]).toContain(stateOf("20"));

  // --- Revised: tags on 3 and 3a (PDF view), the navigator's Changed pages ---
  await expect(page.locator('[data-testid="pdf-page"][data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
    { timeout: 20_000 },
  );
  const changed = page.getByTestId("nav-changed-pages").getByRole("button");
  await expect(changed).toHaveText(["3", "3a"]);
  await expect(
    page.locator('[data-testid="pdf-page"][data-page="1"] [data-testid="revised-tag"]'),
  ).toHaveCount(0);
  await changed.filter({ hasText: "3a" }).click();
  await expect(page.getByTestId("current-page")).toHaveText("3a");
  await expect(page.getByTestId("header-revised")).toHaveText("Revised · Pages 3, 3a (removed 4)");
  const tag3a = page.locator('[data-testid="pdf-page"][data-page="4"] [data-testid="revised-tag"]');
  await expect(tag3a).toHaveText("Revised · Pages 3, 3a (removed 4)");
  await expect(
    page.locator('[data-testid="pdf-page"][data-page="3"] [data-testid="revised-tag"]'),
  ).toBeVisible();
  // The text view tags the same pages.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByTestId("script-reader")).toBeVisible();
  await expect(page.locator('[data-testid="script-page"][data-revised]')).toHaveCount(2);
  await expect(
    page.locator('[data-testid="script-page"][data-page="2"] [data-testid="revised-tag"]'),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "PDF pages" }).click();

  // --- The calling-script print marks the same pages ---
  await page.getByRole("link", { name: "Print calling script" }).click();
  await expect(page.getByTestId("print-pdf")).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("print-pdf-page")).toHaveCount(4);
  await expect(page.getByTestId("print-revised")).toHaveCount(2);
  await expect(page.getByTestId("print-pdf-page").nth(3).getByTestId("print-revised")).toHaveText(
    "Revised · Pages 3, 3a (removed 4)",
  );
  await page.goBack();
  await expect(page.getByTestId("pdf-view")).toBeVisible();

  // --- The rewritten line's cue goes to Resolve ---
  await page.getByTestId("open-resolve").click();
  await expect(page).toHaveURL(/resolve=/);
  await expect(page.getByText("nine sharp tonight").first()).toBeVisible();
});

test("Add pages: a version without a PDF original explains and offers a full import", async ({
  browser,
}) => {
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("Add pages txt"));
  await page.goto(`/shows/${showId}/script`);
  await page.getByTestId("script-file-input").setInputFiles({
    name: "script.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("--- page 1 ---\n\nJOE\nHello there.\n"),
  });
  await expect(page.getByTestId("import-preview")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("import-report")).toBeVisible();
  await page.getByRole("button", { name: "Add pages…" }).click();
  await expect(page.getByTestId("add-pages-unavailable")).toContainText(
    "Pages can only be added to a script imported from a PDF",
  );
  await page.getByRole("button", { name: "Import new version…" }).click();
  await expect(page.getByTestId("add-pages")).toHaveCount(0);
  await expect(page.getByTestId("script-import")).toBeVisible();
});
