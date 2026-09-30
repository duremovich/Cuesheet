// Stand-in for M4a's extractor (./extract): plain text and Markdown only. Pages are split
// on form feeds (\f); a page whose first line is a lone number ("14", "14a") takes it as
// its printed label. Paragraphs are split on blank lines; an ALL-CAPS short first line
// followed by more lines is a character name with its dialogue.
import type { BlockKind, ScriptBlock, ScriptPageInfo, ScriptText } from "../contract";

const HEADING = /^(#+\s*)?(ACT\b|SCENE\b|PROLOGUE\b|EPILOGUE\b|INT\.|EXT\.)/i;
const CHARACTER = /^[A-Z][A-Z .'-]{0,28}(\s*\([A-Z .']+\))?$/;
const LABEL = /^\s*(\d+[a-z]?)\.?\s*$/i;

function kindOf(p: string, prev: BlockKind | null): BlockKind {
  if (HEADING.test(p)) return "heading";
  if (/^\(.*\)$/s.test(p)) return "direction";
  if (/^[♪~]/.test(p)) return "lyric";
  if (prev === "character") return "dialogue";
  return "other";
}

export function parseScriptText(raw: string): ScriptText {
  const text = raw.replace(/\r\n?/g, "\n");
  const rawPages = text.split("\f");
  const blocks: ScriptBlock[] = [];
  const pages: ScriptPageInfo[] = [];
  rawPages.forEach((pageText, n) => {
    const page = n + 1;
    const lines = pageText.split("\n");
    while (lines.length && !lines[0]?.trim()) lines.shift();
    let label = String(page);
    const first = lines[0];
    const m = first === undefined ? null : LABEL.exec(first);
    if (m?.[1]) {
      label = m[1].toLowerCase();
      lines.shift();
    }
    pages.push({ page, label });
    let prev: BlockKind | null = null;
    for (const para of lines.join("\n").split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p) continue;
      const parts = p.split("\n");
      const head = parts[0]?.trim() ?? "";
      if (parts.length > 1 && CHARACTER.test(head) && !HEADING.test(head)) {
        blocks.push({ i: blocks.length, page, kind: "character", text: head });
        const rest = parts.slice(1).join(" ").replace(/\s+/g, " ").trim();
        const k = /^\(.*\)$/.test(rest) ? "direction" : /^[♪~]/.test(rest) ? "lyric" : "dialogue";
        blocks.push({ i: blocks.length, page, kind: k, text: rest });
        prev = k;
        continue;
      }
      const line = p.replace(/^#+\s*/, "").replace(/\s+/g, " ");
      const kind = kindOf(p, prev);
      blocks.push({ i: blocks.length, page, kind, text: line });
      prev = kind;
    }
  });
  return { blocks, pages, source: "txt", confidence: 1 };
}

export async function extractScript(file: File): Promise<ScriptText> {
  const name = file.name.toLowerCase();
  if (!/\.(txt|md|markdown)$/.test(name) && !file.type.startsWith("text/")) {
    throw new Error(
      "This build reads plain-text scripts only (PDF and DOCX extraction arrive with the script engine).",
    );
  }
  const text = await file.text();
  const parsed = parseScriptText(text);
  if (parsed.blocks.length === 0) throw new Error("No text found in that file");
  return parsed;
}
