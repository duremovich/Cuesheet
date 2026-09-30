// The formula language (R12; data-model.md §Formulas). Deliberately small:
//
//   Literals     4.5  "text"  'text'  TRUE  FALSE        Fields  width  {Pixel width}
//   Operators    + - * / % ^   & (text join)   = != <> < <= > >=   unary -   ( )
//   Members      parent.width (a link's field; a list for many-links)   size.w / size.h
//   Logic        IF(c, a, b?)  AND(…)  OR(…)  NOT(x)
//   Numbers      ROUND(x, digits?)  MIN(…)  MAX(…)  ABS(x)
//   Text         CONCAT(…)  LEFT(s, n)  RIGHT(s, n)  MID(s, start, n)  UPPER  LOWER  TRIM
//                FIND(needle, s, start?) (1-based, 0 = not found)  LEN(s)
//   Links        LOOKUP(link.field)  COUNT(link)  SUM(link.field)  JOIN(link.field, sep?)
//   Units        M(x) CM(x) MM(x) IN(x) FT(x): a length → a plain number in that unit;
//                a number → a length in that unit (IN(12) = one foot)
//                PPI(pixels, length)  PITCH(length, pixels) (mm/px)  ASPECT(w, h) ("16:9")
//
// Measurement fields evaluate to lengths ({value, unit: "m"}). Arithmetic checks
// dimensions: length ± length, length × number, length ÷ number → length; length ÷ length
// → number; anything else with a length (length × length, number ÷ length, length + number)
// is a #UNIT error. A blank operand makes arithmetic blank. Errors are values
// (#UNIT, #DIV/0, #VALUE, #NAME, #ERROR) that propagate; nothing throws.
import { formatLength, type Unit } from "../units";
import {
  evaluate,
  type FormulaError,
  type FormulaRecord,
  isFormulaError,
  isQuantity,
  numberText,
  toText,
  type Value,
} from "./evaluate";
import { dependencies, type Node, parse } from "./parser";

export type {
  ErrorCode,
  FormulaError,
  FormulaRecord,
  Quantity,
  RecordSet,
  Value,
} from "./evaluate";
export { aspectText, evaluate, isFormulaError, isQuantity, qty } from "./evaluate";
export type { Node } from "./parser";
export { dependencies, parse } from "./parser";

export interface CompiledFormula {
  source: string;
  ast: Node;
  /** Fields it reads (see `dependencies`). */
  deps: string[];
}

/** Parse once, evaluate per row. A syntax error becomes a formula that yields it. */
export function compile(source: string): CompiledFormula | FormulaError {
  const r = parse(source);
  if ("error" in r) return { error: `${r.error} (at ${r.pos + 1})`, code: "#ERROR" };
  return { source, ast: r.ast, deps: dependencies(r.ast) };
}

export function run(f: CompiledFormula | FormulaError, record: FormulaRecord): Value {
  return isFormulaError(f) ? f : evaluate(f.ast, record);
}

/** Round a display number: `digits` decimals, trailing zeros dropped. */
function shortNumber(n: number, digits: number): string {
  return numberText(Number(n.toFixed(digits)));
}

/** A result as cell text: lengths in `unit`, numbers to `digits` (default 2) decimals. */
export function formatFormulaValue(v: Value, unit: Unit = "m", digits = 2): string {
  if (typeof v === "number") return shortNumber(v, digits);
  if (isQuantity(v)) return formatLength(v.value, unit);
  if (Array.isArray(v)) return v.map((x) => formatFormulaValue(x, unit, digits)).join(", ");
  return toText(v, unit);
}

/**
 * A result as a plain scalar for filters and sorting: lengths in meters, lists joined,
 * errors and blanks → null.
 */
export function formulaScalar(v: Value): number | string | boolean | null {
  if (v === null || isFormulaError(v)) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (isQuantity(v)) return v.value;
  return toText(v) || null;
}
