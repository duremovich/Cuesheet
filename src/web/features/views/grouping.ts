// Grouping a view's rows by any select / multi-select / link field (R4, R16). The tab's own
// grouping (cues and content by scene, notes by status) is used as-is when the view groups
// by that field; everything else goes through `groupRows`. Pure; see grouping.test.ts.
import type { Group, PickerItem } from "../../components/grid/types";
import type { FieldDef } from "./evaluate";

/** Group ids made here start with this, so they can't be mistaken for scene ids. */
export const GROUP_PREFIX = "grp:";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function isGroupable(f: { type: string }): boolean {
  return (
    f.type === "select" || f.type === "multiselect" || f.type === "link" || f.type === "multilink"
  );
}

export interface GroupedRows<V> {
  groups: Group<V>[];
  /** Group id → the field value a row gets when inserted into / dropped on that group. */
  values: Map<string, unknown>;
}

/**
 * Rows (in display order) grouped by `field`: the empty group first ("Unassigned" for
 * links, "No <field>" otherwise; shown when it has rows or `keepEmpty`), then for a select
 * every option in option order (empty ones too, so you can add to them), for links the
 * linked records present sorted by label, and for multi-valued fields each combination
 * present (a row appears once).
 */
export function groupRows<V>(
  rows: readonly V[],
  field: FieldDef<V>,
  opts: { keepEmpty?: boolean } = {},
): GroupedRows<V> {
  const byKey = new Map<string, { title: string; value: unknown; rows: V[] }>();
  const emptyId = `${GROUP_PREFIX}${field.key}:`;
  const emptyValue = field.type === "multiselect" || field.type === "multilink" ? [] : null;
  const emptyTitle =
    field.type === "link" || field.type === "multilink"
      ? "Unassigned"
      : `No ${field.title.toLocaleLowerCase()}`;
  const empty = { title: emptyTitle, value: emptyValue, rows: [] as V[] };
  const optionIndex = new Map((field.options ?? []).map((o, i) => [o.value, i]));

  const keyOf = (v: unknown): { key: string; title: string; value: unknown } | null => {
    switch (field.type) {
      case "select":
        return typeof v === "string" && v !== "" ? { key: v, title: v, value: v } : null;
      case "multiselect": {
        const list = Array.isArray(v) ? [...(v as string[])] : [];
        if (list.length === 0) return null;
        list.sort((a, b) => (optionIndex.get(a) ?? 1e9) - (optionIndex.get(b) ?? 1e9));
        return { key: list.join("\u0001"), title: list.join(", "), value: list };
      }
      case "link": {
        const p = v as PickerItem | null;
        return p ? { key: p.id, title: p.label, value: p } : null;
      }
      case "multilink": {
        const list = Array.isArray(v) ? [...(v as PickerItem[])] : [];
        if (list.length === 0) return null;
        list.sort((a, b) => collator.compare(a.label, b.label));
        return {
          key: list.map((p) => p.id).join(","),
          title: list.map((p) => p.label).join(", "),
          value: list,
        };
      }
      default:
        return null;
    }
  };

  if (field.type === "select") {
    for (const o of field.options ?? []) {
      byKey.set(o.value, { title: o.label ?? o.value, value: o.value, rows: [] });
    }
  }
  for (const row of rows) {
    const k = keyOf(field.getValue(row));
    if (!k) {
      empty.rows.push(row);
      continue;
    }
    let g = byKey.get(k.key);
    if (!g) {
      g = { title: k.title, value: k.value, rows: [] };
      byKey.set(k.key, g);
    }
    g.rows.push(row);
  }

  let entries = [...byKey.entries()];
  if (field.type !== "select") {
    entries = entries.sort((a, b) => collator.compare(a[1].title, b[1].title));
  }
  const groups: Group<V>[] = [];
  const values = new Map<string, unknown>();
  if (empty.rows.length > 0 || opts.keepEmpty) {
    groups.push({ id: emptyId, title: empty.title, rows: empty.rows });
    values.set(emptyId, empty.value);
  }
  for (const [key, g] of entries) {
    const id = `${GROUP_PREFIX}${field.key}:${key}`;
    groups.push({ id, title: g.title, rows: g.rows });
    values.set(id, g.value);
  }
  return { groups, values };
}

/**
 * Keep only rows that pass `keep` in each group, preserving group identity when nothing
 * was removed (so the grid doesn't re-render). Groups left without rows are dropped: a
 * filtered view shows only where its rows are.
 */
export function filterGroups<V>(groups: readonly Group<V>[], keep: (r: V) => boolean): Group<V>[] {
  let changed = false;
  const out: Group<V>[] = [];
  for (const g of groups) {
    const rows = g.rows.filter(keep);
    if (rows.length === 0) {
      changed = true;
      continue;
    }
    if (rows.length === g.rows.length) out.push(g);
    else {
      changed = true;
      out.push({ ...g, rows });
    }
  }
  return changed ? out : (groups as Group<V>[]);
}
