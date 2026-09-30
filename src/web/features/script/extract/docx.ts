// Word (.docx) scripts: `word/document.xml` read with JSZip and a small tokenizer (no DOM,
// so it also runs in Node tests). Paragraph styles give kinds ("Heading 1" → heading,
// "Character" → character, "Dialogue", "Stage Direction"/"Action"/"Parenthetical" →
// direction, "Lyric"); other paragraphs are classified from their text. Pages come from
// Word's last rendered page breaks when the file has them (they match what was printed),
// else from hard page breaks; with neither, FALLBACK_BLOCKS_PER_PAGE blocks per page and
// a warning.
import JSZip from "jszip";
import type { BlockKind, ScriptText } from "../../../../shared/script";
import {
  classifyBlocks,
  FALLBACK_BLOCKS_PER_PAGE,
  pageInfos,
  paginateByCount,
  type RawBlock,
} from "./classify";
import { ScriptExtractError } from "./errors";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? "";
  });
}

/** Paragraph style id → style name, from `word/styles.xml`. */
export function styleNames(stylesXml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stylesXml.matchAll(
    /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g,
  )) {
    const name = /<w:name\s+w:val="([^"]*)"/.exec(m[2] ?? "")?.[1];
    if (m[1]) out.set(m[1], decodeXml(name ?? m[1]));
  }
  return out;
}

/** A kind named by a paragraph style, or undefined to classify from the text. */
export function kindForStyle(name: string): BlockKind | undefined {
  const n = name.toLowerCase();
  if (/character|speaker/.test(n)) return "character";
  if (/heading|title|\bact\b|\bscene\b/.test(n)) return "heading";
  if (/lyric|song/.test(n)) return "lyric";
  if (/dialog/.test(n)) return "dialogue";
  if (/direction|action|parenthetical|stage/.test(n)) return "direction";
  return undefined;
}

const TOKEN =
  /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t\/>|<w:(tab|cr|noBreakHyphen)\/>|<w:br\b([^>]*)\/>|<w:lastRenderedPageBreak\/>|<w:pageBreakBefore(?:\s+w:val="(?:1|true|on)")?\/>|<w:rPr>([\s\S]*?)<\/w:rPr>|<w:r\b[^>]*>|<\/w:r>/g;

interface Para {
  text: string;
  /** Page breaks before this paragraph's text / inside it at these text offsets. */
  hardBefore: boolean;
  renderedBefore: boolean;
  /** Offsets in `text` where a break occurs mid-paragraph. */
  hardAt: number[];
  renderedAt: number[];
  style: string | null;
  italicChars: number;
}

/** Paragraphs of `word/document.xml` with their breaks, style and italic share. */
export function parseParagraphs(documentXml: string): Para[] {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml;
  const out: Para[] = [];
  for (const m of body.matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const inner = m[1] ?? "";
    const p: Para = {
      text: "",
      hardBefore: false,
      renderedBefore: false,
      hardAt: [],
      renderedAt: [],
      style: /<w:pStyle\s+w:val="([^"]+)"/.exec(inner)?.[1] ?? null,
      italicChars: 0,
    };
    let italic = false;
    for (const t of inner.matchAll(TOKEN)) {
      const tok = t[0];
      if (tok.startsWith("<w:r>") || tok.startsWith("<w:r ")) italic = false;
      else if (tok.startsWith("<w:rPr>")) {
        italic = /<w:i(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(t[4] ?? "");
      } else if (tok.startsWith("<w:t")) {
        const s = decodeXml(t[1] ?? "");
        p.text += s;
        if (italic) p.italicChars += s.replace(/\s/g, "").length;
      } else if (t[2]) p.text += t[2] === "noBreakHyphen" ? "-" : " ";
      else if (tok.startsWith("<w:br")) {
        if (/w:type="page"/.test(t[3] ?? "")) {
          if (p.text.trim()) p.hardAt.push(p.text.length);
          else p.hardBefore = true;
        } else p.text += " ";
      } else if (tok.startsWith("<w:lastRenderedPageBreak")) {
        if (p.text.trim()) p.renderedAt.push(p.text.length);
        else p.renderedBefore = true;
      } else if (tok.startsWith("<w:pageBreakBefore")) p.hardBefore = true;
    }
    out.push(p);
  }
  return out;
}

/** Paragraphs → raw blocks with pages (rendered breaks preferred, else hard breaks). */
export function docxBlocks(
  paras: Para[],
  styles: Map<string, string>,
): { raw: RawBlock[]; paged: boolean } {
  const rendered = paras.some((p) => p.renderedBefore || p.renderedAt.length > 0);
  const hard = paras.some((p) => p.hardBefore || p.hardAt.length > 0);
  const useRendered = rendered;
  let page = 1;
  let any = false;
  const raw: RawBlock[] = [];
  for (const p of paras) {
    const before = useRendered ? p.renderedBefore : p.hardBefore;
    const at = useRendered ? p.renderedAt : p.hardAt;
    if (before && any) page++;
    const name = p.style ? (styles.get(p.style) ?? p.style) : "";
    const kind = name ? kindForStyle(name) : undefined;
    const letters = p.text.replace(/\s/g, "").length;
    const italic = letters ? p.italicChars / letters : 0;
    let from = 0;
    for (const cut of [...at, p.text.length]) {
      const piece = p.text.slice(from, cut);
      if (piece.trim()) {
        raw.push({ text: piece, page, italic, ...(kind ? { kind } : {}) });
        any = true;
      }
      if (cut < p.text.length) page++;
      from = cut;
    }
  }
  return { raw, paged: useRendered || hard };
}

export async function extractDocx(data: ArrayBuffer | Uint8Array): Promise<ScriptText> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new ScriptExtractError("unreadable", "That file isn't a readable Word document (.docx).");
  }
  const doc = await zip.file("word/document.xml")?.async("string");
  if (!doc) {
    throw new ScriptExtractError(
      "unreadable",
      "That file isn't a Word document (no word/document.xml).",
    );
  }
  const stylesXml = (await zip.file("word/styles.xml")?.async("string")) ?? "";
  const { raw, paged } = docxBlocks(parseParagraphs(doc), styleNames(stylesXml));
  const warnings: string[] = [];
  const blocks = classifyBlocks(paged ? raw : paginateByCount(raw));
  if (blocks.length === 0) throw new ScriptExtractError("empty", "The document has no text.");
  if (!paged && blocks.some((b) => b.page > 1)) {
    warnings.push(
      `The document has no page breaks: pages are every ${FALLBACK_BLOCKS_PER_PAGE} paragraphs and won't match the printed script. Re-save it from Word (which records page breaks), or import the PDF.`,
    );
  }
  return {
    blocks,
    pages: pageInfos([...new Set(blocks.map((b) => b.page))], new Map()),
    source: "docx",
    confidence: paged ? 0.95 : 0.7,
    ...(warnings.length ? { warnings } : {}),
  };
}
