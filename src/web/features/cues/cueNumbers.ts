// Cue numbers (R3, ux.md §Inserting a cue): numbers are text; we only interpret plain
// decimals ("14.25"). Ghost suggestions for empty numbers, duplicate warnings and a
// warn-only pattern check.
import type { CellDecoration } from "../../components/grid/types";

const DECIMAL = /^\s*(\d+)(?:\.(\d+))?\s*$/;

/** The default cue-number pattern (warn only): 14, 14.25, 8.5A, 1.2.3. */
export const CUE_NUMBER_PATTERN = /^\d+(\.\d+)*[A-Za-z]*$/;

/** A plain decimal cue number as a number, else null ("8.5A", "", "x"). */
export function parseCueNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = DECIMAL.exec(s);
  return m ? Number.parseFloat(s) : null;
}

function decimalsOf(s: string): number {
  return DECIMAL.exec(s)?.[2]?.length ?? 0;
}

/**
 * The ghost number for a row between two numbered neighbours (as displayed):
 * 14.2 | 14.4 → 14.3; 14.20 | 14.25 → 14.22; after the last cue → the next whole number
 * (keeping the previous number's decimals: 14.20 → 15.00); before the first cue → the
 * midpoint from 0; no neighbours at all → "1". Undefined when a neighbour isn't a plain
 * decimal or there's no room (equal or descending neighbours, more than 4 decimals).
 */
export function suggestCueNumber(
  prev: string | undefined,
  next: string | undefined,
): string | undefined {
  if (prev === undefined && next === undefined) return "1";
  const a = prev === undefined ? 0 : parseCueNumber(prev);
  const b = next === undefined ? null : parseCueNumber(next);
  if (a === null) return undefined;
  if (next !== undefined && b === null) return undefined;
  if (b === null) return (Math.floor(a) + 1).toFixed(prev ? decimalsOf(prev) : 0);
  if (b <= a) return undefined;
  const start = Math.max(prev ? decimalsOf(prev) : 0, next ? decimalsOf(next) : 0);
  for (let d = start; d <= 4; d++) {
    const f = 10 ** d;
    const mid = Math.floor(((a + b) / 2) * f + 1e-9) / f;
    if (mid > a && mid < b) return mid.toFixed(d);
  }
  return undefined;
}

/** Two cue numbers name the same cue: equal text, or equal plain decimals (14.2 = 14.20). */
export function cueNumberKey(s: string): string {
  const n = parseCueNumber(s);
  return n === null ? `t:${s.trim().toLowerCase()}` : `n:${n}`;
}

export interface NumberedRow {
  id: string;
  number: string | null;
  isSection: boolean;
  /** Shown in the duplicate warning ("Duplicate of cue 14.20 (Sweet Sue…)"). */
  description?: string | null;
}

/** Where a row was inserted, relative to its display neighbour (see `cueNumberHints`). */
export interface InsertAnchor {
  after?: string;
  before?: string;
}

/**
 * Per-row decorations for the cue number column, keyed by row id:
 * - numbered rows: `warning` for duplicates, else for numbers not matching `pattern`;
 * - empty rows: `ghost` = `suggestCueNumber` between the nearest numbered rows before and
 *   after it in `display` (the rows in display order, all groups flattened). A row in
 *   `anchors` (just inserted under a live sort, which sorts empty numbers last while the
 *   grid still shows the row where it was inserted) takes its neighbours from its anchor.
 */
export function cueNumberHints(
  display: readonly NumberedRow[],
  anchors: ReadonlyMap<string, InsertAnchor> = new Map(),
  pattern: RegExp = CUE_NUMBER_PATTERN,
): Map<string, CellDecoration> {
  const rows = display.filter((r) => !r.isSection);
  const numbered = rows.filter((r) => r.number?.trim());
  const byKey = new Map<string, NumberedRow[]>();
  for (const r of numbered) {
    const k = cueNumberKey(r.number as string);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const out = new Map<string, CellDecoration>();
  const indexIn = new Map(numbered.map((r, i) => [r.id, i]));

  let lastNumbered = -1; // index into `numbered` of the latest numbered row seen
  for (const r of rows) {
    const num = r.number?.trim();
    if (num) {
      lastNumbered++;
      const same = byKey.get(cueNumberKey(num)) ?? [];
      if (same.length > 1) {
        const other = same.find((x) => x.id !== r.id) as NumberedRow;
        const desc = other.description?.trim();
        const short = desc && desc.length > 40 ? `${desc.slice(0, 39)}…` : desc;
        out.set(r.id, {
          warning: `Duplicate of cue ${other.number?.trim()}${short ? ` (${short})` : ""}`,
        });
      } else if (!pattern.test(num)) {
        out.set(r.id, { warning: "Unusual cue number (expected e.g. 14.25 or 8.5A)" });
      }
      continue;
    }
    let prevIdx = lastNumbered;
    let nextIdx = lastNumbered + 1;
    const anchor = anchors.get(r.id);
    const anchorId = anchor?.after ?? anchor?.before;
    const at = anchorId === undefined ? undefined : indexIn.get(anchorId);
    if (at !== undefined) {
      prevIdx = anchor?.after !== undefined ? at : at - 1;
      nextIdx = prevIdx + 1;
    }
    const ghost = suggestCueNumber(
      numbered[prevIdx]?.number?.trim() ?? undefined,
      numbered[nextIdx]?.number?.trim() ?? undefined,
    );
    if (ghost) out.set(r.id, { ghost });
  }
  return out;
}

/** Same entries (by value) → true. Lets the grid's `cellDecoration` keep its identity. */
export function hintsEqual(
  a: ReadonlyMap<string, CellDecoration>,
  b: ReadonlyMap<string, CellDecoration>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.ghost !== v.ghost || w.warning !== v.warning) return false;
  }
  return true;
}
