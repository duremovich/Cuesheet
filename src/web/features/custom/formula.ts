// Formula custom fields (R9, R12): user formulas evaluated per row on the client with the
// shared engine (src/shared/formula). A row reads as a formula record whose fields are the
// table's grid columns and custom fields, named by label ("{Pixel width}", "{PPI}") or key
// ("ppi", "custom_key"), case-insensitively; a tab may add a fallback record (a surface's
// storage fields). Links are record sets (`{Network}.IP`). Formula fields may use other
// formula fields; a cycle is an error value ("#ERROR: circular reference"), never a hang.
import {
  type CompiledFormula,
  compile,
  dependencies,
  type FormulaError,
  type FormulaRecord,
  isFormulaError,
  qty,
  type RecordSet,
  run,
  type Value,
} from "../../../shared/formula";
import type { CustomFieldRow } from "../../../shared/tables";
import { isPixelSize } from "../../../shared/units";
import type { Column, PickerItem } from "../../components/grid/types";

const norm = (s: string) => s.trim().toLocaleLowerCase();

const compiled = new Map<string, CompiledFormula | FormulaError>();
/** Compile once per source text (formulas are shared by every row). */
export function compileCached(source: string): CompiledFormula | FormulaError {
  let c = compiled.get(source);
  if (!c) {
    c = compile(source);
    if (compiled.size > 500) compiled.clear();
    compiled.set(source, c);
  }
  return c;
}

/** The field names a formula reads (for "uses" hints and dependency checks). */
export function formulaDependencies(source: string): string[] {
  const c = compileCached(source);
  return isFormulaError(c) ? [] : c.deps;
}

/** A grid value as a formula value (links become record sets of labels). */
export function columnValue(col: Pick<Column<unknown>, "type">, v: unknown): Value | RecordSet {
  if (v === undefined || v === null || v === "") return null;
  switch (col.type) {
    case "measurement":
      return typeof v === "number" ? qty(v) : null;
    case "pixelsize":
      return isPixelSize(v) ? { w: v.w, h: v.h } : null;
    case "number":
      return typeof v === "number" ? v : null;
    case "checkbox":
      return !!v;
    case "multiselect":
      return Array.isArray(v) ? (v as string[]) : null;
    case "link":
    case "multilink": {
      const items = (Array.isArray(v) ? v : [v]) as PickerItem[];
      return {
        records: items.map((p) => ({
          label: p.label,
          get: (name: string) => (norm(name) === "name" ? p.label : undefined),
        })),
      };
    }
    case "attachment":
      return Array.isArray(v) ? v.length : null;
    case "formula":
      return v as Value;
    default:
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? v
        : String(v);
  }
}

export interface FormulaScope<V> {
  /** Every column of the row's table (core columns and custom field columns). */
  columns: readonly Column<V>[];
  /** Formula custom fields by column key (so they can reference each other). */
  formulas: ReadonlyMap<string, CustomFieldRow>;
  /** Names the columns don't cover (e.g. a surface's `pixel_width`). */
  fallback?: ((v: V) => FormulaRecord) | undefined;
}

const circular: FormulaError = {
  error: "Circular reference between formula fields",
  code: "#ERROR",
};

/**
 * Evaluate the formula field `field` for row `v`. `visiting` holds the formula fields being
 * evaluated up the stack (a cycle yields an error value).
 */
export function evaluateFormulaField<V>(
  scope: FormulaScope<V>,
  field: CustomFieldRow,
  v: V,
  visiting: Set<string> = new Set(),
): Value {
  const source = field.options.formula ?? "";
  if (!source.trim()) return null;
  if (visiting.has(field.id)) return circular;
  const f = compileCached(source);
  if (isFormulaError(f)) return f;
  const next = new Set(visiting).add(field.id);
  return run(f, rowRecord(scope, v, next));
}

/** Row `v` as a formula record over the scope's columns. */
export function rowRecord<V>(
  scope: FormulaScope<V>,
  v: V,
  visiting: Set<string> = new Set(),
): FormulaRecord {
  const byName = nameIndex(scope.columns);
  const fallback = scope.fallback?.(v);
  return {
    get(name) {
      const col = byName.get(norm(name));
      if (col) {
        const formula = scope.formulas.get(col.key);
        if (formula) return evaluateFormulaField(scope, formula, v, visiting);
        return columnValue(col, col.getValue(v));
      }
      return fallback?.get(name);
    },
  };
}

const indexCache = new WeakMap<readonly unknown[], Map<string, Column<unknown>>>();
/** Column by lowercased title, key, and a custom column's bare key. First wins. */
function nameIndex<V>(columns: readonly Column<V>[]): Map<string, Column<V>> {
  let m = indexCache.get(columns) as Map<string, Column<V>> | undefined;
  if (m) return m;
  m = new Map();
  for (const c of columns) {
    for (const n of [c.title, c.key, c.key.startsWith("custom.") ? c.key.slice(7) : ""]) {
      const k = norm(n);
      if (k && !m.has(k)) m.set(k, c);
    }
  }
  indexCache.set(columns as readonly unknown[], m as Map<string, Column<unknown>>);
  return m;
}

/** Does this formula read a linked record's field (then it depends on other rows)? */
export function readsLinks(source: string): boolean {
  return formulaDependencies(source).some((d) => d.includes("."));
}

export { dependencies };
