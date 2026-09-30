// Moving the M1c per-browser prefs (column widths per show+table, the cue live sort per
// show, collapsed groups per user+show+table) into saved views: widths become your own
// layout overlay on the shared view you're on, collapsed groups move to the per-view key,
// the old live sort is dropped (useViewConfig does the moving). Pure apart from the
// injected storage, so it's unit-tested (legacy.test.ts).
import type { ViewTable } from "../../../shared/tables";

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
  sorts: { key: string; dir: "asc" | "desc" }[];
  collapsed: string[] | undefined;
}

/** What the old prefs held for this table, or null when there's nothing to migrate. */
export function readLegacyPrefs(
  store: KeyValueStore,
  showId: string,
  userId: string,
  table: ViewTable,
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

export function clearLegacyPrefs(
  store: KeyValueStore,
  showId: string,
  userId: string,
  table: ViewTable,
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
