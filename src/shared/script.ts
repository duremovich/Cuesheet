// The script (R20, decisions 0004 and 0007): extracted text, versions and cue anchors.
// Types shared by the Worker (routes/script.ts, the op engine), the anchoring engine
// (./script-anchor) and the web client (features/script). No runtime dependencies.
//
// Where things live: the extracted text of a version (`ScriptText`) is gzipped JSON in R2
// (`scriptTextKey`), never in the DO's SQLite (rows are capped at 512 KiB and scripts are
// bigger). The DO holds `scripts`, `script_versions` (with a compact `page_map`) and
// `cue_anchors` rows, which go through the op engine like every other table.

export type BlockKind = "heading" | "character" | "dialogue" | "direction" | "lyric" | "other";

export const BLOCK_KINDS: readonly BlockKind[] = [
  "heading",
  "character",
  "dialogue",
  "direction",
  "lyric",
  "other",
];

/**
 * One paragraph / line of the script. `i` is its index within the version (0-based, equal
 * to its position in `ScriptText.blocks`); `page` is the physical page (1-based);
 * `text` is normalized (`normalizeText`: NFKC, single spaces, trimmed, straight quotes).
 */
export interface ScriptBlock {
  i: number;
  page: number;
  kind: BlockKind;
  text: string;
}

/** Physical page (1-based) → printed label ("14", "14a"). */
export interface ScriptPageInfo {
  page: number;
  label: string;
}

export type ScriptSource = "pdf" | "docx" | "txt" | "ocr";

export const SCRIPT_SOURCES: readonly ScriptSource[] = ["pdf", "docx", "txt", "ocr"];

export interface ScriptText {
  blocks: ScriptBlock[];
  pages: ScriptPageInfo[];
  source: ScriptSource;
  /** 0..1: how much of the file had a usable text layer / structure. */
  confidence: number;
  /** Extraction warnings for the import dialog ("No page breaks found; …"). Optional. */
  warnings?: string[];
}

/**
 * Where a cue sits in one version's text. Positions are in the version's **joined text**:
 * block texts joined with a single space (`joinBlocks` in ./script-anchor). `block` +
 * `offset` is the start (offset within that block's text); `length` may run past the end
 * of the block into the following ones (a selection across lines). `quote` is the text
 * covered; `prefix`/`suffix` are up to ANCHOR_CONTEXT characters of joined text either
 * side. A positional cue (LX, timecode, visual) anchors at a block start with `quote` =
 * the nearest words (`makePositionAnchor`).
 */
export interface Anchor {
  block: number;
  offset: number;
  length: number;
  quote: string;
  prefix: string;
  suffix: string;
}

/** Characters of context kept either side of a quote. */
export const ANCHOR_CONTEXT = 32;

export type AnchorState = "matched" | "moved" | "changed" | "missing" | "manual";

export const ANCHOR_STATES: readonly AnchorState[] = [
  "matched",
  "moved",
  "changed",
  "missing",
  "manual",
];

/** Anchor states the resolve screen flags (ux.md §New script version). */
export const FLAGGED_STATES: readonly AnchorState[] = ["changed", "missing"];

export interface ReanchorCandidate {
  anchor: Anchor;
  score: number;
}

export interface ReanchorResult {
  cueId: string;
  from: Anchor;
  /** null when `missing`. */
  to: Anchor | null;
  state: AnchorState;
  /** 0..1. */
  confidence: number;
  /** Best alternatives (fuzzy), best first, at most 3; empty for exact matches. */
  candidates: ReanchorCandidate[];
}

/** Anchor counts by state (`script_versions.stats`). */
export type AnchorStats = Record<AnchorState, number>;

/**
 * Compact page lookup stored on `script_versions.page_map`: one entry per page, in block
 * order: the page's first block, its physical number and printed label. The DO derives
 * `cue_anchors.page` (and `cues.page`) from an anchor's block with it (`pageForBlock`).
 */
export interface PageMapEntry {
  startBlock: number;
  page: number;
  label: string;
}

// ---- normalization ----

const SINGLE_QUOTES = /[‘’‚‛′‵`´]/g;
const DOUBLE_QUOTES = /[“”„‟″‶«»]/g;
const DASHES = /[‐‑‒–—―−﹘﹣－]/g;
// Zero-width characters and soft hyphens vanish (PDFs are full of them).
const INVISIBLE = /[­​-‍⁠﻿]/g;

/**
 * The one normalization every script string goes through (block text at extraction,
 * quotes when matching): Unicode NFKC (so NBSP → space, "…" → "...", ligatures split),
 * curly quotes and primes → ' and ", every dash → "-", zero-width characters and soft
 * hyphens removed, whitespace runs → one space, trimmed.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- page map ----

/** The compact `page_map` for a version's text (one entry per page that has blocks). */
export function buildPageMap(text: Pick<ScriptText, "blocks" | "pages">): PageMapEntry[] {
  const labels = new Map(text.pages.map((p) => [p.page, p.label]));
  const out: PageMapEntry[] = [];
  let last = Number.NaN;
  for (const b of text.blocks) {
    if (b.page !== last) {
      out.push({ startBlock: b.i, page: b.page, label: labels.get(b.page) ?? String(b.page) });
      last = b.page;
    }
  }
  return out;
}

/** The page entry a block is on (last entry starting at or before it), or null. */
export function pageForBlock(map: readonly PageMapEntry[], block: number): PageMapEntry | null {
  let lo = 0;
  let hi = map.length - 1;
  let found: PageMapEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = map[mid] as PageMapEntry;
    if (e.startBlock <= block) {
      found = e;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Is `v` a well-formed page map (entries in increasing block order)? */
export function isPageMap(v: unknown): v is PageMapEntry[] {
  if (!Array.isArray(v)) return false;
  let prev = -1;
  for (const e of v) {
    if (!e || typeof e !== "object") return false;
    const { startBlock, page, label } = e as Record<string, unknown>;
    if (!Number.isInteger(startBlock) || (startBlock as number) <= prev) return false;
    if (!Number.isInteger(page) || (page as number) < 1) return false;
    if (typeof label !== "string" || label.length > 20) return false;
    prev = startBlock as number;
  }
  return true;
}

// ---- validation of uploaded text (Worker) ----

/** Largest accepted script: blocks, and characters per block. */
export const MAX_SCRIPT_BLOCKS = 50_000;
export const MAX_BLOCK_CHARS = 20_000;
export const MAX_SCRIPT_PAGES = 5_000;

/**
 * A ScriptText from untrusted JSON: blocks renumbered in order, texts normalized, empty
 * blocks dropped, pages sorted and deduplicated, confidence clamped. Error message for
 * the user otherwise.
 */
export function sanitizeScriptText(v: unknown): { text: ScriptText } | { error: string } {
  if (!v || typeof v !== "object") return { error: "text must be an object" };
  const raw = v as Record<string, unknown>;
  if (!Array.isArray(raw.blocks)) return { error: "text.blocks must be a list" };
  if (raw.blocks.length > MAX_SCRIPT_BLOCKS) {
    return { error: `A script can have at most ${MAX_SCRIPT_BLOCKS} blocks` };
  }
  const source = raw.source;
  if (typeof source !== "string" || !(SCRIPT_SOURCES as readonly string[]).includes(source)) {
    return { error: `text.source must be one of ${SCRIPT_SOURCES.join(", ")}` };
  }
  const blocks: ScriptBlock[] = [];
  let lastPage = 1;
  for (const b of raw.blocks) {
    if (!b || typeof b !== "object") return { error: "text.blocks must hold objects" };
    const { page, kind, text } = b as Record<string, unknown>;
    if (typeof text !== "string") return { error: "every block needs text" };
    if (text.length > MAX_BLOCK_CHARS) return { error: "a block is too long" };
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > MAX_SCRIPT_PAGES) {
      return { error: "block pages must be whole numbers from 1" };
    }
    if ((page as number) < lastPage) return { error: "blocks must be in page order" };
    lastPage = page as number;
    const clean = normalizeText(text);
    if (!clean) continue;
    blocks.push({
      i: blocks.length,
      page: page as number,
      kind: (BLOCK_KINDS as readonly unknown[]).includes(kind) ? (kind as BlockKind) : "other",
      text: clean,
    });
  }
  if (blocks.length === 0) return { error: "The script has no text" };
  const labels = new Map<number, string>();
  if (Array.isArray(raw.pages)) {
    for (const p of raw.pages) {
      if (!p || typeof p !== "object") continue;
      const { page, label } = p as Record<string, unknown>;
      if (!Number.isInteger(page) || typeof label !== "string") continue;
      const l = normalizeText(label).slice(0, 20);
      if (l) labels.set(page as number, l);
    }
  }
  const pageNumbers = [...new Set(blocks.map((b) => b.page))];
  const pages = pageNumbers.map((page) => ({ page, label: labels.get(page) ?? String(page) }));
  const c =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : 1;
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === "string").slice(0, 20)
    : undefined;
  return {
    text: {
      blocks,
      pages,
      source: source as ScriptSource,
      confidence: Math.min(1, Math.max(0, c)),
      ...(warnings?.length ? { warnings } : {}),
    },
  };
}

// ---- storage and HTTP ----

/** R2 key of a version's gzipped ScriptText JSON. */
export function scriptTextKey(showId: string, versionId: string): string {
  return `shows/${showId}/script/${versionId}.json.gz`;
}

export function scriptTextUrl(showId: string, versionId: string): string {
  return `/api/shows/${encodeURIComponent(showId)}/script/versions/${encodeURIComponent(versionId)}/text`;
}

/** The attachment field a version's original file is uploaded to. */
export const SCRIPT_SOURCE_FIELD = "source_file";

/** POST /api/shows/:id/script/versions */
export interface CreateScriptVersionRequest {
  /** Client-generated UUIDv7 (optional): lets the client upload the original right after. */
  versionId?: string;
  label: string;
  text: ScriptText;
  /** Re-anchor from this version instead of the current one (optional). */
  baseVersionId?: string;
  /** Title for the show's script when this creates it (default: the label). */
  title?: string;
  /** The sending store's id, echoed in the broadcast (like /mutate). */
  clientId?: string;
}

export interface CreateScriptVersionResponse {
  scriptId: string;
  versionId: string;
  /** The version re-anchored from (null for the first version). */
  baseVersionId: string | null;
  results: ReanchorResult[];
  stats: AnchorStats;
}

/** POST /api/shows/:id/script/versions/:vid/reanchor */
export interface ReanchorRequest {
  baseVersionId: string;
}

export interface ReanchorResponse {
  versionId: string;
  baseVersionId: string;
  results: ReanchorResult[];
  stats: AnchorStats;
}
