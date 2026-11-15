// The merged PDF of "Add pages", through pdf.js's Node build and the real extractor:
// page count and order, labels, running headers stripped across the whole document (a
// single replacement page alone keeps its header), unchanged pages' text identical.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { diffPages } from "../../../../shared/script-anchor";
import { extractPdf, pdfPageSummaries, readPdfItems } from "../extract/pdf";
import { MergeError, mergePdf, pdfPageCount } from "./merge";
import { type BasePage, buildPlan, type IncomingPage, mergeOrder } from "./plan";

const nodePdfjs = () =>
  import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<typeof import("pdfjs-dist")>;

/** Pages with a "WG <date>" header on the left, the label on the right, and a speech. */
async function scriptPages(
  pages: { label: string; date?: string; lines: string[] }[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (const p of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText(`WG ${p.date ?? "11.11.26"}`, { x: 72, y: 746, size: 12, font });
    page.drawText(p.label, { x: 540, y: 746, size: 12, font });
    let y = 690;
    for (const line of p.lines) {
      page.drawText(line, { x: line === line.toUpperCase() ? 280 : 150, y, size: 12, font });
      y -= 14;
    }
  }
  return doc.save();
}

const speech = (label: string) => ["RAMONA", `This is what happens on page ${label}.`];

describe("Add pages: merge", () => {
  it("replaces, inserts and removes pages; the merged script reads like a full import", async () => {
    const pdfjs = await nodePdfjs();
    const baseLabels = ["136", "137", "138", "139", "139a", "140", "141"];
    const baseBytes = await scriptPages(
      baseLabels.map((label) => ({ label, lines: speech(label) })),
    );
    const baseText = await extractPdf(baseBytes, pdfjs);
    const base: BasePage[] = baseText.pages.map((p) => ({ index: p.page - 1, label: p.label }));
    expect(base.map((p) => p.label)).toEqual(baseLabels);

    // One replacement page and one insert, each a file of its own (their own date).
    const files = [
      await scriptPages([
        { label: "138", date: "11.12.26", lines: ["RAMONA", "Hello? No. Goodbye."] },
      ]),
      await scriptPages([{ label: "139b", date: "11.12.26", lines: speech("139b") }]),
    ];
    const incoming: IncomingPage[] = [];
    for (const [file, bytes] of files.entries()) {
      const summaries = pdfPageSummaries(await readPdfItems(bytes, pdfjs), "#");
      for (const [index, s] of summaries.entries()) {
        incoming.push({ key: `${file}:${index}`, file, index, fileName: `f${file}.pdf`, ...s });
      }
    }
    expect(incoming.map((p) => [p.label, p.firstLine])).toEqual([
      ["138", "RAMONA · Hello? No. Goodbye."],
      ["139b", "RAMONA · This is what happens on page 139b."],
    ]);
    const plan = { ...buildPlan(base, incoming), removed: [6] }; // cut 141
    const order = mergeOrder(base.length, plan);
    const merged = await mergePdf(
      { bytes: baseBytes, name: "base.pdf" },
      files.map((bytes, k) => ({ bytes, name: `f${k}.pdf` })),
      order,
    );
    expect(await pdfPageCount(merged, "merged.pdf")).toBe(7);

    const text = await extractPdf(merged, pdfjs);
    expect(text.pages.map((p) => p.label)).toEqual([
      "136",
      "137",
      "138",
      "139",
      "139a",
      "139b",
      "140",
    ]);
    // Headers (dates included) are stripped across the merged document.
    expect(text.blocks.filter((b) => b.text.startsWith("WG "))).toEqual([]);
    expect(text.blocks.filter((b) => b.page === 3).map((b) => b.text)).toEqual([
      "RAMONA",
      "Hello? No. Goodbye.",
    ]);
    const diff = diffPages(baseText, text);
    expect(
      diff.pages.filter((p) => p.status !== "same").map((p) => `${p.label} ${p.status}`),
    ).toEqual(["138 changed", "139b changed"]);
    expect(diff.removed).toBe(1);
  });

  it("refuses an encrypted PDF with a reason", async () => {
    // pdf-lib can't write encryption; a trailer /Encrypt entry is what it checks.
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const enc = doc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "x", P: -4 });
    doc.context.trailerInfo.Encrypt = doc.context.register(enc);
    const bytes = await doc.save();
    const err = await pdfPageCount(bytes, "locked.pdf").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeError);
    expect((err as Error).message).toMatch(/locked\.pdf is protected/);
    const bad = await pdfPageCount(new TextEncoder().encode("nope"), "x.pdf").catch(
      (e: unknown) => e,
    );
    expect((bad as Error).message).toBe("x.pdf isn't a readable PDF.");
  });
});
