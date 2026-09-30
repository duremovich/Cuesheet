// Extraction fixtures are generated here: a 3-page PDF (pdf-lib) read through pdfjs-dist's
// Node build, DOCX zips built with JSZip, and plain text.
import JSZip from "jszip";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { DOCX_TYPE } from "../../../../shared/attachments";
import { sanitizeScriptText } from "../../../../shared/script";
import { makeAnchor, reanchor } from "../../../../shared/script-anchor";
import {
  extractDocx,
  extractPdf,
  extractPlainText,
  extractScript,
  ScriptExtractError,
  scriptFileKind,
} from ".";
import { isCharacterCue, isHeading, pageLabelOf } from "./classify";
import { decodeXml } from "./docx";

const nodePdfjs = () =>
  import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<typeof import("pdfjs-dist")>;

/** Blocks as "kind: text" for compact assertions. */
const summary = (t: { blocks: { kind: string; text: string; page: number }[] }) =>
  t.blocks.map((b) => `${b.page} ${b.kind}: ${b.text}`);

async function scriptPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const roman = await doc.embedFont(StandardFonts.TimesRoman);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const pages: [string, [number, string, PDFFont?][]][] = [
    [
      "14",
      [
        [260, "ACT ONE"],
        [240, "SCENE 1"],
        [100, "A Chicago speakeasy. Night. The band plays a hot number", italic],
        [100, "while the police gather outside.", italic],
        [0, ""],
        [280, "JOE"],
        [150, "Sweet Sue needs a sax and a bass player"],
        [150, "by Friday."],
        [200, "(beat)", italic],
        [150, "We could always go to Florida."],
      ],
    ],
    [
      "14a",
      [
        [280, "JERRY"],
        [150, "With the girls? Are you out of your mind?"],
        [0, ""],
        [230, "No. 4 – VAMP"],
        [280, "SUGAR"],
        [150, "RUNNIN' WILD, LOST CONTROL, RUNNIN' WILD"],
      ],
    ],
    [
      "15",
      [
        [280, "OSGOOD"],
        [150, "Nobody’s perfect!"],
        [0, ""],
        [100, "Blackout.", italic],
      ],
    ],
  ];
  for (const [label, lines] of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText("SOME LIKE IT HOT — Rehearsal draft", { x: 72, y: 750, size: 9, font: roman });
    page.drawText(label, { x: 530, y: 750, size: 10, font: roman });
    let y = 690;
    for (const [x, text, font] of lines) {
      if (text) page.drawText(text, { x, y, size: 12, font: font ?? roman });
      y -= 14;
    }
  }
  return doc.save();
}

describe("classify helpers", () => {
  it("recognises headings, character names and page labels", () => {
    for (const h of ["ACT ONE", "Scene 3.", "SCENE 12", "PROLOGUE", "No. 4 - VAMP", "#12 Finale"]) {
      expect(isHeading(h), h).toBe(true);
    }
    expect(isHeading("Actually, no.")).toBe(false);
    for (const c of ["JOE", "SWEET SUE", "JERRY (as Daphne)", "OSGOOD (O.S.)", "MRS. FIELDING"]) {
      expect(isCharacterCue(c), c).toBe(true);
    }
    for (const c of [
      "I DO.",
      "Joe",
      "ACT ONE",
      "A",
      "THIS IS A VERY LONG SHOUTED LINE OF DIALOGUE HERE",
    ]) {
      expect(isCharacterCue(c), c).toBe(false);
    }
    expect(pageLabelOf("14")).toBe("14");
    expect(pageLabelOf("- 14a -")).toBe("14a");
    expect(pageLabelOf("Page 7")).toBe("7");
    expect(pageLabelOf("I-3-14")).toBe("I-3-14");
    expect(pageLabelOf("xii")).toBe("xii");
    expect(pageLabelOf("Blackout.")).toBeNull();
  });
});

describe("PDF", () => {
  it("extracts blocks, kinds and printed page labels; drops running headers", async () => {
    const text = await extractPdf(await scriptPdf(), await nodePdfjs());
    expect(text.source).toBe("pdf");
    expect(text.confidence).toBe(1);
    expect(text.pages).toEqual([
      { page: 1, label: "14" },
      { page: 2, label: "14a" },
      { page: 3, label: "15" },
    ]);
    expect(summary(text)).toEqual([
      "1 heading: ACT ONE",
      "1 heading: SCENE 1",
      "1 direction: A Chicago speakeasy. Night. The band plays a hot number while the police gather outside.",
      "1 character: JOE",
      "1 dialogue: Sweet Sue needs a sax and a bass player by Friday.",
      "1 direction: (beat)",
      "1 dialogue: We could always go to Florida.",
      "2 character: JERRY",
      "2 dialogue: With the girls? Are you out of your mind?",
      "2 heading: No. 4 - VAMP",
      "2 character: SUGAR",
      "2 lyric: RUNNIN' WILD, LOST CONTROL, RUNNIN' WILD",
      "3 character: OSGOOD",
      "3 dialogue: Nobody's perfect!",
      "3 direction: Blackout.",
    ]);
    // What the server stores is what was extracted.
    expect(sanitizeScriptText(text)).toEqual({ text });
  });

  it("a PDF without a text layer is refused with a reason", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawRectangle({ x: 50, y: 50, width: 200, height: 300 });
    doc.addPage([612, 792]);
    const err = await extractPdf(await doc.save(), await nodePdfjs()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptExtractError);
    expect((err as ScriptExtractError).code).toBe("no-text-layer");
    const bad = await extractPdf(new TextEncoder().encode("not a pdf"), await nodePdfjs()).catch(
      (e: unknown) => e,
    );
    expect((bad as ScriptExtractError).code).toBe("unreadable");
  });
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function para(
  text: string,
  opts: { style?: string; italic?: boolean; before?: string; mid?: string } = {},
) {
  const pPr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : "";
  const rPr = opts.italic ? "<w:rPr><w:i/></w:rPr>" : "";
  const run = (t: string) => `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const body = opts.mid ? run(text.slice(0, 10)) + opts.mid + run(text.slice(10)) : run(text);
  return `<w:p>${pPr}${opts.before ?? ""}${body}</w:p>`;
}

async function docx(paragraphs: string[], styles = ""): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document ${W}><w:body>${paragraphs.join("")}</w:body></w:document>`,
  );
  if (styles)
    zip.file("word/styles.xml", `<?xml version="1.0"?><w:styles ${W}>${styles}</w:styles>`);
  return zip.generateAsync({ type: "uint8array" });
}

const STYLES =
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Char"><w:name w:val="Character"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Dlg"><w:name w:val="Dialogue"/></w:style>';

describe("DOCX", () => {
  it("uses paragraph styles, italics and Word's rendered page breaks", async () => {
    const rendered = "<w:r><w:lastRenderedPageBreak/></w:r>";
    const bytes = await docx(
      [
        para("ACT ONE", { style: "Heading1" }),
        para("A speakeasy &amp; a band.", { italic: true }),
        para("JOE", { style: "Char" }),
        para("Sweet Sue needs a sax.", { style: "Dlg" }),
        para("JERRY", { before: rendered }),
        para("Florida? With the girls?"),
        para("OSGOOD"),
        // A page break in the middle of a paragraph splits it across pages.
        para("Nobody’s perfect, not even &lt;you&gt;.", { mid: rendered }),
      ],
      STYLES,
    );
    const text = await extractDocx(bytes);
    expect(text.source).toBe("docx");
    expect(text.warnings).toBeUndefined();
    expect(summary(text)).toEqual([
      "1 heading: ACT ONE",
      "1 direction: A speakeasy & a band.",
      "1 character: JOE",
      "1 dialogue: Sweet Sue needs a sax.",
      "2 character: JERRY",
      "2 dialogue: Florida? With the girls?",
      "2 character: OSGOOD",
      "2 dialogue: Nobody's p",
      "3 other: erfect, not even <you>.",
    ]);
    expect(text.pages.map((p) => p.label)).toEqual(["1", "2", "3"]);
  });

  it("falls back to hard page breaks, then to 40 paragraphs a page with a warning", async () => {
    const hard = '<w:r><w:br w:type="page"/></w:r>';
    const withHard = await extractDocx(
      await docx([para("One."), para("Two.", { before: hard }), para("Three.")]),
    );
    expect(withHard.blocks.map((b) => b.page)).toEqual([1, 2, 2]);
    const none = await extractDocx(
      await docx(Array.from({ length: 45 }, (_, i) => para(`Line ${i + 1}.`))),
    );
    expect(none.blocks.at(-1)?.page).toBe(2);
    expect(none.blocks[39]?.page).toBe(1);
    expect(none.warnings?.[0]).toMatch(/no page breaks/);
    expect(none.confidence).toBeLessThan(0.9);
  });

  it("decodes XML entities and rejects non-DOCX files", async () => {
    expect(decodeXml("&amp;&lt;&#8217;&#x2014;&quot;")).toBe('&<’—"');
    const err = await extractDocx(new TextEncoder().encode("nope")).catch((e: unknown) => e);
    expect((err as ScriptExtractError).code).toBe("unreadable");
  });
});

describe("text", () => {
  it("paragraphs, character names, page markers", () => {
    const text = extractPlainText(
      [
        "--- page 1 ---",
        "ACT ONE",
        "",
        "JOE",
        "Sweet Sue needs a sax",
        "and a bass player.",
        "",
        "(He exits.)",
        "--- page 2a ---",
        "JERRY",
        "Florida?",
        "\f",
        "Blackout.",
      ].join("\n"),
    );
    expect(summary(text)).toEqual([
      "1 heading: ACT ONE",
      "1 character: JOE",
      "1 dialogue: Sweet Sue needs a sax and a bass player.",
      "1 direction: (He exits.)",
      "2 character: JERRY",
      "2 dialogue: Florida?",
      "3 other: Blackout.",
    ]);
    expect(text.pages).toEqual([
      { page: 1, label: "1" },
      { page: 2, label: "2a" },
      { page: 3, label: "3" },
    ]);
    expect(text.confidence).toBe(1);
  });

  it("markdown headings and italics; no markers → pages by count, with a warning", () => {
    const md = extractPlainText("# Act One\n\n*The lights rise.*\n\nJOE\nHello.", {
      markdown: true,
    });
    expect(summary(md)).toEqual([
      "1 heading: Act One",
      "1 direction: The lights rise.",
      "1 character: JOE",
      "1 dialogue: Hello.",
    ]);
    const long = extractPlainText(Array.from({ length: 81 }, (_, i) => `Line ${i}.`).join("\n\n"));
    expect(long.blocks.at(-1)?.page).toBe(3);
    expect(long.warnings?.[0]).toMatch(/No page markers/);
  });
});

describe("extractScript", () => {
  it("dispatches by type and extension", async () => {
    expect(scriptFileKind({ name: "a.PDF", type: "" })).toBe("pdf");
    expect(scriptFileKind({ name: "a", type: DOCX_TYPE })).toBe("docx");
    expect(scriptFileKind({ name: "a.md", type: "" })).toBe("md");
    expect(scriptFileKind({ name: "a.rtf", type: "application/rtf" })).toBeNull();
    const txt = await extractScript(new File(["JOE\nHi."], "s.txt", { type: "text/plain" }));
    expect(txt.blocks).toHaveLength(2);
    const pdf = await extractScript(
      new File([(await scriptPdf()).slice().buffer as ArrayBuffer], "s.pdf"),
      { pdfjs: nodePdfjs },
    );
    expect(pdf.pages[1]?.label).toBe("14a");
    const err = await extractScript(new File(["x"], "s.rtf")).catch((e: unknown) => e);
    expect((err as ScriptExtractError).code).toBe("unsupported");
  });

  it("re-anchors across two extracted versions", () => {
    const florida = "JERRY\nFlorida? Are you out of your mind, Joe? Out of your mind";
    const v1 = extractPlainText(`JOE\nSweet Sue needs a sax.\n\n${florida}.\n\nBlackout.`);
    const v2 = extractPlainText(
      `--- page 1 ---\nPROLOGUE\n\nJOE\nSweet Sue needs a sax.\n\n${florida} entirely.\n\nBlackout.`,
    );
    const sue = makeAnchor(v1, 1, 0, "Sweet Sue needs a sax.".length);
    const [r] = reanchor(v1, v2, [{ cueId: "q", anchor: sue }]);
    expect(r?.state).toBe("matched");
    expect(r?.to?.block).toBe(2);
  });
});
