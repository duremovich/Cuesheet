// Formula evaluation (R12). Errors are values (`{error, code}`), never exceptions: they
// propagate through operators and functions (except the branch IF doesn't take) and show
// in the cell. See ./index.ts for the language.
import {
  formatLength,
  fromMeters,
  isPixelSize,
  METERS_PER_INCH,
  type PixelSize,
  toMeters,
  type Unit,
} from "../units";
import type { BinaryOp, Node } from "./parser";

/** A length. Always meters; the unit travels with the value through arithmetic. */
export interface Quantity {
  value: number;
  unit: "m";
}

export type ErrorCode =
  | "#UNIT"
  | "#DIV/0"
  | "#VALUE"
  | "#NAME"
  | "#ERROR"
  | "#DEPTH"
  /** A sensitive custom field (formulas never read those, M5a). */
  | "#HIDDEN";

export interface FormulaError {
  error: string;
  code: ErrorCode;
}

/** What a formula yields. Lists come from links (`scenes.name`). */
export type Value =
  | null
  | number
  | string
  | boolean
  | Quantity
  | PixelSize
  | FormulaError
  | Value[];

/** A record a formula can read: its fields (and links, as record sets). */
export interface FormulaRecord {
  /** Shown when a formula returns the link itself. */
  label?: string;
  /** undefined = no such field (→ #NAME). */
  get(name: string): Value | RecordSet | undefined;
}

/** A link field's value: the linked records. */
export interface RecordSet {
  records: FormulaRecord[];
}

type Operand = Value | RecordSet;

// ---- guards ----

export function isQuantity(v: unknown): v is Quantity {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Quantity).unit === "m" &&
    typeof (v as Quantity).value === "number"
  );
}

export function isFormulaError(v: unknown): v is FormulaError {
  return typeof v === "object" && v !== null && typeof (v as FormulaError).error === "string";
}

function isRecordSet(v: unknown): v is RecordSet {
  return typeof v === "object" && v !== null && Array.isArray((v as RecordSet).records);
}

export const qty = (meters: number): Quantity => ({ value: meters, unit: "m" });
const err = (code: ErrorCode, error: string): FormulaError => ({ error, code });

// ---- evaluation ----

/** Evaluate a parsed formula against a record. Never throws. */
export function evaluate(ast: Node, record: FormulaRecord): Value {
  try {
    return finish(ev(ast, record));
  } catch (e) {
    // Only a bug (or a pathological nesting depth) gets here; still a value.
    return err("#ERROR", e instanceof Error ? e.message : String(e));
  }
}

/** A record set as a result: the linked records' labels. */
function finish(v: Operand): Value {
  if (isRecordSet(v)) return v.records.map((r) => r.label ?? "");
  return v;
}

function ev(n: Node, rec: FormulaRecord): Operand {
  switch (n.t) {
    case "num":
      return n.v;
    case "str":
      return n.v;
    case "bool":
      return n.v;
    case "ref": {
      const v = rec.get(n.name);
      return v === undefined ? err("#NAME", `Unknown field "${n.name}"`) : v;
    }
    case "member":
      return member(ev(n.obj, rec), n.name);
    case "neg": {
      const v = scalar(ev(n.arg, rec));
      if (isFormulaError(v) || v === null) return v;
      if (isQuantity(v)) return qty(-v.value);
      const x = toNumber(v);
      return isFormulaError(x) ? x : -x;
    }
    case "bin":
      return binary(n.op, scalar(ev(n.l, rec)), scalar(ev(n.r, rec)));
    case "call":
      return call(n.fn, n.args, rec);
  }
}

function member(obj: Operand, name: string): Operand {
  if (isFormulaError(obj)) return obj;
  if (isRecordSet(obj)) {
    const out: Value[] = [];
    for (const r of obj.records) {
      const v = r.get(name);
      if (v === undefined) return err("#NAME", `Unknown field "${name}"`);
      const x = finish(v);
      if (Array.isArray(x)) out.push(...x);
      else out.push(x);
    }
    return out;
  }
  if (isPixelSize(obj)) {
    if (name === "w" || name === "width") return obj.w;
    if (name === "h" || name === "height") return obj.h;
    return err("#NAME", `A pixel size has .w and .h, not .${name}`);
  }
  if (obj === null) return null;
  return err("#VALUE", `.${name} only applies to links and pixel sizes`);
}

/** One value from an operand: a single-item list is its item; a link is its labels. */
function scalar(v: Operand): Value {
  const x = finish(v);
  if (Array.isArray(x)) {
    if (x.length === 0) return null;
    if (x.length === 1) return x[0] as Value;
    const bad = x.find(isFormulaError);
    return bad ?? err("#VALUE", "Expected one value, got a list (use SUM, JOIN or LOOKUP)");
  }
  return x;
}

function toNumber(v: Value): number | FormulaError {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return v.trim() !== "" && Number.isFinite(n) ? n : err("#VALUE", `"${v}" is not a number`);
  }
  if (isQuantity(v)) return err("#UNIT", "Expected a plain number, got a length");
  if (isFormulaError(v)) return v;
  return err("#VALUE", "Expected a number");
}

function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (isQuantity(v)) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function binary(op: BinaryOp, a: Value, b: Value): Value {
  if (isFormulaError(a)) return a;
  if (isFormulaError(b)) return b;
  if (op === "&") return toText(a) + toText(b);
  if (op === "=" || op === "!=") {
    const eq = equals(a, b);
    if (isFormulaError(eq)) return eq;
    return op === "=" ? eq : !eq;
  }
  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    if (a === null || b === null) return null;
    const c = compare(a, b);
    if (isFormulaError(c)) return c;
    return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
  }
  // Arithmetic: a blank operand makes the result blank (a surface without a size has no PPI).
  if (a === null || b === null) return null;
  const qa = isQuantity(a);
  const qb = isQuantity(b);
  if (qa || qb) return quantityArithmetic(op, a, b);
  const x = toNumber(a);
  if (isFormulaError(x)) return x;
  const y = toNumber(b);
  if (isFormulaError(y)) return y;
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? err("#DIV/0", "Division by zero") : x / y;
    case "%":
      return y === 0 ? err("#DIV/0", "Division by zero") : x % y;
    case "^": {
      const r = x ** y;
      return Number.isFinite(r) ? r : err("#VALUE", "Result is not a finite number");
    }
  }
}

/** Arithmetic with at least one length: dimensions must work out. */
function quantityArithmetic(op: BinaryOp, a: Value, b: Value): Value {
  const qa = isQuantity(a) ? a : null;
  const qb = isQuantity(b) ? b : null;
  switch (op) {
    case "+":
    case "-": {
      if (!qa || !qb)
        return err("#UNIT", `Can't ${op === "+" ? "add" : "subtract"} a length and a number`);
      return qty(op === "+" ? qa.value + qb.value : qa.value - qb.value);
    }
    case "*": {
      if (qa && qb) return err("#UNIT", "Length × length (an area) isn't supported");
      const n = toNumber((qa ? b : a) as Value);
      if (isFormulaError(n)) return n;
      return qty((qa ?? (qb as Quantity)).value * n);
    }
    case "/": {
      if (qa && qb) return qb.value === 0 ? err("#DIV/0", "Division by zero") : qa.value / qb.value;
      if (qa) {
        const n = toNumber(b);
        if (isFormulaError(n)) return n;
        return n === 0 ? err("#DIV/0", "Division by zero") : qty(qa.value / n);
      }
      return err("#UNIT", "A number per length isn't supported (use PPI(pixels, length))");
    }
    default:
      return err("#UNIT", `"${op}" doesn't apply to lengths`);
  }
}

function equals(a: Value, b: Value): boolean | FormulaError {
  if (a === null || b === null) return (a === null || a === "") && (b === null || b === "");
  if (isQuantity(a) || isQuantity(b)) {
    if (!(isQuantity(a) && isQuantity(b)))
      return err("#UNIT", "Can't compare a length and a number");
    return Math.abs(a.value - b.value) < 1e-9;
  }
  if (typeof a === "string" || typeof b === "string") {
    return toText(a).toLowerCase() === toText(b).toLowerCase();
  }
  if (isPixelSize(a) && isPixelSize(b)) return a.w === b.w && a.h === b.h;
  const x = toNumber(a);
  const y = toNumber(b);
  if (isFormulaError(x) || isFormulaError(y)) return false;
  return x === y;
}

function compare(a: Value, b: Value): number | FormulaError {
  if (isQuantity(a) || isQuantity(b)) {
    if (!(isQuantity(a) && isQuantity(b)))
      return err("#UNIT", "Can't compare a length and a number");
    return a.value - b.value;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }
  const x = toNumber(a);
  if (isFormulaError(x)) return x;
  const y = toNumber(b);
  if (isFormulaError(y)) return y;
  return x - y;
}

// ---- text ----

/** Numbers: up to 10 significant digits, no trailing zeros. */
export function numberText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(10)));
}

/** A value as text (for &, CONCAT, text functions). Lengths use `unit` (default m). */
export function toText(v: Value, unit: Unit = "m"): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return numberText(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isQuantity(v)) return formatLength(v.value, unit);
  if (isFormulaError(v)) return v.code;
  if (Array.isArray(v)) return v.map((x) => toText(x, unit)).join(", ");
  if (isPixelSize(v)) return `${v.w}×${v.h}`;
  return "";
}

// ---- functions ----

/** Flatten function arguments into values (lists and links spread). */
function flat(args: Operand[]): Value[] {
  const out: Value[] = [];
  for (const a of args) {
    const v = finish(a);
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

const firstError = (vs: readonly Value[]): FormulaError | undefined => vs.find(isFormulaError);

function arity(fn: string, args: Node[], min: number, max = min): FormulaError | null {
  if (args.length < min || args.length > max) {
    const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`;
    return err("#ERROR", `${fn} takes ${want} argument${want === "1" ? "" : "s"}`);
  }
  return null;
}

/** Numbers or same-dimension lengths → MIN/MAX/SUM. */
function numeric(fn: string, values: Value[], combine: (xs: number[]) => number): Value {
  const bad = firstError(values);
  if (bad) return bad;
  const present = values.filter((v) => v !== null && v !== "");
  if (present.length === 0) return fn === "SUM" ? 0 : null;
  const lengths = present.filter(isQuantity);
  if (lengths.length > 0) {
    if (lengths.length !== present.length) {
      return err("#UNIT", `${fn} mixes lengths and plain numbers`);
    }
    return qty(combine(lengths.map((q) => q.value)));
  }
  const nums: number[] = [];
  for (const v of present) {
    const n = toNumber(v);
    if (isFormulaError(n)) return n;
    nums.push(n);
  }
  return combine(nums);
}

function lengthIn(unit: Unit, v: Value): Value {
  if (isFormulaError(v) || v === null) return v;
  // A length → a plain number in that unit; a number → a length in that unit.
  if (isQuantity(v)) return fromMeters(v.value, unit);
  const n = toNumber(v);
  return isFormulaError(n) ? n : qty(toMeters(n, unit));
}

function asLength(fn: string, v: Value): Quantity | FormulaError | null {
  if (v === null || isFormulaError(v)) return v;
  if (isQuantity(v)) return v;
  return err("#UNIT", `${fn} needs a length (a measurement field, or M(), IN() …)`);
}

function asNumber(v: Value): number | FormulaError | null {
  if (v === null || isFormulaError(v)) return v;
  return toNumber(v);
}

/**
 * Round half away from zero to `digits` decimals (negative: tens, hundreds…), correcting
 * binary representation error first so ROUND(1.005, 2) = 1.01 and ROUND(-2.5) = -3.
 */
export function roundHalfAway(n: number, digits: number): number {
  const f = 10 ** digits;
  const scaled = Number((Math.abs(n) * f).toPrecision(15));
  return (Math.sign(n) * Math.round(scaled)) / f || 0;
}

/** Common aspect ratios the text snaps to (within 1%), as [width, height, text]. */
const COMMON_ASPECTS: [number, number, string][] = [
  [16, 9, "16:9"],
  [16, 10, "16:10"],
  [4, 3, "4:3"],
  [21, 9, "21:9"],
  [32, 9, "32:9"],
  [1, 1, "1:1"],
  [2.35, 1, "2.35:1"],
];

/** Within 1% of each other. */
export function sameRatio(a: number, b: number): boolean {
  return Math.abs(a / b - 1) <= 0.01;
}

/**
 * "16:9", "16:10", "4:3", "21:9", "32:9", "1:1", "2.35:1" when within 1% of one of them
 * (portrait ones flipped: "9:16"), else "1.86:1" (or "1:1.86" portrait).
 */
export function aspectText(w: number, h: number): string {
  const r = w / h;
  const land = r >= 1 ? r : 1 / r;
  // The closest common ratio within 1% (21:9 and 2.35:1 are only 0.7% apart).
  let best: { text: string; off: number } | null = null;
  for (const [a, b, text] of COMMON_ASPECTS) {
    const off = Math.abs(land / (a / b) - 1);
    if (off <= 0.01 && (!best || off < best.off)) best = { text, off };
  }
  if (best) return r >= 1 ? best.text : best.text.split(":").reverse().join(":");
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

function call(fn: string, argNodes: Node[], rec: FormulaRecord): Operand {
  const arg = (i: number) => (argNodes[i] ? ev(argNodes[i] as Node, rec) : null);
  const one = (i: number) => scalar(arg(i));
  const bad = (vs: Value[]) => firstError(vs);
  switch (fn) {
    case "IF": {
      const a = arity(fn, argNodes, 2, 3);
      if (a) return a;
      const c = one(0);
      if (isFormulaError(c)) return c;
      return truthy(c) ? arg(1) : argNodes[2] ? arg(2) : null;
    }
    case "AND":
    case "OR": {
      const a = arity(fn, argNodes, 1, Infinity);
      if (a) return a;
      const vs = flat(argNodes.map((_, i) => arg(i)));
      const e = bad(vs);
      if (e) return e;
      return fn === "AND" ? vs.every(truthy) : vs.some(truthy);
    }
    case "NOT": {
      const a = arity(fn, argNodes, 1);
      if (a) return a;
      const v = one(0);
      return isFormulaError(v) ? v : !truthy(v);
    }
    case "ROUND": {
      const a = arity(fn, argNodes, 1, 2);
      if (a) return a;
      const v = one(0);
      const d = argNodes[1] ? asNumber(one(1)) : 0;
      if (isFormulaError(v)) return v;
      if (isFormulaError(d)) return d;
      if (v === null) return null;
      const digits = Math.trunc(d ?? 0);
      if (Math.abs(digits) > 20) return err("#VALUE", "ROUND takes -20 to 20 digits");
      if (isQuantity(v)) return qty(roundHalfAway(v.value, digits));
      const n = toNumber(v);
      return isFormulaError(n) ? n : roundHalfAway(n, digits);
    }
    case "ABS": {
      const a = arity(fn, argNodes, 1);
      if (a) return a;
      const v = one(0);
      if (v === null || isFormulaError(v)) return v;
      if (isQuantity(v)) return qty(Math.abs(v.value));
      const n = toNumber(v);
      return isFormulaError(n) ? n : Math.abs(n);
    }
    case "MIN":
    case "MAX":
    case "SUM": {
      const a = arity(fn, argNodes, 1, Infinity);
      if (a) return a;
      const vs = flat(argNodes.map((_, i) => arg(i)));
      return numeric(fn, vs, (xs) =>
        fn === "MIN"
          ? Math.min(...xs)
          : fn === "MAX"
            ? Math.max(...xs)
            : xs.reduce((s, x) => s + x, 0),
      );
    }
    case "COUNT": {
      const a = arity(fn, argNodes, 1, Infinity);
      if (a) return a;
      let n = 0;
      for (let i = 0; i < argNodes.length; i++) {
        const v = arg(i);
        if (isFormulaError(v)) return v;
        if (isRecordSet(v)) n += v.records.length;
        else if (Array.isArray(v)) n += v.filter((x) => x !== null && x !== "").length;
        else if (v !== null && v !== "") n += 1;
      }
      return n;
    }
    case "LOOKUP": {
      const a = arity(fn, argNodes, 1);
      if (a) return a;
      const v = finish(arg(0));
      if (Array.isArray(v)) {
        const e = bad(v);
        if (e) return e;
        return v.length === 0 ? null : v.length === 1 ? (v[0] as Value) : v;
      }
      return v;
    }
    case "JOIN": {
      const a = arity(fn, argNodes, 1, 2);
      if (a) return a;
      const vs = flat([arg(0)]);
      const sep = argNodes[1] ? one(1) : ", ";
      const e = bad([...vs, sep]);
      if (e) return e;
      return vs
        .filter((v) => v !== null && v !== "")
        .map((v) => toText(v))
        .join(toText(sep));
    }
    case "CONCAT": {
      const vs = flat(argNodes.map((_, i) => arg(i)));
      const e = bad(vs);
      return e ?? vs.map((v) => toText(v)).join("");
    }
    case "UPPER":
    case "LOWER":
    case "TRIM":
    case "LEN": {
      const a = arity(fn, argNodes, 1);
      if (a) return a;
      const v = one(0);
      if (isFormulaError(v)) return v;
      const s = toText(v);
      if (fn === "LEN") return s.length;
      return fn === "UPPER"
        ? s.toUpperCase()
        : fn === "LOWER"
          ? s.toLowerCase()
          : s.trim().replace(/\s+/g, " ");
    }
    case "LEFT":
    case "RIGHT": {
      const a = arity(fn, argNodes, 1, 2);
      if (a) return a;
      const v = one(0);
      const n = argNodes[1] ? asNumber(one(1)) : 1;
      if (isFormulaError(v)) return v;
      if (isFormulaError(n)) return n;
      const s = toText(v);
      const k = Math.max(0, Math.trunc(n ?? 0));
      return fn === "LEFT" ? s.slice(0, k) : k === 0 ? "" : s.slice(-k);
    }
    case "MID": {
      const a = arity(fn, argNodes, 3);
      if (a) return a;
      const v = one(0);
      const start = asNumber(one(1));
      const len = asNumber(one(2));
      if (isFormulaError(v)) return v;
      if (isFormulaError(start)) return start;
      if (isFormulaError(len)) return len;
      const from = Math.max(1, Math.trunc(start ?? 1)) - 1;
      return toText(v).slice(from, from + Math.max(0, Math.trunc(len ?? 0)));
    }
    case "FIND": {
      // FIND(needle, text, start?) → 1-based position, 0 when not found.
      const a = arity(fn, argNodes, 2, 3);
      if (a) return a;
      const needle = one(0);
      const hay = one(1);
      const start = argNodes[2] ? asNumber(one(2)) : 1;
      if (isFormulaError(needle)) return needle;
      if (isFormulaError(hay)) return hay;
      if (isFormulaError(start)) return start;
      const from = Math.max(1, Math.trunc(start ?? 1)) - 1;
      return toText(hay).indexOf(toText(needle), from) + 1;
    }
    case "M":
    case "CM":
    case "MM":
    case "IN":
    case "FT": {
      const a = arity(fn, argNodes, 1);
      if (a) return a;
      return lengthIn(fn.toLowerCase() as Unit, one(0));
    }
    case "PPI": {
      // PPI(pixels, length): pixels per inch.
      const a = arity(fn, argNodes, 2);
      if (a) return a;
      const px = asNumber(one(0));
      const len = asLength(fn, one(1));
      if (isFormulaError(px)) return px;
      if (isFormulaError(len)) return len;
      if (px === null || len === null) return null;
      if (len.value === 0) return err("#DIV/0", "The length is zero");
      return px / (len.value / METERS_PER_INCH);
    }
    case "PITCH": {
      // PITCH(length, pixels): millimeters per pixel.
      const a = arity(fn, argNodes, 2);
      if (a) return a;
      const len = asLength(fn, one(0));
      const px = asNumber(one(1));
      if (isFormulaError(len)) return len;
      if (isFormulaError(px)) return px;
      if (px === null || len === null) return null;
      if (px === 0) return err("#DIV/0", "The pixel count is zero");
      return (len.value * 1000) / px;
    }
    case "ASPECT": {
      // ASPECT(w, h): "16:9", or "1.78:1"; w and h both numbers or both lengths.
      const a = arity(fn, argNodes, 2);
      if (a) return a;
      const w = one(0);
      const h = one(1);
      if (isFormulaError(w)) return w;
      if (isFormulaError(h)) return h;
      if (w === null || h === null) return null;
      if (isQuantity(w) !== isQuantity(h))
        return err("#UNIT", "ASPECT mixes a length and a number");
      const x = isQuantity(w) ? w.value : toNumber(w);
      const y = isQuantity(h) ? h.value : toNumber(h);
      if (isFormulaError(x)) return x;
      if (isFormulaError(y)) return y;
      if (x <= 0 || y <= 0) return null;
      return aspectText(x, y);
    }
    default:
      return err("#NAME", `Unknown function ${fn}()`);
  }
}
