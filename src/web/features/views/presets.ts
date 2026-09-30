// One-click color rule presets (ux.md §Conditional formatting). Adding one: return it from
// `colorPresets` for its table (see CLAUDE.md "Saved views").
import type { ViewTable } from "../../../shared/tables";
import type { ColorRule, OptionColor } from "../../../shared/views";
import { OPTION_COLORS } from "../../components/grid/types";
import type { FieldDef } from "./evaluate";

export interface ColorPreset {
  id: string;
  label: string;
  rules: ColorRule[];
}

const asColor = (c: string | undefined): OptionColor =>
  (OPTION_COLORS as readonly string[]).includes(c ?? "") ? (c as OptionColor) : "gray";

/** "Color rows by <select>": one row rule per option, in the option's own color. */
export function rowsBySelect(field: Pick<FieldDef<unknown>, "key" | "options">): ColorRule[] {
  return (field.options ?? []).map((o) => ({
    when: [{ key: field.key, op: "is", value: o.value }],
    mode: "and",
    target: "row",
    color: asColor(o.color),
  }));
}

export function colorPresets<V>(
  table: ViewTable,
  fields: ReadonlyMap<string, FieldDef<V>>,
): ColorPreset[] {
  const out: ColorPreset[] = [];
  const has = (k: string) => fields.has(k);
  const select = (k: string) => fields.get(k) as FieldDef<unknown> | undefined;
  if (table === "cues") {
    const status = select("status");
    if (status)
      out.push({ id: "cues-status", label: "Cues by status", rules: rowsBySelect(status) });
    if (has("open_notes") && has("number")) {
      out.push({
        id: "cues-open-notes",
        label: "Cues with open notes",
        rules: [
          {
            when: [{ key: "open_notes", op: "gt", value: 0 }],
            mode: "and",
            target: { cell: "number" },
            color: "orange",
          },
        ],
      });
    }
    if (has("content")) {
      out.push({
        id: "cues-no-content",
        label: "Cues with no content",
        rules: [
          {
            when: [{ key: "content", op: "isEmpty" }],
            mode: "and",
            target: { cell: "content" },
            color: "red",
          },
        ],
      });
    }
  }
  if (table === "notes") {
    const priority = select("priority");
    const status = select("status");
    if (priority) {
      out.push({ id: "notes-priority", label: "Notes by priority", rules: rowsBySelect(priority) });
    }
    if (status)
      out.push({ id: "notes-status", label: "Notes by status", rules: rowsBySelect(status) });
  }
  // Any other select: "Color rows by <field>".
  const named = new Set(out.flatMap((p) => p.rules.flatMap((r) => r.when.map((w) => w.key))));
  for (const f of fields.values()) {
    if (f.type !== "select" || named.has(f.key) || !f.options?.length) continue;
    out.push({
      id: `rows-by-${f.key}`,
      label: `Color rows by ${f.title.toLocaleLowerCase()}`,
      rules: rowsBySelect(f as FieldDef<unknown>),
    });
  }
  return out;
}
