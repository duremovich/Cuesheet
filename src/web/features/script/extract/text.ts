// Plain text and Markdown scripts: paragraphs are separated by blank lines (lines inside
// one are joined); a character name on the first line of a paragraph is its own block.
// Pages come from `--- page 14 ---` marker lines (the label is what follows "page") or
// form feeds; without either, FALLBACK_BLOCKS_PER_PAGE blocks per page, with a warning.
import type { ScriptText } from "../../../../shared/script";
import {
  classifyBlocks,
  FALLBACK_BLOCKS_PER_PAGE,
  isCharacterCue,
  pageInfos,
  paginateByCount,
  type RawBlock,
} from "./classify";

const PAGE_MARKER = /^\s*-{2,}\s*page\s+(\S{1,12})\s*-{2,}\s*$/i;

/** Markdown decoration off a line; `#` headings and `*italic*`-only lines are noted. */
function markdownLine(line: string): { text: string; heading: boolean; italic: boolean } {
  const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) return { text: h[1] ?? "", heading: true, italic: false };
  const it = /^\s*([*_])(?!\1)(.+)\1\s*$/.exec(line);
  const text = (it ? (it[2] ?? "") : line)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^\s*>\s?/, "");
  return { text, heading: false, italic: !!it };
}

export function extractPlainText(input: string, opts: { markdown?: boolean } = {}): ScriptText {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const raw: RawBlock[] = [];
  const labels = new Map<number, string>();
  let page = 1;
  let marked = false;
  let para: { text: string[]; italic: boolean } | null = null;
  const flush = () => {
    if (!para) return;
    const [first, ...rest] = para.text;
    if (first !== undefined && rest.length > 0 && isCharacterCue(first.trim())) {
      raw.push({ text: first, page });
      raw.push({ text: rest.join(" "), page, continues: true });
    } else {
      raw.push({ text: para.text.join(" "), page, italic: para.italic ? 1 : 0 });
    }
    para = null;
  };
  const newPage = (label?: string) => {
    flush();
    if (marked || raw.length > 0) page++;
    marked = true;
    if (label) labels.set(page, label);
  };
  for (const rawLine of lines) {
    const pages = rawLine.split("\f");
    pages.forEach((segment, k) => {
      if (k > 0) newPage();
      const m = PAGE_MARKER.exec(segment);
      if (m) {
        newPage(m[1]);
        return;
      }
      if (!segment.trim()) {
        flush();
        return;
      }
      const md = opts.markdown ? markdownLine(segment) : null;
      if (md?.heading) {
        flush();
        raw.push({ text: md.text, page, kind: "heading" });
        return;
      }
      const text = md ? md.text : segment;
      if (para) para.text.push(text.trim());
      else para = { text: [text.trim()], italic: !!md?.italic };
      if (md && !md.italic) para.italic = false;
    });
  }
  flush();
  const warnings: string[] = [];
  let blocks = raw;
  if (!marked) {
    blocks = paginateByCount(raw);
    if (blocks.some((b) => b.page > 1)) {
      warnings.push(
        `No page markers found: pages are every ${FALLBACK_BLOCKS_PER_PAGE} paragraphs. Add "--- page 14 ---" lines to match the printed script.`,
      );
    }
  }
  const classified = classifyBlocks(blocks);
  const used = [...new Set(classified.map((b) => b.page))];
  return {
    blocks: classified,
    pages: pageInfos(used, labels),
    source: "txt",
    confidence: marked ? 1 : 0.8,
    ...(warnings.length ? { warnings } : {}),
  };
}
