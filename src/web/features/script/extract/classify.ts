// Block kinds and page labels from text alone, shared by the PDF, DOCX and text extractors.
// Heuristics for theatre scripts: character names are short ALL-CAPS lines followed by
// dialogue (or a sung line, unless the name itself looks sung); directions are
// parenthesized/bracketed or mostly italic; headings are whole lines like "ACT ONE",
// "SCENE 3: THE TRAIN", "No. 4 - VAMP" with no lowercase words; lyrics are ALL-CAPS speech.
import {
  type BlockKind,
  normalizeText,
  type ScriptBlock,
  type ScriptPageInfo,
} from "../../../../shared/script";

/**
 * The start of a heading: "ACT ONE", "Scene 3", "PROLOGUE", "No. 4", "#12". Case-insensitive
 * here; the rest of the line must have no lowercase letters (`isHeading`), so "Act one more
 * time and I'll scream." and "No 2 ways about it" stay dialogue.
 */
const HEADING_START =
  /^(?:(?:act|scene)(?:\s+(?:[0-9]{1,3}[a-z]?|[ivx]{1,5}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)?|prologue|epilogue|entr'?acte|intermission|overture|finale|curtain call|bows|(?:no\.?|number|#)\s*\d+[a-z]?)(?![\p{L}])/iu;

/** A character's name line: "JOE", "SWEET SUE", "JERRY (as Daphne)", "OSGOOD (O.S.)". */
const CHARACTER = /^[A-Z][A-Z0-9.'&\- ]{0,28}[A-Z.)](?:\s*\([^)]{1,30}\))?:?$/;

export function isHeading(text: string): boolean {
  const m = HEADING_START.exec(text);
  return !!m && text.length <= 80 && !/\p{Ll}/u.test(text.slice(m[0].length));
}

/** Sung-sounding caps: apostrophes/hyphens ("RUNNIN'", "BOOP-BOOP") or vocables ("OH", "LA"). */
export function looksLikeLyric(text: string): boolean {
  const t = text.replace(/\s*\([^)]*\)\s*:?$/, "");
  return /['-]/.test(t) || /\b(?:OH|AH|LA|OOH|OOO|DOO|BOOP|YEAH|HEY|NA|DA|BA|WHOA|WOW)\b/.test(t);
}

/** Letters, and none of them lowercase. */
function allCaps(text: string): boolean {
  return /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text);
}

export function isCharacterCue(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 45 || isHeading(t)) return false;
  const name = t.replace(/\s*\([^)]*\)\s*:?$/, "").replace(/:$/, "");
  if (!CHARACTER.test(t) || name.split(/\s+/).length > 4) return false;
  // At least two letters, and not a sentence ("I DO." is dialogue in caps; names rarely end in ".")
  return (name.match(/[A-Z]/g)?.length ?? 0) >= 2 && !/[.!?]$/.test(name);
}

/** "(He exits.)", "[Lights fade]". */
export function isParenthetical(text: string): boolean {
  return /^\(.*\)$/s.test(text) || /^\[.*\]$/s.test(text);
}

/** Mostly capitals (a sung lyric in many musical scripts). */
export function isShouty(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 12) return false;
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  return upper / letters.length > 0.85;
}

/** What an extractor knows about a paragraph besides its text. */
export interface RawBlock {
  text: string;
  page: number;
  /** A kind the source states (a DOCX paragraph style). */
  kind?: BlockKind;
  /** Share of characters in italics (0..1). */
  italic?: number;
  /** Continues the previous block's speech (same indent, no gap: PDF layout). */
  continues?: boolean;
}

/**
 * Kinds for a run of paragraphs, and the final ScriptBlocks (normalized, empties dropped,
 * numbered). A source-stated kind wins; otherwise: heading → character → direction
 * (parenthesized, or ≥ 60% italic) → dialogue (right after a character, or continuing it;
 * ALL CAPS → lyric) → other.
 */
export function classifyBlocks(raw: readonly RawBlock[]): ScriptBlock[] {
  const out: ScriptBlock[] = [];
  const texts = raw.map((r) => normalizeText(r.text));
  /** The next non-empty paragraph after index i. */
  const nextText = (i: number): string | undefined => {
    for (let k = i + 1; k < texts.length; k++) if (texts[k]) return texts[k];
    return undefined;
  };
  // A speech runs from a character name through the block right after it and the blocks
  // the extractor says continue it (a PDF's dialogue indent).
  let inSpeech = false;
  raw.forEach((r, i) => {
    const text = texts[i] as string;
    if (!text) return;
    const prev: BlockKind | undefined = out.at(-1)?.kind;
    const speaking: boolean = inSpeech && (prev === "character" || !!r.continues);
    let kind: BlockKind;
    if (r.kind) kind = r.kind;
    else if (isHeading(text)) kind = "heading";
    else if (isCharacterName(text, nextText(i))) kind = "character";
    else if (isParenthetical(text) || (r.italic ?? 0) >= 0.6) kind = "direction";
    else if (speaking)
      kind = isShouty(text) || (allCaps(text) && looksLikeLyric(text)) ? "lyric" : "dialogue";
    else if (allCaps(text) && looksLikeLyric(text)) kind = "lyric";
    else kind = "other";
    inSpeech =
      kind === "character" ||
      (speaking && (kind === "dialogue" || kind === "lyric" || kind === "direction"));
    out.push({ i: out.length, page: r.page, kind, text });
  });
  return out;
}

/**
 * A character's name: a name-like caps line with something after it, which is either not
 * all caps (dialogue), or all caps (a sung line) when the name itself doesn't look sung.
 */
function isCharacterName(text: string, next: string | undefined): boolean {
  if (!isCharacterCue(text) || next === undefined) return false;
  return !allCaps(next) || !looksLikeLyric(text);
}

/** A printed page number as it appears in a margin: "14", "14a", "- 14 -", "Page 14", "I-3-14", "xii". */
const PAGE_LABEL =
  /^(?:page\s+)?[-–—(]?\s*((?:[0-9]{1,4}[a-z]{0,2})|(?:[ivxlc]{1,7})|(?:[ivx0-9]{1,4}[-.][0-9]{1,3}(?:[-.][0-9]{1,4}[a-z]?)?))\s*[-–—)]?\.?$/i;

export function pageLabelOf(line: string): string | null {
  const m = PAGE_LABEL.exec(normalizeText(line));
  return m?.[1] ?? null;
}

/** Page infos for pages 1..n, with the labels found (else the page number). */
export function pageInfos(pages: number[], labels: Map<number, string>): ScriptPageInfo[] {
  return pages.map((page) => ({ page, label: labels.get(page) ?? String(page) }));
}

/** Blocks per page when a source has no page breaks (roughly a printed script page). */
export const FALLBACK_BLOCKS_PER_PAGE = 40;

/** Assign pages by count when a source has none. */
export function paginateByCount(raw: RawBlock[], perPage = FALLBACK_BLOCKS_PER_PAGE): RawBlock[] {
  let n = 0;
  return raw.map((r) => {
    if (!normalizeText(r.text)) return { ...r, page: Math.floor(n / perPage) + 1 };
    const page = Math.floor(n / perPage) + 1;
    n++;
    return { ...r, page };
  });
}
