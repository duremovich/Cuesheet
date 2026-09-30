// Custom fields and custom tables (R9; data-model.md §Custom tables, §Field types).
// A custom field is a `custom_fields` row: `table` is a core table name ("cues") or
// `custom:<customTableId>`; `key` is a slug unique per table; values live in each row's
// `custom` JSON under that key. Shared by the op engine (validation) and the client
// (columns, editors, filters). No runtime dependencies.

import { parseDate, parseDateTime, parseDuration, parseTimecode } from "./custom-values";
import { isValidId } from "./ids";
import { isPixelSize, MAX_LENGTH_M, parseLength, parsePixelSize } from "./units";

export const CUSTOM_FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "checkbox",
  "select",
  "multiselect",
  "date",
  "datetime",
  "duration",
  "timecode",
  "measurement",
  "pixel_size",
  "url",
  "link",
  "attachment",
  "formula",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  checkbox: "Checkbox",
  select: "Single select",
  multiselect: "Multiple select",
  date: "Date",
  datetime: "Date and time",
  duration: "Duration",
  timecode: "Timecode",
  measurement: "Measurement",
  pixel_size: "Pixel size",
  url: "URL",
  link: "Link to records",
  attachment: "Attachments",
  formula: "Formula",
};

export function isCustomFieldType(v: unknown): v is CustomFieldType {
  return typeof v === "string" && (CUSTOM_FIELD_TYPES as readonly string[]).includes(v);
}

/** Core tables that can have custom fields (besides custom tables). */
export const CUSTOM_FIELD_CORE_TABLES = [
  "scenes",
  "cues",
  "content",
  "notes",
  "persons",
  "surfaces",
  "shots",
] as const;
export type CustomFieldCoreTable = (typeof CUSTOM_FIELD_CORE_TABLES)[number];

/** `custom:<id>`: a custom table as a field / view / link target. */
export type CustomTableRef = `custom:${string}`;
export const CUSTOM_PREFIX = "custom:";

export function customTableRef(id: string): CustomTableRef {
  return `custom:${id}`;
}

/** The custom table id of `custom:<id>`, or null. */
export function customTableId(table: string): string | null {
  if (!table.startsWith(CUSTOM_PREFIX)) return null;
  const id = table.slice(CUSTOM_PREFIX.length);
  return isValidId(id) ? id : null;
}

/** A table that can hold custom fields: a core table or `custom:<id>`. */
export function isFieldTable(t: unknown): t is CustomFieldCoreTable | CustomTableRef {
  if (typeof t !== "string") return false;
  return (CUSTOM_FIELD_CORE_TABLES as readonly string[]).includes(t) || customTableId(t) !== null;
}

/** A select option of a custom field. `color` is an option palette name. */
export interface CustomOption {
  value: string;
  color: string;
}

/** `custom_fields.options`: what each type uses. Unknown keys are dropped by the engine. */
export interface CustomFieldOptions {
  /** select / multiselect. */
  choices?: CustomOption[];
  /** link: the target table (core table name or `custom:<id>`). */
  target?: string;
  /** link: more than one record (default true). */
  multiple?: boolean;
  /** formula: the expression (`{Field label}` or keys). */
  formula?: string;
  /** number: decimals shown (0–8). */
  decimals?: number;
  /** measurement: a default unit shown in the Fields manager (display stays per view/user). */
  unit?: string;
  /** text: masked in the grid with a reveal button, kept out of history and exports. */
  sensitive?: boolean;
}

export interface CustomFieldDef {
  id: string;
  table: string;
  key: string;
  label: string | null;
  type: CustomFieldType;
  options: CustomFieldOptions;
  position: number | null;
  width: number | null;
}

/** Link targets a custom link field may name (core tables with a primary field). */
export const LINK_TARGET_TABLES = [
  "scenes",
  "cues",
  "content",
  "notes",
  "persons",
  "surfaces",
  "shots",
] as const;

export function isLinkTarget(t: unknown): boolean {
  return (
    typeof t === "string" &&
    ((LINK_TARGET_TABLES as readonly string[]).includes(t) || customTableId(t) !== null)
  );
}

export const MAX_KEY_LENGTH = 40;
const KEY_RE = /^[a-z][a-z0-9_]*$/;

/** Is `key` a valid custom field key (a lowercase slug)? */
export function isCustomKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= MAX_KEY_LENGTH && KEY_RE.test(key);
}

/** "Shoot day #2" → "shoot_day_2"; unique among `taken` (…_2, …_3). */
export function slugify(label: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH - 4);
  if (!base) base = "field";
  if (!/^[a-z]/.test(base)) base = `f_${base}`.slice(0, MAX_KEY_LENGTH - 4);
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
  return key;
}

/** Custom field values that aren't stored (computed, or files in the attachments table). */
export function isStoredType(t: CustomFieldType): boolean {
  return t !== "formula" && t !== "attachment";
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DURATION_RE = /^(\d+):([0-5]\d):([0-5]\d)(\.\d{1,3})?$/;
const TIMECODE_RE = /^(\d{2}):([0-5]\d):([0-5]\d)[:;](\d{2})$/;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

export const MAX_CUSTOM_TEXT = 100_000;

/**
 * Check one stored custom value against its field (null = clear it, always allowed).
 * Returns the normalised value or `{error}`. Links are checked for shape here; the engine
 * checks that each id exists in the target table.
 */
export function checkCustomValue(
  field: Pick<CustomFieldDef, "type" | "options" | "label" | "key">,
  value: unknown,
): { value: unknown } | { error: string } {
  const name = field.label || field.key;
  const bad = (what: string) => ({ error: `${name} must be ${what}` });
  if (value === null) return { value: null };
  switch (field.type) {
    case "text":
    case "longtext":
      if (typeof value !== "string") return bad("text");
      if (value.length > MAX_CUSTOM_TEXT) return bad("shorter");
      return { value };
    case "url": {
      if (typeof value !== "string") return bad("a URL");
      const t = value.trim();
      if (t.length > 2048) return bad("a shorter URL");
      if (/[\r\n]/.test(t) || !/^((https?:\/\/|mailto:)\S|[\w-]+(\.[\w-]+)+(\/|$))/i.test(t)) {
        return bad("a URL (https://…)");
      }
      return { value: t };
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return bad("a number");
      return { value };
    case "checkbox":
      if (typeof value !== "boolean") return bad("true or false");
      return { value };
    case "select": {
      const choices = field.options.choices ?? [];
      if (typeof value !== "string" || !choices.some((c) => c.value === value)) {
        return { error: `${name}: "${String(value)}" is not an option` };
      }
      return { value };
    }
    case "multiselect": {
      const choices = new Set((field.options.choices ?? []).map((c) => c.value));
      if (!Array.isArray(value)) return bad("a list");
      const seen = new Set<string>();
      for (const v of value) {
        if (typeof v !== "string" || !choices.has(v)) {
          return { error: `${name}: "${String(v)}" is not an option` };
        }
        if (seen.has(v)) return { error: `${name}: "${v}" is listed twice` };
        seen.add(v);
      }
      return { value };
    }
    case "date": {
      const m = typeof value === "string" ? DATE_RE.exec(value) : null;
      if (!m || !validDate(Number(m[1]), Number(m[2]), Number(m[3])))
        return bad("a YYYY-MM-DD date");
      return { value };
    }
    case "datetime": {
      const m = typeof value === "string" ? DATETIME_RE.exec(value) : null;
      if (
        !m ||
        !validDate(Number(m[1]), Number(m[2]), Number(m[3])) ||
        Number(m[4]) > 23 ||
        Number(m[5]) > 59
      ) {
        return bad("a YYYY-MM-DDTHH:MM date and time");
      }
      return { value };
    }
    case "duration":
      if (typeof value !== "string" || !DURATION_RE.test(value)) return bad("h:mm:ss(.ms)");
      return { value };
    case "timecode":
      if (typeof value !== "string" || !TIMECODE_RE.test(value)) return bad("hh:mm:ss:ff");
      return { value };
    case "measurement":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > MAX_LENGTH_M
      ) {
        return bad(`a length in meters (0–${MAX_LENGTH_M})`);
      }
      return { value };
    case "pixel_size":
      if (!isPixelSize(value)) return bad("{w, h} in whole pixels");
      return { value: { w: value.w, h: value.h } };
    case "link": {
      if (!Array.isArray(value) || !value.every(isValidId)) return bad("a list of record ids");
      if (new Set(value).size !== value.length) return bad("a list without repeats");
      if (field.options.multiple === false && value.length > 1) return bad("one record");
      if (value.length > 500) return bad("at most 500 records");
      return { value: value.length ? value : null };
    }
    case "attachment":
    case "formula":
      return { error: `${name} is not stored in the row (${field.type})` };
  }
}

/**
 * The engine's check of `custom_fields.options` for a type: known keys only, well-formed.
 * Returns the cleaned options or `{error}`.
 */
export function checkFieldOptions(
  type: CustomFieldType,
  raw: unknown,
): { options: CustomFieldOptions } | { error: string } {
  const o = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: CustomFieldOptions = {};
  if (type === "select" || type === "multiselect") {
    const list = o.choices ?? [];
    if (!Array.isArray(list) || list.length > 200) return { error: "choices must be a list" };
    const seen = new Set<string>();
    const choices: CustomOption[] = [];
    for (const c of list) {
      const ok =
        typeof c === "object" &&
        c !== null &&
        typeof (c as CustomOption).value === "string" &&
        (c as CustomOption).value.trim() !== "" &&
        (c as CustomOption).value.length <= 200;
      if (!ok) return { error: "each choice needs a value" };
      const value = (c as CustomOption).value;
      if (seen.has(value)) return { error: `choice "${value}" is listed twice` };
      seen.add(value);
      const color =
        typeof (c as CustomOption).color === "string" ? (c as CustomOption).color : "gray";
      choices.push({ value, color });
    }
    out.choices = choices;
  }
  if (type === "link") {
    if (!isLinkTarget(o.target)) return { error: "a link field needs a target table" };
    out.target = o.target as string;
    if (o.multiple === false) out.multiple = false;
  }
  if (type === "formula") {
    if (typeof o.formula !== "string" || o.formula.length > 10_000) {
      return { error: "a formula field needs an expression" };
    }
    out.formula = o.formula;
  }
  if (type === "number" && o.decimals !== undefined) {
    if (!Number.isInteger(o.decimals) || (o.decimals as number) < 0 || (o.decimals as number) > 8) {
      return { error: "decimals must be 0–8" };
    }
    out.decimals = o.decimals as number;
  }
  if (type === "measurement" && typeof o.unit === "string" && o.unit.length <= 8) out.unit = o.unit;
  if ((type === "text" || type === "longtext") && o.sensitive === true) out.sensitive = true;
  return { options: out };
}

/** Is this field's value hidden from history and exports? */
export function isSensitive(field: Pick<CustomFieldDef, "options">): boolean {
  return field.options.sensitive === true;
}

/** Changing a field's type keeps values only between these (they share a value shape). */
const TEXT_LIKE = new Set<CustomFieldType>(["text", "longtext", "url"]);
/**
 * Does changing a field from `from` to `to` keep its values? Same type; text ↔ long text ↔
 * URL; a (multi-)select to text / long text (a multi-select's choices joined by ", ").
 */
export function keepsValues(from: CustomFieldType, to: CustomFieldType): boolean {
  if (from === to) return true;
  if (TEXT_LIKE.has(from) && TEXT_LIKE.has(to)) return true;
  return (from === "select" || from === "multiselect") && (to === "text" || to === "longtext");
}

/**
 * A stored value after its field changed from `oldType` (or its options changed): kept when
 * it still fits, else null (cleared). A multi-select keeps the choices that still exist.
 * The engine and the client's optimistic mirror both use this.
 */
export function refitValue(
  old: { type: string; options?: CustomFieldOptions | undefined },
  def: Pick<CustomFieldDef, "type" | "options" | "label" | "key">,
  v: unknown,
): unknown {
  const oldType = old.type;
  const typeChanged = oldType !== def.type;
  if (typeChanged && !(isCustomFieldType(oldType) && keepsValues(oldType, def.type))) return null;
  if (!isStoredType(def.type)) return null;
  if (typeChanged && oldType === "multiselect" && Array.isArray(v)) {
    const text = v.filter((x) => typeof x === "string").join(", ");
    return text || null;
  }
  if (def.type === "link" && old.options) {
    // Another target table: the ids mean nothing there.
    if ((old.options.target ?? "") !== (def.options.target ?? "")) return null;
    // Many → one: keep the first.
    if (def.options.multiple === false && Array.isArray(v) && v.length > 1) v = [v[0]];
  }
  if (def.type === "multiselect" && Array.isArray(v)) {
    const ok = new Set((def.options.choices ?? []).map((c) => c.value));
    const kept = v.filter((x) => typeof x === "string" && ok.has(x));
    return kept.length ? kept : null;
  }
  const r = checkCustomValue(def, v);
  return "error" in r ? null : r.value;
}

/** The field table of a row: its core table, or `custom:<table_id>` for a custom row. */
export function fieldTableOf(table: string, row: { table_id?: unknown } | null): string | null {
  if ((CUSTOM_FIELD_CORE_TABLES as readonly string[]).includes(table)) return table;
  if (table === "custom_rows" && row && typeof row.table_id === "string") {
    return customTableRef(row.table_id);
  }
  return null;
}

/** The link target name a record of `table` answers to (custom rows: their table). */
export function targetNameOf(table: string, row: { table_id?: unknown }): string | null {
  if (table === "custom_rows") {
    return typeof row.table_id === "string" ? customTableRef(row.table_id) : null;
  }
  return (LINK_TARGET_TABLES as readonly string[]).includes(table) ? table : null;
}

/** How a custom field filters in a view (see views.ts `FieldKind`). */
export function customFieldKind(
  type: CustomFieldType,
): "text" | "number" | "measurement" | "checkbox" | "select" | "multi" | "link" | "date" {
  switch (type) {
    case "number":
      return "number";
    case "measurement":
      return "measurement";
    case "checkbox":
      return "checkbox";
    case "select":
      return "select";
    case "multiselect":
      return "multi";
    case "link":
      return "link";
    case "date":
    case "datetime":
      return "date";
    default:
      // Text-likes; formulas too (text's operators are a superset of number's and
      // measurement's, and the client picks by the computed result).
      return "text";
  }
}

/** The view field key (grid column key) of a custom field. */
export const customColumnKey = (key: string) => `custom.${key}`;

/** `custom.<key>` → key, or null. */
export function customKeyOf(columnKey: string): string | null {
  return columnKey.startsWith("custom.") ? columnKey.slice(7) : null;
}

// ---- Type guessing (CSV import) ----

const URL_VALUE = /^(https?:\/\/|www\.)\S/i;
const IP_VALUE = /^\d{1,3}(\.\d{1,3}){3}(\/\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const NUMBER_VALUE = /^-?\d+(\.\d+)?$/;

export interface FieldGuess {
  type: CustomFieldType;
  options: CustomFieldOptions;
}

/**
 * A field type for a CSV column from its header and values: URLs → url, "checked" →
 * checkbox, dates → date, IP addresses → text, a header naming a password → sensitive text,
 * numbers → number, a few repeated values in a status/type-like column → select, long or
 * multi-line values → long text, attachments → attachment; else text.
 */
export function guessFieldType(header: string, rawValues: readonly string[]): FieldGuess {
  const h = header.trim().toLowerCase();
  const values = rawValues.map((v) => v.trim()).filter(Boolean);
  if (/password|passcode|secret|pin code/.test(h)) {
    return { type: "text", options: { sensitive: true } };
  }
  if (/^(attachments?|photos?|images?|files?)$/.test(h)) return { type: "attachment", options: {} };
  if (values.length === 0) return { type: "text", options: {} };
  if (values.every((v) => v.toLowerCase() === "checked")) return { type: "checkbox", options: {} };
  if (values.every((v) => URL_VALUE.test(v))) return { type: "url", options: {} };
  if (values.every((v) => IP_VALUE.test(v))) return { type: "text", options: {} };
  if (values.every((v) => ISO_DATE.test(v) || US_DATE.test(v)))
    return { type: "date", options: {} };
  if (values.every((v) => NUMBER_VALUE.test(v))) return { type: "number", options: {} };
  if (values.some((v) => v.length > 100 || v.includes("\n"))) {
    return { type: "longtext", options: {} };
  }
  const distinct = [...new Set(values)];
  if (
    /(status|type|group|category|kind|state|stage)$/.test(h) &&
    distinct.length <= 12 &&
    distinct.every((v) => v.length <= 60)
  ) {
    const colors = ["blue", "green", "yellow", "purple", "orange", "teal", "pink", "red", "gray"];
    return {
      type: "select",
      options: {
        choices: distinct.map((value, i) => ({
          value,
          color: colors[i % colors.length] as string,
        })),
      },
    };
  }
  return { type: "text", options: {} };
}

/** A CSV cell as a value of a guessed field (null when empty or unparseable). */
export function csvValue(type: CustomFieldType, raw: string | undefined): unknown {
  const t = raw?.trim() ?? "";
  if (!t) return null;
  const parsed = (r: { value: unknown } | { error: string } | null) =>
    r && "value" in r ? r.value : null;
  switch (type) {
    case "multiselect": {
      const list = splitList(t);
      return list.length ? list : null;
    }
    case "datetime":
      return parsed(parseDateTime(t));
    case "duration":
      return parsed(parseDuration(t));
    case "timecode":
      return parsed(parseTimecode(t));
    case "measurement": {
      const r = parseLength(t, "m");
      return r && "m" in r ? r.m : null;
    }
    case "pixel_size": {
      const r = parsePixelSize(t);
      return r && !("error" in r) ? r : null;
    }
    case "checkbox":
      return t.toLowerCase() === "checked" || t.toLowerCase() === "true" || t === "1";
    case "number": {
      const n = Number(t.replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "date":
      return parsed(parseDate(t));
    case "url":
      return /^www\./i.test(t) ? `https://${t}` : t;
    case "select":
    case "text":
    case "longtext":
      return t;
    default:
      return null;
  }
}

/** A comma-separated cell as values ("A, B", with CSV quotes around values holding commas). */
export function splitList(cell: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i];
    if (ch === '"') {
      if (quoted && cell[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return [...new Set(out.map((x) => x.trim()).filter(Boolean))];
}
