// The PDF page view of the script (R20): a text PDF imported through the UI opens on its
// original pages (pdf.js canvas + text layer); selecting text in the PDF places a cue
// (number in the margin, quote underlined where the words are), the number goes to the
// cue list, "Show in script" comes back to the page and highlights it, a click in the
// margin places a positional cue with its label on the leader, and the print layout
// draws the same marks on the PDF's pages. The fixture is generated here (pdf-lib).
import { type Browser, expect, type Page, test } from "@playwright/test";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
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

/** Two pages with printed labels 12 and 13, a running header, speeches and directions. */
async function railwayPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const content: [string, [number, string, PDFFont?][]][] = [
    [
      "12",
      [
        [260, "ACT ONE"],
        [100, "A railway platform. Night. Steam drifts", italic],
        [100, "across the tracks.", italic],
        [0, ""],
        [280, "JOE"],
        [150, "Keep your head down and your case up,"],
        [150, "we are nearly at the train."],
      ],
    ],
    [
      "13",
      [
        [280, "SUE"],
        [150, "Sweet Sue needs a sax and a bass."],
        [0, ""],
        [100, "The train pulls out.", italic],
      ],
    ],
  ];
  for (const [label, lines] of content) {
    const page = doc.addPage([612, 792]);
    page.drawText("RAILWAY - Rehearsal draft", { x: 72, y: 750, size: 9, font: roman });
    page.drawText(label, { x: 530, y: 750, size: 10, font: roman });
    let y = 690;
    for (const [x, text, font] of lines) {
      if (text) page.drawText(text, { x, y, size: 12, font: font ?? roman });
      y -= 14;
    }
  }
  return Buffer.from(await doc.save());
}

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

/** The on-screen box of `needle` in the text layer. */
async function textBox(page: Page, needle: string) {
  return page.evaluate((needle) => {
    const span = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="pdf-text"] [data-item]'),
    ).find((s) => (s.textContent ?? "").includes(needle));
    const node = span?.firstChild;
    if (!span || !node) throw new Error(`no text item with "${needle}"`);
    const at = (span.textContent ?? "").indexOf(needle);
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, at + needle.length);
    const b = r.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, needle);
}

test("script PDF view: import, place by selection, number → list → back, positional label, print", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await newPage(browser);
  const showId = await apiCreateShow(page, uniqueName("PDF script"));

  // --- Import a PDF: the PDF page view is the default ---
  await page.goto(`/shows/${showId}/script`);
  await page.getByTestId("script-file-input").setInputFiles({
    name: "railway.pdf",
    mimeType: "application/pdf",
    buffer: await railwayPdf(),
  });
  await expect(page.getByTestId("import-preview")).toContainText("2 pages", { timeout: 20_000 });
  await page.getByLabel("Version label").fill("v1");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByTestId("import-report")).toBeVisible();
  await expect(page.getByTestId("pdf-view")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDF pages" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-testid="pdf-page"][data-page="1"]')).toHaveAttribute(
    "data-rendered",
    "true",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("current-page")).toHaveText("12");
  // The page's text is selectable text (pdf.js text layer), page label included.
  await expect(page.locator('[data-page="1"] [data-testid="pdf-text"]')).toContainText(
    "Keep your head down",
  );

  // --- Select text in the PDF → a new Line cue ---
  await selectPdfText(page, "case up");
  const pop = page.getByTestId("place-popover");
  await pop.getByRole("button", { name: "New cue on this line" }).click();
  await expect(pop.getByLabel("Trigger value")).toHaveValue("case up");
  await pop.getByLabel("Cue number").fill("5.10");
  await pop.getByLabel("Description").fill("Train whistle");
  await pop.getByRole("button", { name: "Create cue" }).click();
  await expect(pop).toBeHidden();
  const m510 = page.locator('[data-testid="pdf-marker"]', { hasText: "5.10" });
  await expect(m510).toBeVisible();
  const cueId = (await m510.getAttribute("data-cue")) as string;
  const anchorId = (await m510.getAttribute("data-anchor")) as string;
  // The quote is underlined right under the selected words.
  const underline = page.locator(`[data-testid="pdf-underline"][data-anchor="${anchorId}"]`);
  await expect(underline).toHaveCount(1);
  const words = await textBox(page, "case up");
  const line = await underline.boundingBox();
  if (!line) throw new Error("no underline");
  expect(Math.abs(line.x - words.x)).toBeLessThan(4);
  expect(Math.abs(line.x + line.width - (words.x + words.width))).toBeLessThan(6);
  expect(line.y).toBeGreaterThan(words.y + words.height * 0.6);
  expect(line.y).toBeLessThan(words.y + words.height * 1.4);
  // The anchor is a normal one: the text view shows it too.
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByTestId("script-reader")).toBeVisible();
  await expect(page.locator(`[data-testid="script-marker"][data-cue="${cueId}"]`)).toContainText(
    "Q 5.10",
  );
  await expect(page.locator("[data-quote]", { hasText: "case up" })).toBeVisible();
  await page.getByRole("button", { name: "PDF pages" }).click();
  await expect(page.getByTestId("pdf-view")).toBeVisible();

  // --- The number goes to the cue list; "Show in script" comes back ---
  await page
    .locator(`[data-testid="pdf-marker"][data-cue="${cueId}"]`)
    .getByTestId("pdf-cue-number")
    .click();
  await expect(page).toHaveURL(new RegExp(`/cues\\?cue=${cueId}`));
  await page.getByRole("gridcell", { name: "5.10" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show in script" }).click();
  await expect(page).toHaveURL(new RegExp(`/script\\?cue=${cueId}`));
  await expect(page.locator(`[data-testid="pdf-marker"][data-cue="${cueId}"]`)).toHaveAttribute(
    "data-flash",
    "true",
  );
  await expect(page.locator(`g[data-anchor="${anchorId}"]`)).toHaveAttribute("data-hot", "true");

  // --- A click in the margin beside a direction: a positional cue with its label ---
  await page.keyboard.press("g");
  await page.getByLabel("Go to page").fill("13");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="pdf-page"][data-page="2"]')).toHaveAttribute(
    "data-rendered",
    "true",
  );
  await expect(page.getByTestId("current-page")).toHaveText("13");
  const direction = await textBox(page, "The train pulls out.");
  const margin = await page.locator('[data-page="2"] [data-testid="pdf-margin"]').boundingBox();
  if (!margin) throw new Error("no margin");
  await page.mouse.click(margin.x + 40, direction.y + direction.height / 2);
  await expect(pop).toBeVisible();
  await pop.getByLabel("Trigger type").selectOption("Visual");
  await pop.getByRole("button", { name: "New cue here" }).click();
  await pop.getByLabel("Cue number").fill("5.20");
  await pop.getByLabel("Description").fill("TRAIN OUT: the carriages slide off");
  await pop.getByRole("button", { name: "Create cue" }).click();
  await expect(pop).toBeHidden();
  const m520 = page.locator('[data-testid="pdf-marker"]', { hasText: "5.20" });
  await expect(m520).toHaveAttribute("data-positional", "true");
  await expect(m520.getByTestId("pdf-marker-label")).toHaveText("VISUAL · TRAIN OUT");
  const a520 = (await m520.getAttribute("data-anchor")) as string;
  await expect(page.locator(`g[data-anchor="${a520}"] [data-testid="pdf-tick"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="pdf-underline"][data-anchor="${a520}"]`)).toHaveCount(0);
  // The anchor is on that line: the server derived the cue's page from it.
  const snap = (await (await page.request.get(`/api/shows/${showId}/snapshot`)).json()) as {
    tables: { cues: { number: string; page: string | null }[] };
  };
  expect(snap.tables.cues.find((c) => c.number === "5.20")?.page).toBe("13");

  // --- Remove it again (marker menu) ---
  await m520.hover();
  await m520.getByRole("button", { name: /More actions/ }).click();
  await page.getByRole("menuitem", { name: "Remove from script" }).click();
  await expect(m520).toHaveCount(0);

  // --- Print: the PDF pages with the cue margin ---
  await page.getByRole("link", { name: "Print calling script" }).click();
  await expect(page).toHaveURL(/\/script\/print\?layout=pdf/);
  await expect(page.getByTestId("print-pdf")).toHaveAttribute("data-ready", "true", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("print-pdf-page")).toHaveCount(2);
  await expect(page.getByTestId("print-pdf-marker")).toHaveCount(1);
  await expect(page.getByTestId("print-pdf-marker")).toContainText("5.10");
});
