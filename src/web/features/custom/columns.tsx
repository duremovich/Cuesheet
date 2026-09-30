// Grid columns for custom fields (R9): one column per field definition, keyed
// `custom.<key>`, with the grid's value shapes; and how an edit becomes an update of the
// row's `custom` JSON. Formula fields are computed per row (./formula.ts), cached per row
// object, and rebuilt when the columns are (the tab rebuilds them when data a formula or a
// link label reads changes).
import { type CustomFieldType, customColumnKey, customKeyOf } from "../../../shared/custom-fields";
import { type FormulaRecord, isQuantity, type Value } from "../../../shared/formula";
import type { Op } from "../../../shared/ops";
import type { CustomFieldRow, CustomValues, TableName } from "../../../shared/tables";
import type { Column, PickerItem } from "../../components/grid/types";
import type { ShowStore } from "../../lib/show-store";
import { attachmentColumn } from "../attachments/Attachments";
import { attachmentsOf } from "../attachments/selectors";
import type { FieldDef } from "../views/evaluate";
import { evaluateFormulaField, type FormulaScope } from "./formula";
import { searchTarget, targetLabel } from "./model";
import {
  formatDateTime,
  parseDate,
  parseDateTime,
  parseDuration,
  parseTimecode,
  parseUrl,
  urlHref,
} from "./values";

export interface CustomColumnsContext<V> {
  store: ShowStore;
  /** The table the rows live in (`cues`, `custom_rows`): ops and attachments. */
  table: TableName;
  rowOf: (v: V) => { id: string; custom: CustomValues };
  editable: boolean | ((v: V) => boolean);
  showId: string;
  /** The tab's own columns (formulas can read them by title or key). */
  baseColumns: readonly Column<V>[];
  /** Names the columns don't cover, for formulas (a surface's storage fields). */
  fallbackRecord?: (v: V) => FormulaRecord;
  /** Rows to infer a formula's result type from (number / length / text). */
  sampleRows?: readonly V[];
}

const DEFAULT_WIDTHS: Partial<Record<CustomFieldType, number>> = {
  checkbox: 90,
  number: 110,
  date: 120,
  datetime: 160,
  duration: 110,
  timecode: 120,
  measurement: 110,
  pixel_size: 120,
  longtext: 240,
  link: 200,
  attachment: 140,
};

type Parser = (text: string) => { value: string } | { error: string } | null;
const orEmpty =
  (p: Parser) =>
  (text: string): { value: unknown } | { error: string } =>
    p(text) ?? { value: "" };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Columns for `fields` (in order), after `ctx.baseColumns`. */
export function customColumns<V>(
  fields: readonly CustomFieldRow[],
  ctx: CustomColumnsContext<V>,
): FieldDef<V>[] {
  const { store, rowOf } = ctx;
  const value = (v: V, key: string) => rowOf(v).custom[key];
  const cols: FieldDef<V>[] = fields.map((f): FieldDef<V> => {
    const key = customColumnKey(f.key);
    const base = {
      key,
      title: f.label || f.key,
      width: f.width ?? DEFAULT_WIDTHS[f.type] ?? 160,
      editable: ctx.editable,
    };
    switch (f.type) {
      case "text":
        return {
          ...base,
          type: "text",
          getValue: (v) => str(value(v, f.key)),
          ...(f.options.sensitive ? { masked: true } : {}),
        };
      case "longtext":
        return { ...base, type: "longtext", getValue: (v) => str(value(v, f.key)) };
      case "url":
        return {
          ...base,
          type: "text",
          getValue: (v) => str(value(v, f.key)),
          parse: orEmpty(parseUrl),
          href: urlHref,
        };
      case "number": {
        const decimals = f.options.decimals;
        return {
          ...base,
          type: "number",
          getValue: (v) => {
            const x = value(v, f.key);
            return typeof x === "number" ? x : null;
          },
          ...(decimals !== undefined
            ? {
                format: (x: unknown) =>
                  typeof x === "number"
                    ? x.toLocaleString(undefined, {
                        minimumFractionDigits: decimals,
                        maximumFractionDigits: decimals,
                      })
                    : "",
              }
            : {}),
        };
      }
      case "checkbox":
        return { ...base, type: "checkbox", getValue: (v) => value(v, f.key) === true };
      case "select":
      case "multiselect":
        return {
          ...base,
          type: f.type,
          options: (f.options.choices ?? []).map((c) => ({ value: c.value, color: c.color })),
          getValue: (v) => {
            const x = value(v, f.key);
            if (f.type === "select") return typeof x === "string" ? x : null;
            return Array.isArray(x) ? x : [];
          },
        };
      case "date":
        return {
          ...base,
          type: "text",
          valueType: "date",
          getValue: (v) => str(value(v, f.key)),
          parse: orEmpty((t) => parseDate(t)),
        };
      case "datetime":
        return {
          ...base,
          type: "text",
          valueType: "date",
          getValue: (v) => str(value(v, f.key)),
          format: formatDateTime,
          parse: orEmpty((t) => parseDateTime(t)),
        };
      case "duration":
        return {
          ...base,
          type: "text",
          getValue: (v) => str(value(v, f.key)),
          parse: orEmpty(parseDuration),
        };
      case "timecode":
        return {
          ...base,
          type: "text",
          getValue: (v) => str(value(v, f.key)),
          parse: orEmpty(parseTimecode),
        };
      case "measurement":
        return {
          ...base,
          type: "measurement",
          getValue: (v) => {
            const x = value(v, f.key);
            return typeof x === "number" ? x : null;
          },
        };
      case "pixel_size":
        return {
          ...base,
          type: "pixelsize",
          getValue: (v) => (value(v, f.key) as { w: number; h: number } | undefined) ?? null,
        };
      case "link": {
        const target = f.options.target ?? "";
        const many = f.options.multiple !== false;
        const items = (v: V): PickerItem[] => {
          const ids = value(v, f.key);
          if (!Array.isArray(ids)) return [];
          const data = store.getState();
          return ids.flatMap((id) => {
            if (typeof id !== "string") return [];
            const label = targetLabel(data, target, id);
            return label === null ? [] : [{ id, label }];
          });
        };
        return {
          ...base,
          type: many ? "multilink" : "link",
          getValue: (v) => (many ? items(v) : (items(v)[0] ?? null)),
          search: (q) => searchTarget(store.getState(), target, q),
        };
      }
      case "attachment":
        return {
          ...attachmentColumn<V>({
            table: ctx.table,
            field: f.key,
            title: base.title,
            width: base.width,
            showId: ctx.showId,
            files: (v) =>
              attachmentsOf(store.getState().tables.attachments, ctx.table, rowOf(v).id, f.key),
            recordId: (v) => rowOf(v).id,
            editable: ctx.editable,
          }),
          key,
        };
      case "formula":
        return { ...base, type: "formula", editable: false, getValue: () => null };
      default:
        return { ...base, type: "text", getValue: (v) => str(value(v, f.key)) };
    }
  });
  // Formulas: evaluated over every column (so they can read each other), cached per row.
  const formulas = new Map(
    fields.filter((f) => f.type === "formula").map((f) => [customColumnKey(f.key), f] as const),
  );
  if (formulas.size === 0) return cols;
  const scope: FormulaScope<V> = {
    columns: [...ctx.baseColumns, ...cols],
    formulas,
    fallback: ctx.fallbackRecord,
  };
  const out = cols.map((c) => {
    const f = formulas.get(c.key);
    if (!f) return c;
    const cache = new WeakMap<object, Value>();
    const compute = (v: V): Value => {
      if (typeof v !== "object" || v === null) return evaluateFormulaField(scope, f, v);
      if (cache.has(v)) return cache.get(v) as Value;
      const r = evaluateFormulaField(scope, f, v);
      cache.set(v, r);
      return r;
    };
    return { ...c, getValue: compute };
  });
  scope.columns = [...ctx.baseColumns, ...out];
  // Result type (filters, sorting) from the first computed values.
  const sample = (ctx.sampleRows ?? []).slice(0, 50);
  return out.map((c) => {
    if (!formulas.has(c.key)) return c;
    return { ...c, resultType: inferResultType(sample.map((r) => c.getValue(r) as Value)) };
  });
}

/** A formula column's result type from sample values (numbers, lengths or text). */
export function inferResultType(values: readonly Value[]): "number" | "text" | "measurement" {
  for (const v of values) {
    if (v === null || (typeof v === "object" && !Array.isArray(v) && "error" in v)) continue;
    if (typeof v === "number") return "number";
    if (isQuantity(v)) return "measurement";
    return "text";
  }
  return "text";
}

/**
 * The ops for a grid edit of a custom column (key `custom.<key>`): the value in the
 * column's shape → the stored value (text "" / [] / false → cleared; links → ids).
 * Returns null for keys that aren't custom columns.
 */
export function customEditOps(
  table: TableName,
  id: string,
  fields: readonly CustomFieldRow[],
  columnKey: string,
  value: unknown,
): Op[] | null {
  const key = customKeyOf(columnKey);
  if (key === null) return null;
  const f = fields.find((x) => x.key === key);
  if (!f || f.type === "formula" || f.type === "attachment") return [];
  let stored: unknown = value;
  switch (f.type) {
    case "checkbox":
      stored = value === true ? true : null;
      break;
    case "multiselect":
      stored = Array.isArray(value) && value.length ? value : null;
      break;
    case "link": {
      const list = (Array.isArray(value) ? value : value ? [value] : []) as PickerItem[];
      stored = list.length ? list.map((p) => p.id) : null;
      break;
    }
    case "number":
    case "measurement":
      stored = typeof value === "number" ? value : null;
      break;
    case "pixel_size":
      stored = value ?? null;
      break;
    default:
      stored = typeof value === "string" && value.trim() !== "" ? value : null;
  }
  return [{ op: "update", table, id, fields: { custom: { [key]: stored } } }];
}
