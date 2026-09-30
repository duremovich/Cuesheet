// Moving the M1c per-browser prefs (column widths per show+table, the cue live sort per
// show, collapsed groups per user+show+table) into saved views. Widths and the live sort
// become a personal "My view"; collapsed groups move to the per-view key. Pure apart from
// the injected storage, so it's unit-tested (legacy.test.ts).
import type { DataTableName } from "../../../shared/tables";
import type { ViewConfig } from "../../../shared/views";

export interface KeyValueStore {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export const legacyKey = {
  widths: (showId: string, table: string) => `cuesheet.widths.${showId}.${table}`,
  sort: (showId: string, table: string) => `cuesheet.sort.${showId}.${table}`,
  collapsed: (userId: string, showId: string, table: string) =>
    `cuesheet.collapsed.${userId}.${showId}.${table}`,
};

/** Where collapsed groups live now: per user, show and view. */
export const collapsedKey = (userId: string, showId: string, viewId: string) =>
  `cuesheet.collapsed.${userId}.${showId}.view.${viewId}`;

/** A viewer's/commenter's own column widths + frozen count on a shared view. */
export const layoutKey = (userId: string, showId: string, viewId: string) =>
  `cuesheet.viewlayout.${userId}.${showId}.${viewId}`;

/** Last view opened per user, show and table (used when the URL names none). */
export const lastViewKey = (userId: string, showId: string, table: string) =>
  `cuesheet.view.${userId}.${showId}.${table}`;

function readJson(store: KeyValueStore, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export interface LegacyPrefs {
  widths: Record<string, number>;
  sorts: ViewConfig["sorts"];
  collapsed: string[] | undefined;
}

/** What the old prefs held for this table, or null when there's nothing to migrate. */
export function readLegacyPrefs(
  store: KeyValueStore,
  showId: string,
  userId: string,
  table: DataTableName,
): LegacyPrefs | null {
  const w = readJson(store, legacyKey.widths(showId, table));
  const widths: Record<string, number> = {};
  if (typeof w === "object" && w !== null && !Array.isArray(w)) {
    for (const [k, v] of Object.entries(w)) {
      if (typeof v === "number" && v > 0 && v < 5000) widths[k] = Math.round(v);
    }
  }
  const s = readJson(store, legacyKey.sort(showId, table));
  const sorts = Array.isArray(s)
    ? s.flatMap((x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as { key?: unknown }).key === "string" &&
        ((x as { dir?: unknown }).dir === "asc" || (x as { dir?: unknown }).dir === "desc")
          ? [{ key: (x as { key: string }).key, dir: (x as { dir: "asc" | "desc" }).dir }]
          : [],
      )
    : [];
  const c = readJson(store, legacyKey.collapsed(userId, showId, table));
  const collapsed =
    Array.isArray(c) && c.every((x) => typeof x === "string") ? (c as string[]) : undefined;
  if (Object.keys(widths).length === 0 && sorts.length === 0 && !collapsed) return null;
  return { widths, sorts, collapsed };
}

/** Does the migrated config differ from the base (worth a personal view)? */
export function hasViewSettings(prefs: LegacyPrefs): boolean {
  return Object.keys(prefs.widths).length > 0 || prefs.sorts.length > 0;
}

/**
 * `base` with the old widths and live sort applied. `columnKeys` is the table's columns in
 * default order: a width for a column the view doesn't list makes the view list every
 * column (in the order it already shows them), so nothing moves.
 */
export function applyLegacyPrefs(
  base: ViewConfig,
  prefs: LegacyPrefs,
  columnKeys: readonly string[],
): ViewConfig {
  const listed = new Set(base.fields.map((f) => f.key));
  const needsAll = Object.keys(prefs.widths).some((k) => !listed.has(k));
  const all = needsAll
    ? [...base.fields, ...columnKeys.filter((k) => !listed.has(k)).map((key) => ({ key }))]
    : base.fields;
  const fields = all.map((f) => {
    const width = prefs.widths[f.key];
    return width ? { ...f, width } : f;
  });
  const out: ViewConfig = { ...base, fields };
  if (prefs.sorts.length > 0) {
    out.sorts = prefs.sorts;
    out.sortMode = "live";
  }
  return out;
}

export function clearLegacyPrefs(
  store: KeyValueStore,
  showId: string,
  userId: string,
  table: DataTableName,
): void {
  for (const key of [
    legacyKey.widths(showId, table),
    legacyKey.sort(showId, table),
    legacyKey.collapsed(userId, showId, table),
  ]) {
    try {
      store.removeItem(key);
    } catch {
      // storage blocked
    }
  }
}
