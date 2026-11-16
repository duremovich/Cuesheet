// Lookup custom fields (R9, R12; data-model.md §Field types): a field of the records linked
// through one of this table's link fields, like Airtable's lookup. Values are computed on
// the client (src/web/features/custom/lookup.ts), never stored. This module is what the
// server needs too: which fields a lookup can go through (and to which table), and what
// kind of values a lookup yields (links, select choices or anything else), so view
// validation agrees with the client's columns. No runtime dependencies.
import { type CustomFieldDef, customKeyOf, isFieldTable } from "./custom-fields";
import type { ViewFieldSpec } from "./views";

/**
 * The link-like columns of each core table a lookup can go through (the grid's column key
 * → the linked table): the many-links in LINKS, their reverse side where the tab shows it
 * (content's cues, surfaces' scenes and content) and single references (`scene`, `parent`,
 * `creator`). Custom link fields (`custom.<key>`) come on top.
 */
export const CORE_LINK_COLUMNS: Record<string, Record<string, string>> = {
  cues: { assignees: "persons", content: "content", scene: "scenes" },
  notes: { assignees: "persons", cues: "cues", content: "content", scene: "scenes" },
  content: { scene: "scenes", creator: "persons", cues: "cues", surfaces: "surfaces" },
  scenes: { surfaces: "surfaces" },
  persons: {},
  surfaces: { parent: "surfaces", scenes: "scenes", content: "content" },
  shots: { talent: "persons", content: "content" },
};

/** Custom fields of a field table (`cues`, `custom:<id>`). */
export type FieldsOf = (
  fieldTable: string,
) => readonly Pick<CustomFieldDef, "key" | "type" | "options" | "label">[];

/** The table a link column of `table` points at (`cues` → `content`), or null. */
export function linkTargetOf(table: string, column: string, fieldsOf: FieldsOf): string | null {
  const key = customKeyOf(column);
  if (key !== null) {
    const f = fieldsOf(table).find((x) => x.key === key);
    return f?.type === "link" && f.options.target ? f.options.target : null;
  }
  const links = Object.hasOwn(CORE_LINK_COLUMNS, table) ? CORE_LINK_COLUMNS[table] : undefined;
  return links && Object.hasOwn(links, column) ? (links[column] ?? null) : null;
}

/**
 * What a lookup yields: linked records (chips), select choices, or other values (text,
 * numbers, lengths…; shown and filtered like a formula's result).
 */
export type LookupKind = "link" | "multi" | "value";

export type LookupResolution =
  | { ok: true; kind: LookupKind; target: string; field: string }
  | { ok: false; error: string; code: "#NAME" | "#ERROR" };

/** Core column kinds, for a lookup's target (VIEW_FIELDS, injected to avoid a cycle). */
export type CoreFieldsOf = (table: string) => Record<string, ViewFieldSpec> | undefined;

/**
 * Follow a lookup field's configuration: its link column must be a link of its table, and
 * the field must exist on the linked table. A lookup of a lookup follows that one too (a
 * cycle is an error). The kind is the final field's: links → link, (multi-)selects →
 * multi, anything else → value.
 */
export function resolveLookup(
  field: Pick<CustomFieldDef, "table" | "key" | "options" | "label">,
  fieldsOf: FieldsOf,
  coreFieldsOf: CoreFieldsOf,
  seen: ReadonlySet<string> = new Set(),
): LookupResolution {
  const name = field.label || field.key;
  const here = `${field.table}.${field.key}`;
  if (seen.has(here)) {
    return { ok: false, error: `${name}: circular reference between lookups`, code: "#ERROR" };
  }
  const link = field.options.link ?? "";
  const target = linkTargetOf(field.table, link, fieldsOf);
  if (!target || !isFieldTable(target)) {
    return { ok: false, error: `${name}: no link field "${link}" on this table`, code: "#NAME" };
  }
  const column = field.options.field ?? "";
  const missing = {
    ok: false,
    error: `${name}: the linked table has no field "${column}"`,
    code: "#NAME",
  } as const;
  const key = customKeyOf(column);
  if (key !== null) {
    const f = fieldsOf(target).find((x) => x.key === key);
    if (!f) return missing;
    switch (f.type) {
      case "link":
        return { ok: true, kind: "link", target, field: column };
      case "select":
      case "multiselect":
        return { ok: true, kind: "multi", target, field: column };
      case "lookup": {
        const inner = resolveLookup(
          { ...f, table: target },
          fieldsOf,
          coreFieldsOf,
          new Set(seen).add(here),
        );
        return inner.ok ? { ok: true, kind: inner.kind, target, field: column } : inner;
      }
      default:
        return { ok: true, kind: "value", target, field: column };
    }
  }
  const spec = Object.hasOwn(coreFieldsOf(target) ?? {}, column)
    ? coreFieldsOf(target)?.[column]
    : undefined;
  if (!spec || spec.extra) return missing;
  const kind: LookupKind =
    spec.kind === "link"
      ? "link"
      : spec.kind === "select" || spec.kind === "multi"
        ? "multi"
        : "value";
  return { ok: true, kind, target, field: column };
}

/** The view field kind of a lookup (a broken one filters as text, like formulas). */
export function lookupViewKind(r: LookupResolution): "link" | "multi" | "text" {
  if (!r.ok || r.kind === "value") return "text";
  return r.kind;
}
