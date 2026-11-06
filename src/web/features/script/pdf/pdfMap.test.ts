// The anchor ↔ PDF glyph mapping, on a PDF generated here (pdf-lib) and read through
// pdfjs-dist's Node build, like the import does: multi-line quotes, positional anchors,
// missing and stale anchors, selections from the text layer, lines for placing.
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeText } from "../../../../shared/script";
import type { Anchor, AnchorState, ScriptText } from "../contract";
import { makeAnchor, makePositionAnchor } from "../contract";
import { layoutPdf } from "../extract/pdf";
import { spanAnchor } from "../placement";
import { anchorRow, cueRow } from "../testData";
import {
  alignBlocks,
  anchorGeom,
  type GlyphMap,
  lineAt,
  pageGlyphIndex,
  pageLines,
  selectionSpan,
} from "./pdfMap";
import { buildMarks, ENTRY_HEIGHT, layoutMarks } from "./pdfMarks";
import { buildGlyphMap, type PdfPageData, readPdfPages } from "./pdfPages";

const nodePdfjs = () =>
  import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<typeof import("pdfjs-dist")>;

const LINE = 14;

/** Two pages: a page number, a running header, a character, a two-line speech, a direction. */
async function fixturePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const pages: [string, [number, string, PDFFont?][]][] = [
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
        [100, "Lights shift.", italic],
      ],
    ],
  ];
  for (const [label, lines] of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText("RAILWAY - Rehearsal draft", { x: 72, y: 750, size: 9, font: roman });
    page.drawText(label, { x: 530, y: 750, size: 10, font: roman });
    let y = 690;
    for (const [x, text, font] of lines) {
      if (text) page.drawText(text, { x, y, size: 12, font: font ?? roman });
      y -= LINE;
    }
  }
  return doc.save();
}

let doc: PDFDocumentProxy;
let pages: PdfPageData[];
let text: ScriptText;
let map: GlyphMap;
const geomOf = (p: number) => pages[p - 1]?.geom;
const blockOf = (needle: string) => {
  const b = text.blocks.find((x) => x.text.includes(needle));
  if (!b) throw new Error(`no block with ${needle}`);
  return b;
};

beforeAll(async () => {
  const pdfjs = await nodePdfjs();
  doc = await pdfjs.getDocument({
    data: await fixturePdf(),
    disableFontFace: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
  pages = await readPdfPages(doc);
  // What the import stored: the same layout, untraced.
  text = layoutPdf(pages.map((p) => p.items));
  map = buildGlyphMap(pages, text);
});

describe("glyph map", () => {
  it("maps every block character to the glyph that produced it", () => {
    expect(map).toHaveLength(text.blocks.length);
    let checked = 0;
    text.blocks.forEach((b, i) => {
      const g = map[i];
      expect(g, b.text).toBeTruthy();
      if (!g) return;
      expect(g.page).toBe(b.page);
      for (let k = 0; k < b.text.length; k++) {
        const item = g.item[k] as number;
        if (item < 0) {
          expect(b.text[k]).toBe(" "); // only inserted spaces have no glyph
          continue;
        }
        const str = pages[b.page - 1]?.geom.items[item]?.str ?? "";
        expect(normalizeText(str[g.ch[k] as number] ?? "") || " ").toBe(b.text[k]);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(100);
  });

  it("aligns blocks that another extraction split or joined differently", () => {
    // The stored text joined the two direction lines' blocks with the next block, and split
    // JOE's speech: each stored block is still found on its page.
    const traced = { text, trace: map.map((g) => g as NonNullable<typeof g>) };
    const speech = blockOf("Keep your head");
    const cut = speech.text.indexOf(" we are");
    const stored: ScriptText = {
      ...text,
      blocks: text.blocks
        .flatMap((b) =>
          b.i === speech.i
            ? [
                { ...b, text: b.text.slice(0, cut) },
                { ...b, i: b.i + 0.5, text: b.text.slice(cut + 1) },
              ]
            : [{ ...b }],
        )
        .map((b, i) => ({ ...b, i })),
    };
    const aligned = alignBlocks(stored, traced);
    const second = stored.blocks.findIndex((b) => b.text.startsWith("we are"));
    const g = aligned[second];
    expect(g).toBeTruthy();
    const it = pages[0]?.geom.items[g?.item[0] ?? -1];
    expect(it?.str.startsWith("we are")).toBe(true);
    // A block that isn't in the PDF at all.
    const missing = alignBlocks(
      { ...text, blocks: [{ i: 0, page: 1, kind: "other", text: "Nope" }] },
      traced,
    );
    expect(missing).toEqual([null]);
  });
});

describe("anchorGeom", () => {
  it("underlines a quote over two lines, one segment per line", () => {
    const b = blockOf("Keep your head");
    const at = b.text.indexOf("case up");
    const a = makeAnchor(text, b.i, at, b.text.indexOf("nearly") + 6 - at);
    const g = anchorGeom(map, text, a, geomOf);
    expect(g?.page).toBe(1);
    expect(g?.segs).toHaveLength(2);
    const [first, second] = g?.segs ?? [];
    // Baselines one line apart (top-left origin: y grows down).
    expect((second?.y ?? 0) - (first?.y ?? 0)).toBeCloseTo(LINE, 0);
    // The first starts inside the line ("case" is not the line's first word), the second at
    // the line's start.
    expect(first?.x0).toBeGreaterThan(150 + 20);
    expect(second?.x0).toBeCloseTo(150, 0);
    expect(g?.start.x).toBeCloseTo(first?.x0 ?? 0, 5);
    expect(g?.stale).toBe(false);
  });

  it("puts a positional anchor at its line's start", () => {
    const b = blockOf("Lights shift");
    const g = anchorGeom(map, text, makePositionAnchor(text, b.i), geomOf);
    expect(g?.page).toBe(2);
    expect(g?.start.x).toBeCloseTo(100, 0);
    expect(g?.start.y).toBeCloseTo(792 - (690 - 3 * LINE), 0);
  });

  it("draws nothing for a missing anchor", () => {
    const a = { block: -1, offset: 0, length: 0, quote: "Gone", prefix: "", suffix: "" };
    expect(anchorGeom(map, text, a, geomOf)).toBeNull();
  });

  it("still places a stale anchor (its quote changed) and flags it", () => {
    const b = blockOf("Sweet Sue");
    const a = { ...makeAnchor(text, b.i, 0, 9), quote: "Sweet Lou" };
    const g = anchorGeom(map, text, a, geomOf);
    expect(g?.stale).toBe(true);
    expect(g?.segs).toHaveLength(1);
    expect(g?.start.x).toBeCloseTo(150, 0);
  });
});

describe("selectionSpan", () => {
  /** The text-layer position of `needle` (item ref, char) on a page. */
  const find = (page: number, needle: string) => {
    const items = pages[page - 1]?.geom.items ?? [];
    for (let r = 0; r < items.length; r++) {
      const at = items[r]?.str.indexOf(needle) ?? -1;
      if (at >= 0) return { item: r, ch: at };
    }
    throw new Error(`no ${needle}`);
  };

  it("turns a text-layer selection into the same anchor as the text reader", () => {
    const idx = pageGlyphIndex(map, 2, pages[1]?.geom as PdfPageData["geom"]);
    const s = find(2, "a sax");
    const span = selectionSpan(text, idx, s, { item: s.item, ch: s.ch + "a sax".length });
    expect(span).toBeTruthy();
    if (!span) return;
    const a = spanAnchor(text, span);
    expect(a.quote).toBe("a sax");
  });

  it("selects across lines", () => {
    const idx = pageGlyphIndex(map, 1, pages[0]?.geom as PdfPageData["geom"]);
    const s = find(1, "case up");
    const e = find(1, "nearly");
    const span = selectionSpan(text, idx, s, { item: e.item, ch: e.ch + 6 });
    expect(span && spanAnchor(text, span).quote).toBe("case up, we are nearly");
  });

  it("snaps a selection starting on the page number onto the script text", () => {
    const idx = pageGlyphIndex(map, 2, pages[1]?.geom as PdfPageData["geom"]);
    const label = find(2, "13");
    const e = find(2, "SUE");
    const span = selectionSpan(text, idx, label, { item: e.item, ch: e.ch + 3 });
    expect(span && spanAnchor(text, span).quote).toBe("SUE");
  });

  it("selects nothing outside the script text", () => {
    const idx = pageGlyphIndex(map, 2, pages[1]?.geom as PdfPageData["geom"]);
    const h = find(2, "RAILWAY");
    expect(selectionSpan(text, idx, h, { item: h.item, ch: 7 })).toBeTruthy(); // snaps forward…
    const solo = new Map(); // …but an empty page has nothing to snap to
    expect(selectionSpan(text, solo, h, { item: h.item, ch: 7 })).toBeNull();
  });
});

describe("pageLines / lineAt", () => {
  it("lists the page's lines with their block and offset", () => {
    const lines = pageLines(map, 1, pages[0]?.geom as PdfPageData["geom"]);
    const speech = blockOf("Keep your head");
    const second = lines.find((l) => l.block === speech.i && l.offset > 0);
    expect(second).toBeTruthy();
    expect(speech.text.slice(second?.offset)).toMatch(/^we are/);
    // A click between two lines' text picks the nearer; a click on one picks it.
    expect(lineAt(lines, second?.y ?? 0)).toBe(second);
    expect(lineAt(lines, -50)).toBe(lines[0]);
    expect(lineAt(lines, 5000)).toBe(lines.at(-1));
  });
});

describe("buildMarks / layoutMarks", () => {
  const cue = (id: string, p: Partial<Parameters<typeof cueRow>[0]> = {}) => cueRow({ id, ...p });
  const row = (id: string, cueId: string, a: Omit<Anchor, never>, state: AnchorState = "manual") =>
    anchorRow({ id, cue_id: cueId, ...a, state });

  it("draws quotes and positions, flags stale ones, and lists what it can't place", () => {
    const speech = blockOf("Keep your head");
    const sue = blockOf("Sweet Sue");
    const shift = blockOf("Lights shift");
    const cues = new Map([
      ["c1", cue("c1", { number: "1", trigger_type: "Line", order_key: "a1" })],
      [
        "c2",
        cue("c2", {
          number: "2",
          trigger_type: "Visual",
          description: "SHIFT: lights",
          order_key: "a2",
        }),
      ],
      ["c3", cue("c3", { number: "3", trigger_type: "Line", order_key: "a3" })],
      ["c4", cue("c4", { number: "4", order_key: "a4" })],
      ["c5", cue("c5", { number: "5", trigger_type: "Line", order_key: "a5" })],
    ]);
    const quote = makeAnchor(text, speech.i, speech.text.indexOf("case up"), 7);
    const anchors = [
      row("a1", "c1", quote),
      row("a2", "c2", makePositionAnchor(text, shift.i)),
      row("a3", "c3", { ...makeAnchor(text, sue.i, 0, 9), quote: "Sweet Lou" }),
      row(
        "a4",
        "c4",
        { block: -1, offset: 0, length: 0, quote: "Gone", prefix: "", suffix: "" },
        "missing",
      ),
      row("a5", "c5", makeAnchor(text, sue.i, 0, 5)),
    ];
    // Block of a5 unknown to the PDF (another extraction lost it).
    const holey = map.map((g, i) => (i === sue.i ? null : g));
    const { byPage, unlocated } = buildMarks({ anchors, cues, text, map: holey, geomOf });
    expect(byPage.get(1)?.map((m) => m.anchor.id)).toEqual(["a1"]);
    expect(byPage.get(2)?.map((m) => m.anchor.id)).toEqual(["a2"]);
    expect(unlocated.map((a) => a.id)).toEqual(["a3", "a5"]);

    const full = buildMarks({ anchors, cues, text, map, geomOf });
    const page2 = full.byPage.get(2) ?? [];
    expect(page2.map((m) => m.anchor.id)).toEqual(["a3", "a5", "a2"]);
    const [stale, , positional] = page2;
    expect(stale?.warn).toBe(true);
    expect(positional?.positional).toBe(true);
    expect(positional?.label).toBe("VISUAL · SHIFT");
    expect(positional?.geom.segs).toEqual(expect.any(Array));
    // Missing anchors are never drawn.
    expect([...full.byPage.values()].flat().some((m) => m.anchor.id === "a4")).toBe(false);

    // Two cues on the same words stack in the margin without overlapping.
    const layout = layoutMarks(page2, 1.5, 792);
    const tops = page2.map((m) => layout.get(m.anchor.id)?.top ?? 0);
    expect(tops[1] ?? 0).toBeGreaterThanOrEqual((tops[0] ?? 0) + ENTRY_HEIGHT);
    // Each leader leaves the page at its trigger: the quote's end, or above the line.
    const lq = layout.get("a3");
    expect(lq?.fromX).toBeCloseTo((stale?.geom.segs[0]?.x1 ?? 0) * 1.5, 5);
    const lp = layout.get("a2");
    expect(lp?.fromY).toBeLessThan((positional?.geom.start.y ?? 0) * 1.5);
  });
});
