// Lengths and pixel sizes (R11): parsing what people type ("4.5", "450cm", "14'9\"",
// "14 ft 9 in", "1920x1080") and formatting in a display unit. Measurements are stored in
// meters (a plain number); the unit is only a display/input preference: the view's
// override, else the user's, else the show's default (see CLAUDE.md "Units"). Pure, no
// dependencies, used by the Worker (validation) and the web client (cells, filters,
// formulas, the surface calculator).

export const UNITS = ["m", "cm", "mm", "ft-in", "ft", "in"] as const;
export type Unit = (typeof UNITS)[number];

/** The three units the toolbar toggle offers (every unit is accepted on input). */
export const TOGGLE_UNITS: readonly Unit[] = ["m", "cm", "ft-in"];

/** What a show uses when nothing else is set. */
export const FALLBACK_UNIT: Unit = "m";

export const UNIT_LABELS: Record<Unit, string> = {
  m: "Meters (m)",
  cm: "Centimeters (cm)",
  mm: "Millimeters (mm)",
  "ft-in": "Feet and inches (ft-in)",
  ft: "Feet (ft)",
  in: "Inches (in)",
};

export function isUnit(v: unknown): v is Unit {
  return typeof v === "string" && (UNITS as readonly string[]).includes(v);
}

export const METERS_PER_INCH = 0.0254;
export const METERS_PER_FOOT = 0.3048;

/** Meters per one of each unit (ft-in counts in feet when a number has no unit). */
const FACTOR: Record<Unit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  "ft-in": METERS_PER_FOOT,
  ft: METERS_PER_FOOT,
  in: METERS_PER_INCH,
};

/** A length in `unit` → meters. */
export function toMeters(value: number, unit: Unit): number {
  return value * FACTOR[unit];
}

/** Meters → a number in `unit` (ft-in: decimal feet). */
export function fromMeters(m: number, unit: Unit): number {
  return m / FACTOR[unit];
}

/**
 * Two stored lengths are the same when they differ by less than this (0.02 mm): the editor
 * text round-trips to within it, so opening and committing a cell unchanged writes nothing.
 */
export const LENGTH_EPSILON = 2e-5;

export function lengthsEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < LENGTH_EPSILON;
}

// ---- parsing ----

export type LengthParse = { m: number } | { error: string } | null;

/** Unit words and symbols → the unit they name. */
const UNIT_WORDS: Record<string, "m" | "cm" | "mm" | "ft" | "in"> = {
  m: "m",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  cm: "cm",
  centimeter: "cm",
  centimeters: "cm",
  centimetre: "cm",
  centimetres: "cm",
  mm: "mm",
  millimeter: "mm",
  millimeters: "mm",
  millimetre: "mm",
  millimetres: "mm",
  ft: "ft",
  foot: "ft",
  feet: "ft",
  "'": "ft",
  in: "in",
  inch: "in",
  inches: "in",
  '"': "in",
};

interface Part {
  value: number;
  unit: "m" | "cm" | "mm" | "ft" | "in" | null;
}

/**
 * Text → meters. Accepts a number in `unit` ("4.5"; in ft-in, decimal feet), a number with
 * a unit ("4.5 m", "450cm", "1,200 mm", "177in", "14.75ft", "14'", "9\""), feet and inches
 * ("14'9\"", "14' 9\"", "14' 9", "14 ft 9 in", with fractions: "9 1/2\"", "14' 3/4\"").
 * Empty text → null (clear); anything else, including negatives → `{error}`.
 */
export function parseLength(text: string, unit: Unit): LengthParse {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″”“]|''/g, '"')
    // Thousands separators: "1,200" → "1200" (a lone comma stays and fails below).
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  if (t === "") return null;
  if (/^[-−–]/.test(t) || /\s[-−–]\s*\d/.test(t)) return { error: "Lengths can't be negative" };
  const parts: Part[] = [];
  const re = /\s*(\d+(?:\.\d*)?|\.\d+)(?:\s+(\d+)\s*\/\s*(\d+)|\s*\/\s*(\d+))?\s*([a-z]+|'|")?/y;
  let pos = 0;
  while (pos < t.length) {
    re.lastIndex = pos;
    const m = re.exec(t);
    if (!m || m[0].length === 0) return { error: `Not a length: "${text.trim()}"` };
    pos = re.lastIndex;
    let value = Number(m[1]);
    if (m[2] !== undefined && m[3] !== undefined) {
      // Mixed number "9 1/2".
      const den = Number(m[3]);
      if (den === 0) return { error: "Division by zero in a fraction" };
      value += Number(m[2]) / den;
    } else if (m[4] !== undefined) {
      // Plain fraction "3/4".
      const den = Number(m[4]);
      if (den === 0) return { error: "Division by zero in a fraction" };
      value /= den;
    }
    const word = m[5];
    let u: Part["unit"] = null;
    if (word !== undefined) {
      const hit = UNIT_WORDS[word];
      if (!hit) return { error: `Unknown unit "${word}"` };
      u = hit;
    }
    if (!Number.isFinite(value)) return { error: `Not a length: "${text.trim()}"` };
    parts.push({ value, unit: u });
    if (/^\s*$/.test(t.slice(pos))) break;
  }
  if (parts.length === 0) return { error: `Not a length: "${text.trim()}"` };
  if (parts.length === 1) {
    const [p] = parts as [Part];
    return { m: p.unit ? toMeters(p.value, p.unit) : toMeters(p.value, unit) };
  }
  if (parts.length === 2) {
    const [a, b] = parts as [Part, Part];
    // Feet then inches: "14' 9", "14 ft 9 in", "14' 9 1/2\"".
    if (a.unit === "ft" && (b.unit === "in" || b.unit === null)) {
      return { m: toMeters(a.value, "ft") + toMeters(b.value, "in") };
    }
    // "1 m 20 cm", "2 m 5 mm", "20 cm 5 mm": larger unit first, both explicit.
    if (a.unit && b.unit && FACTOR[a.unit] > FACTOR[b.unit]) {
      return { m: toMeters(a.value, a.unit) + toMeters(b.value, b.unit) };
    }
  }
  return { error: `Not a length: "${text.trim()}"` };
}

// ---- formatting ----

/** Default rounding of the ft-in display: to the nearest 1/8 inch. */
export const FT_IN_DENOMINATOR = 8;

export interface FormatOptions {
  /** ft-in: round the inches to 1/denominator (default 8). */
  denominator?: number;
}

const DECIMALS: Record<Exclude<Unit, "ft-in">, number> = { m: 2, cm: 1, mm: 0, in: 1, ft: 2 };

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** Inches (≥ 0) as `9`, `9 1/2`, `3/4` at 1/`den` precision (already rounded). */
function inchesText(inches: number, den: number): string {
  const whole = Math.floor(inches + 1e-9);
  const num = Math.round((inches - whole) * den);
  if (num === 0) return String(whole);
  const g = gcd(num, den);
  const frac = `${num / g}/${den / g}`;
  return whole === 0 ? frac : `${whole} ${frac}`;
}

/** Meters in feet and inches, inches rounded to 1/`den`: `14' 9 1/8"`, `0' 6"`. */
function feetInches(m: number, den: number): string {
  const totalInches = Math.round((fromMeters(m, "in") + Number.EPSILON) * den) / den;
  const feet = Math.floor(totalInches / 12 + 1e-9);
  const inches = Math.max(0, totalInches - feet * 12);
  return `${feet}' ${inchesText(inches, den)}"`;
}

/**
 * Display parts of a length: the number and the unit label shown muted beside it (ft-in
 * has its own ' and " marks and no label). m 2 dp, cm 1 dp, mm 0 dp, in 1 dp, ft 2 dp,
 * ft-in to the nearest 1/8".
 */
export function formatLengthParts(
  m: number,
  unit: Unit,
  opts: FormatOptions = {},
): { value: string; label: string } {
  if (unit === "ft-in") {
    return { value: feetInches(m, opts.denominator ?? FT_IN_DENOMINATOR), label: "" };
  }
  return { value: fromMeters(m, unit).toFixed(DECIMALS[unit]), label: unit };
}

/** A length as text in `unit`: "4.50 m", "450.0 cm", `14' 9 1/8"`. */
export function formatLength(m: number, unit: Unit, opts: FormatOptions = {}): string {
  const { value, label } = formatLengthParts(m, unit, opts);
  return label ? `${value} ${label}` : value;
}

/** Trim a fixed-point string's trailing zeros ("4.50000" → "4.5", "3.000" → "3"). */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * The text an editor starts with: precise enough that committing it unchanged is a no-op
 * (within LENGTH_EPSILON), in `unit`, with its unit so it parses back in any unit:
 * "4.5 m", "137.16 cm", `14' 9.165"` (or `4' 6"` / `4' 6 1/2"` when exact to 1/16").
 */
export function editLength(m: number, unit: Unit): string {
  if (unit === "ft-in") {
    const totalIn = fromMeters(m, "in");
    const sixteenths = Math.round(totalIn * 16);
    if (Math.abs(totalIn * 16 - sixteenths) < 1e-6) return feetInches(m, 16);
    const feet = Math.floor(totalIn / 12);
    return `${feet}' ${trimZeros((totalIn - feet * 12).toFixed(3))}"`;
  }
  const digits = { m: 5, cm: 3, mm: 2, in: 3, ft: 5 }[unit];
  return `${trimZeros(fromMeters(m, unit).toFixed(digits))} ${unit}`;
}

// ---- pixel sizes ----

export interface PixelSize {
  w: number;
  h: number;
}

export type PixelSizeParse = PixelSize | { error: string } | null;

/** Largest accepted pixel dimension (a 32K canvas is already generous). */
export const MAX_PIXELS = 100_000;

/** A stored pixel size is valid: positive whole numbers up to MAX_PIXELS. */
export function isPixelSize(v: unknown): v is PixelSize {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const ok = (n: unknown) =>
    Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_PIXELS;
  return Object.keys(o).length === 2 && ok(o.w) && ok(o.h);
}

/** "1920x1080", "1920 × 1080", "1920 X 1080", "1920*1080", "1920, 1080" → {w, h}. */
export function parsePixelSize(text: string): PixelSizeParse {
  const t = text.trim();
  if (t === "") return null;
  const m = /^(\d+)\s*(?:px)?\s*(?:[x×*,]|\s)\s*(\d+)\s*(?:px)?$/i.exec(t);
  if (!m) return { error: `Not a pixel size: "${t}" (try 1920x1080)` };
  const size = { w: Number(m[1]), h: Number(m[2]) };
  if (!isPixelSize(size)) return { error: `Pixel sizes are 1–${MAX_PIXELS} on each side` };
  return size;
}

export function formatPixelSize(p: PixelSize): string {
  return `${p.w}×${p.h}`;
}
