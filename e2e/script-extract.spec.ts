// Script extraction in a real browser (M4a): /dev/script-extract runs `extractScript` on a
// picked file. The PDF goes through pdf.js (the legacy build and its worker, loaded
// lazily); the DOCX through the lazily loaded JSZip. Fixtures are generated here.
import { expect, type Page, test } from "@playwright/test";
import JSZip from "jszip";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import { apiLogin } from "./helpers";

interface Extracted {
  blocks: { page: number; kind: string; text: string }[];
  pages: { page: number; label: string }[];
  source: string;
  confidence: number;
}

async function scriptPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const pages: [string, [number, string, PDFFont?][]][] = [
    [
      "14",
      [
        [260, "ACT ONE"],
        [100, "A Chicago speakeasy. Night.", italic],
        [0, ""],
        [280, "JOE"],
        [150, "Sweet Sue needs a sax and a bass player"],
        [150, "by Friday."],
      ],
    ],
    [
      "14a",
      [
        [280, "SUGAR"],
        [150, "RUNNIN' WILD, LOST CONTROL, RUNNIN' WILD"],
      ],
    ],
    [
      "15",
      [
        [280, "OSGOOD"],
        [150, "Nobody's perfect!"],
      ],
    ],
  ];
  for (const [label, lines] of pages) {
    const page = doc.addPage([612, 792]);
    // A running header and the page number on the same baseline.
    page.drawText("SOME LIKE IT HOT - Rehearsal draft", { x: 72, y: 750, size: 9, font: roman });
    page.drawText(label, { x: 530, y: 750, size: 10, font: roman });
    let y = 690;
    for (const [x, text, font] of lines) {
      if (text) page.drawText(text, { x, y, size: 12, font: font ?? roman });
      y -= 14;
    }
  }
  return Buffer.from(await doc.save());
}

async function scriptDocx(): Promise<Buffer> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (t: string, extra = "") =>
    `<w:p><w:r>${extra}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document ${W}><w:body>${p("ACT ONE")}${p("JOE")}${p(
      "Sweet Sue needs a sax.",
    )}${p("JERRY", "<w:lastRenderedPageBreak/>")}${p("Florida?")}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function extract(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByLabel("Script file").setInputFiles({ name, mimeType, buffer });
  const result = page.getByTestId("extract-result");
  await expect(result.or(page.getByTestId("extract-error"))).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("extract-error")).toHaveCount(0);
  return JSON.parse((await result.textContent()) ?? "") as Extracted;
}

test("extracts a PDF (pdf.js) and a DOCX (JSZip) in the browser", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await apiLogin(page);
  await page.goto("/dev/script-extract");

  const pdf = await extract(page, "script.pdf", "application/pdf", await scriptPdf());
  expect(pdf.source).toBe("pdf");
  expect(pdf.pages.map((p) => p.label)).toEqual(["14", "14a", "15"]);
  expect(pdf.blocks.map((b) => `${b.page} ${b.kind}: ${b.text}`)).toEqual([
    "1 heading: ACT ONE",
    "1 direction: A Chicago speakeasy. Night.",
    "1 character: JOE",
    "1 dialogue: Sweet Sue needs a sax and a bass player by Friday.",
    "2 character: SUGAR",
    "2 lyric: RUNNIN' WILD, LOST CONTROL, RUNNIN' WILD",
    "3 character: OSGOOD",
    "3 dialogue: Nobody's perfect!",
  ]);

  const docx = await extract(
    page,
    "script.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    await scriptDocx(),
  );
  expect(docx.blocks.map((b) => `${b.page} ${b.kind}: ${b.text}`)).toEqual([
    "1 heading: ACT ONE",
    "1 character: JOE",
    "1 dialogue: Sweet Sue needs a sax.",
    "2 character: JERRY",
    "2 dialogue: Florida?",
  ]);
  expect(errors).toEqual([]);
});
