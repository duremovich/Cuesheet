// The saved-view layer between a tab's data and its DataGrid (R16, R17): which view is open
// (`?view=<id>`, else the last one you opened, else the shared default), its working config
// (unsaved changes to a shared view are a draft; personal views save as you go; viewers and
// commenters changing a shared view get a personal copy), and the config applied to the
// grid: columns, filters (with the "held until you leave it" rule for inserted/edited rows),
// grouping, live sort, row height and color rules. Tabs call it once and render `toolbar`.
import {
  type FocusEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import { newId } from "../../../shared/ids";
import type { Op } from "../../../shared/ops";
import type { DataTableName, ViewRow } from "../../../shared/tables";
import {
  DEFAULT_VIEW_NAMES,
  defaultViewConfig,
  normalizeViewConfig,
  type ViewConfig,
} from "../../../shared/views";
import type {
  Column,
  Group,
  InsertPosition,
  RowHeight,
  SortSpec,
} from "../../components/grid/types";
import { jsonEqual } from "../../lib/show-state";
import { useShowStore, useShowStoreInstance, useViewsFor } from "../../lib/show-store";
import { groupOrder, placementFor } from "../shared/ops";
import { readPref, writePref } from "../shared/prefs";
import { useWorkspace } from "../show/workspace";
import { draftKey, getDraft, setDraft, useDraft } from "./drafts";
import {
  compileFilters,
  type FieldDef,
  gridColorRules,
  gridSort,
  isComplete,
  layoutColumns,
} from "./evaluate";
import { filterGroups, groupRows, isGroupable } from "./grouping";
import {
  applyLegacyPrefs,
  clearLegacyPrefs,
  collapsedKey,
  hasViewSettings,
  lastViewKey,
  readLegacyPrefs,
} from "./legacy";
import { colorPresets } from "./presets";
import { ViewBar } from "./ViewBar";

/** Personal views save this long after the last change (typing in a filter value). */
const SAVE_DELAY = 400;

export interface SortPreset {
  label: string;
  sorts: SortSpec[];
}

export interface ViewSetup<V> {
  table: DataTableName;
  /** Every column in default order (the view picks, orders and sizes them). */
  columns: Column<V>[];
  /** Fields to filter/color by that aren't columns (e.g. a cue's open-note count). */
  extraFields?: FieldDef<V>[];
  /** Readonly columns holding timestamps (ms): filtered with before/after. */
  dateFields?: readonly string[];
  rowId: (v: V) => string;
  /** All rows, in show order (or the table's natural order). */
  rows: V[];
  /** The tab's own grouping of all rows, used when the view groups by `nativeGroupKey`. */
  groups?: Group<V>[];
  nativeGroupKey?: string;
  /** Native groups collapsed until the user changes them (a constant array). */
  defaultCollapsed?: string[];
  /** Edit → ops, used to put rows into a group (insert into / drag onto a group). */
  editOps: (v: V, key: string, value: unknown) => Op[];
  /** One-click sorts in the Sort popover. */
  sortPresets?: SortPreset[];
  /** "Sort now by cue number" (editors): resolves true when done. */
  sortNow?: { label: string; run: () => Promise<boolean> };
}

export interface ViewState<V> {
  /** Columns laid out by the view (order, hidden, widths, frozen). */
  columns: Column<V>[];
  rows?: V[];
  groups?: Group<V>[];
  sort: SortSpec[] | undefined;
  rowHeight: RowHeight;
  colorRules: ReturnType<typeof gridColorRules<V>>;
  collapsed: string[];
  onCollapsedChange: (ids: string[]) => void;
  onColumnResize: (key: string, width: number) => void;
  /** Rows shown (excluding group headers) and whether a filter is hiding any. */
  shownCount: number;
  filtered: boolean;
  /** Insert position with a view-made group id replaced by a neighbour (see groupOps). */
  mapPosition: (pos: InsertPosition) => InsertPosition;
  /** Ops that put row `id` (new: `view` omitted) into the view-made group `pos.groupId`. */
  groupOps: (id: string, pos: InsertPosition, view?: V) => Op[];
  /** Keep a just-inserted row visible under a filter until you leave it. */
  hold: (id: string) => void;
  /** Call from the grid's onActiveRowChange. */
  trackActive: (id: string | null) => void;
  /** Spread on an element wrapping the grid (focus leaving it releases held rows). */
  wrapProps: {
    onBlur: (e: FocusEvent<HTMLElement>) => void;
    onFocus: (e: FocusEvent<HTMLElement>) => void;
    style: { display: "contents" };
  };
  toolbar: ReactNode;
}

const NO_IDS: string[] = [];
const NO_EXTRAS: FieldDef<never>[] = [];

/** Handlers the toolbar calls (see ViewBar). */
export interface ViewActions {
  update(fn: (c: ViewConfig) => ViewConfig): void;
  select(id: string | null): void;
  save(): void;
  discard(): void;
  duplicate(name: string, shared: boolean): void;
  rename(id: string, name: string): void;
  remove(id: string): void;
  setDefault(id: string): void;
}

export function useViewConfig<V>(setup: ViewSetup<V>): ViewState<V> {
  const ws = useWorkspace();
  const { showId, userId, canEdit, toast, reportError } = ws;
  const store = useShowStoreInstance();
  const ready = useShowStore((s) => s.status) === "ready";
  const { table } = setup;
  const { shared, mine } = useViewsFor(table, userId);
  const [params, setParams] = useSearchParams();
  const urlView = params.get("view");

  // --- Which view ---
  const lastKey = lastViewKey(userId, showId, table);
  const [lastView, setLastView] = useState<string | null>(() =>
    readPref(lastKey, null, (v): v is string | null => typeof v === "string" || v === null),
  );
  const current: ViewRow | null = useMemo(() => {
    const all = [...shared, ...mine];
    return (
      all.find((v) => v.id === urlView) ??
      all.find((v) => v.id === lastView) ??
      shared.find((v) => v.is_default) ??
      shared[0] ??
      mine[0] ??
      null
    );
  }, [shared, mine, urlView, lastView]);
  const viewId = current?.id ?? `builtin:${table}`;
  const isPersonal = !!current && current.owner_user_id !== null;

  // --- Config: saved, draft, working ---
  const dKey = draftKey(showId, viewId);
  const draft = useDraft(dKey);
  const savedConfig = current?.config;
  const saved = useMemo(
    () =>
      savedConfig !== undefined
        ? normalizeViewConfig(savedConfig, table)
        : defaultViewConfig(table),
    [savedConfig, table],
  );
  const config = draft ?? saved;
  const dirty = !isPersonal && !!draft && !jsonEqual(draft, saved);
  // A draft that matches what's saved (after a save lands) is dropped.
  useEffect(() => {
    if (draft && jsonEqual(draft, saved)) setDraft(dKey, undefined);
  }, [draft, saved, dKey]);

  const latest = useRef({ current, config, viewId, dKey, shared, mine });
  latest.current = { current, config, viewId, dKey, shared, mine };

  const select = useCallback(
    (id: string | null) => {
      setLastView(id);
      writePref(lastKey, id ?? undefined);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id) next.set("view", id);
          else next.delete("view");
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [lastKey, setParams],
  );

  const send = useCallback(
    (ops: Op[], what: string) => {
      store.mutate(ops).catch((e: unknown) => reportError(e, what));
    },
    [store, reportError],
  );

  const nextPosition = useCallback(() => {
    const { shared, mine } = latest.current;
    return Math.max(0, ...[...shared, ...mine].map((v) => v.position ?? 0)) + 1;
  }, []);

  const saveTimer = useRef<number | null>(null);
  const flush = useCallback(
    (id: string, key: string) => {
      saveTimer.current = null;
      const cfg = getDraft(key);
      if (cfg)
        send([{ op: "update", table: "views", id, fields: { config: cfg } }], "save the view");
    },
    [send],
  );

  const update = useCallback(
    (fn: (c: ViewConfig) => ViewConfig) => {
      const cur = latest.current;
      const next = fn(cur.config);
      if (jsonEqual(next, cur.config)) return;
      const view = cur.current;
      if (view && view.owner_user_id === userId) {
        // Personal: save shortly (the draft shows the change meanwhile).
        setDraft(cur.dKey, next);
        latest.current = { ...cur, config: next };
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        const id = view.id;
        const key = cur.dKey;
        saveTimer.current = window.setTimeout(() => flush(id, key), SAVE_DELAY);
        return;
      }
      if (!view || canEdit) {
        // Shared view, editor: a draft until Save / Discard.
        setDraft(cur.dKey, next);
        latest.current = { ...cur, config: next };
        return;
      }
      // Viewers/commenters can't change a shared view: copy it into a personal one.
      const id = newId();
      store
        .mutate([
          {
            op: "create",
            table: "views",
            id,
            fields: {
              table,
              name: `${view.name ?? "View"} (mine)`,
              owner_user_id: userId,
              position: nextPosition(),
              config: next,
            },
          },
        ])
        .catch((e: unknown) => reportError(e, "save your view"));
      const row = store.getState().tables.views.get(id) ?? null;
      latest.current = {
        ...cur,
        current: row,
        config: next,
        viewId: id,
        dKey: draftKey(showId, id),
      };
      select(id);
      toast("Saved as my view");
    },
    [userId, canEdit, store, table, nextPosition, reportError, select, toast, flush, showId],
  );
  // Leaving the tab with a pending personal save: write it now.
  useEffect(
    () => () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        const cur = latest.current;
        if (cur.current) flush(cur.current.id, cur.dKey);
      }
    },
    [flush],
  );

  const actions = useMemo<ViewActions>(
    () => ({
      update,
      select,
      save: () => {
        const cur = latest.current;
        const cfg = getDraft(cur.dKey);
        if (!cfg) return;
        if (cur.current) {
          send(
            [{ op: "update", table: "views", id: cur.current.id, fields: { config: cfg } }],
            "save the view",
          );
        } else {
          const id = newId();
          send(
            [
              {
                op: "create",
                table: "views",
                id,
                fields: { table, name: DEFAULT_VIEW_NAMES[table], is_default: true, config: cfg },
              },
            ],
            "save the view",
          );
          select(id);
        }
        setDraft(cur.dKey, undefined);
      },
      discard: () => setDraft(latest.current.dKey, undefined),
      duplicate: (name, asShared) => {
        const cur = latest.current;
        const id = newId();
        send(
          [
            {
              op: "create",
              table: "views",
              id,
              fields: {
                table,
                name,
                owner_user_id: asShared ? null : userId,
                position: nextPosition(),
                config: cur.config,
              },
            },
          ],
          "create the view",
        );
        // The unsaved changes went into the new view.
        setDraft(cur.dKey, undefined);
        select(id);
      },
      rename: (id, name) =>
        send([{ op: "update", table: "views", id, fields: { name } }], "rename the view"),
      remove: (id) => {
        send([{ op: "delete", table: "views", id }], "delete the view");
        setDraft(draftKey(showId, id), undefined);
        if (latest.current.current?.id === id) select(null);
      },
      setDefault: (id) =>
        send(
          [{ op: "update", table: "views", id, fields: { is_default: true } }],
          "set the default view",
        ),
    }),
    [update, select, send, table, userId, nextPosition, showId],
  );

  // --- Migrate the M1c localStorage prefs (once per show + table, silently) ---
  const migrated = useRef(false);
  useEffect(() => {
    if (!ready || migrated.current || !userId) return;
    migrated.current = true;
    let prefs: ReturnType<typeof readLegacyPrefs> = null;
    try {
      prefs = readLegacyPrefs(localStorage, showId, userId, table);
    } catch {
      return; // storage blocked
    }
    if (!prefs) return;
    const cur = latest.current;
    if (prefs.collapsed && cur.current) {
      writePref(collapsedKey(userId, showId, cur.current.id), prefs.collapsed);
    }
    if (hasViewSettings(prefs)) {
      const id = newId();
      const cfg = applyLegacyPrefs(
        cur.config,
        prefs,
        setup.columns.map((c) => c.key),
      );
      store
        .mutate([
          {
            op: "create",
            table: "views",
            id,
            fields: {
              table,
              name: "My view",
              owner_user_id: userId,
              position: nextPosition(),
              config: cfg,
            },
          },
        ])
        .catch(() => undefined);
      if (prefs.collapsed) writePref(collapsedKey(userId, showId, id), prefs.collapsed);
      select(id);
    }
    try {
      clearLegacyPrefs(localStorage, showId, userId, table);
    } catch {
      // storage blocked
    }
  });

  // --- Fields ---
  const extras = setup.extraFields ?? (NO_EXTRAS as FieldDef<V>[]);
  const dateFields = setup.dateFields;
  const fields = useMemo(() => {
    const m = new Map<string, FieldDef<V>>();
    for (const c of setup.columns) {
      m.set(c.key, dateFields?.includes(c.key) ? { ...c, valueType: "date" } : c);
    }
    for (const f of extras) if (!m.has(f.key)) m.set(f.key, f);
    return m;
  }, [setup.columns, extras, dateFields]);

  const columns = useMemo(() => layoutColumns(setup.columns, config), [setup.columns, config]);
  const sortKey = JSON.stringify(gridSort(config, columns) ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the sort's value
  const sort = useMemo(() => gridSort(config, columns), [sortKey]);
  const colorRules = useMemo(
    () => gridColorRules(config.colorRules, fields),
    [config.colorRules, fields],
  );
  const presets = useMemo(() => colorPresets(table, fields), [table, fields]);

  const onColumnResize = useCallback(
    (key: string, width: number) =>
      update((c) => {
        const w = Math.round(width);
        const has = c.fields.some((f) => f.key === key);
        const listed = has
          ? c.fields.map((f) => (f.key === key ? { ...f, width: w } : f))
          : [
              ...c.fields,
              // Listing a column pins it after the listed ones; list the rest in their
              // current order first so nothing moves.
              ...setup.columns
                .filter((col) => !c.fields.some((f) => f.key === col.key))
                .map((col) => (col.key === key ? { key, width: w } : { key: col.key })),
            ];
        return { ...c, fields: listed };
      }),
    [update, setup.columns],
  );

  // --- Filtering, with held rows ---
  const rowIdRef = useRef(setup.rowId);
  rowIdRef.current = setup.rowId;
  const predicate = useMemo(
    () => compileFilters(config.filters, config.filterMode, fields, true),
    [config.filters, config.filterMode, fields],
  );
  const held = useRef(new Set<string>());
  const [heldTick, setHeldTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: heldTick re-reads the held set
  const keep = useMemo(
    () =>
      predicate
        ? (r: V) => {
            const id = rowIdRef.current(r);
            return held.current.has(id) || predicate(r);
          }
        : null,
    [predicate, heldTick],
  );

  const groupKey = config.group.key;
  const groupField = groupKey ? fields.get(groupKey) : undefined;
  const useNative = !!groupKey && groupKey === setup.nativeGroupKey && !!setup.groups;
  const useGeneric = !!groupKey && !useNative && !!groupField && isGroupable(groupField);
  const out = useMemo(() => {
    if (useNative && setup.groups) {
      return { groups: keep ? filterGroups(setup.groups, keep) : setup.groups };
    }
    const rows = keep ? setup.rows.filter(keep) : setup.rows;
    if (useGeneric && groupField) {
      const g = groupRows(rows, groupField, { keepEmpty: true });
      return { groups: g.groups, values: g.values };
    }
    return { rows };
  }, [useNative, useGeneric, setup.groups, setup.rows, keep, groupField]);
  const outRef = useRef(out);
  outRef.current = out;

  const shownIds = useMemo(() => {
    const list = out.rows ?? out.groups?.flatMap((g) => g.rows) ?? [];
    return new Set(list.map((r) => rowIdRef.current(r)));
  }, [out]);
  const rowIds = useMemo(() => new Set(setup.rows.map((r) => rowIdRef.current(r))), [setup.rows]);

  // Rows released from a hold that the filter now hides: say so once, with an undo.
  const released = useRef<string[]>([]);
  useEffect(() => {
    if (released.current.length === 0) return;
    const hidden = released.current.filter((id) => rowIds.has(id) && !shownIds.has(id));
    released.current = [];
    if (hidden.length > 0) {
      toast("Hidden by the current filter", "info", {
        label: "Undo filter",
        run: () => update((c) => ({ ...c, filters: [] })),
      });
    }
  }, [shownIds, rowIds, toast, update]);

  const activeRef = useRef<string | null>(null);
  const release = useCallback((keepId: string | null) => {
    const gone = [...held.current].filter((h) => h !== keepId);
    held.current = new Set(keepId ? [keepId] : []);
    if (gone.length > 0) {
      released.current.push(...gone);
      setHeldTick((t) => t + 1);
    }
  }, []);
  const hold = useCallback((id: string) => {
    held.current.add(id);
    setHeldTick((t) => t + 1);
  }, []);
  const trackActive = useCallback(
    (id: string | null) => {
      activeRef.current = id;
      release(id);
    },
    [release],
  );
  const wrapProps = useMemo(
    () => ({
      style: { display: "contents" as const },
      onFocus: () => {
        // Back in the grid: the active row is held again while you're in it.
        if (activeRef.current) held.current.add(activeRef.current);
      },
      onBlur: (e: FocusEvent<HTMLElement>) => {
        const wrap = e.currentTarget;
        // Like the grid: after the focus change settles, ignore moves within the grid or
        // into its pickers/menus (portals).
        window.setTimeout(() => {
          const el = document.activeElement;
          if (el && (wrap.contains(el) || el.closest("[data-grid-portal]"))) return;
          release(null);
        }, 0);
      },
    }),
    [release],
  );

  // --- Groups: insert / move into a view-made group ---
  const editOpsRef = useRef(setup.editOps);
  editOpsRef.current = setup.editOps;
  const mapPosition = useCallback((pos: InsertPosition): InsertPosition => {
    const o = outRef.current;
    if (!("values" in o) || pos.groupId === undefined) return pos;
    if (pos.afterRowId !== undefined) return { afterRowId: pos.afterRowId };
    if (pos.beforeRowId !== undefined) return { beforeRowId: pos.beforeRowId };
    const p = placementFor(
      pos,
      groupOrder(
        (o.groups ?? []).map((g) => ({
          id: g.id,
          rows: g.rows.map((r) => ({ id: rowIdRef.current(r) })),
        })),
      ),
    );
    if (typeof p.after === "string") return { afterRowId: p.after };
    if (typeof p.before === "string") return { beforeRowId: p.before };
    return {};
  }, []);
  const groupOps = useCallback(
    (id: string, pos: InsertPosition, view?: V): Op[] => {
      const o = outRef.current;
      if (!("values" in o) || !o.values || pos.groupId === undefined || !groupKey) return [];
      if (!o.values.has(pos.groupId)) return [];
      const value = o.values.get(pos.groupId);
      // A new row has no links yet: an empty stand-in is enough for the edit ops, which
      // read the id and (for link lists) the current list.
      const target = view ?? ({ id, [groupKey]: [] } as unknown as V);
      return editOpsRef.current(target, groupKey, value);
    },
    [groupKey],
  );

  // --- Collapsed groups: per user, per view (localStorage) ---
  const cKey = collapsedKey(userId, showId, viewId);
  const [stored, setStored] = useState<{ key: string; ids: string[] | undefined }>(() => ({
    key: cKey,
    ids: readStoredIds(cKey),
  }));
  const storedIds = stored.key === cKey ? stored.ids : readStoredIds(cKey);
  useEffect(() => {
    if (stored.key !== cKey) setStored({ key: cKey, ids: readStoredIds(cKey) });
  }, [cKey, stored.key]);
  const allGroupIds = useMemo(() => (out.groups ?? []).map((g) => g.id), [out.groups]);
  const collapsedByDefault = !!config.group.collapsedByDefault;
  const defaultCollapsed = useNative ? (setup.defaultCollapsed ?? NO_IDS) : NO_IDS;
  const collapsed = useMemo(
    () => storedIds ?? (collapsedByDefault ? allGroupIds : defaultCollapsed),
    [storedIds, collapsedByDefault, allGroupIds, defaultCollapsed],
  );
  const onCollapsedChange = useCallback(
    (ids: string[]) => {
      writePref(cKey, ids);
      setStored({ key: cKey, ids });
    },
    [cKey],
  );

  const shownCount = shownIds.size;
  const filtered = config.filters.some(isComplete) && shownCount < setup.rows.length;

  const toolbar = (
    <ViewBar
      table={table}
      current={current}
      shared={shared}
      mine={mine}
      config={config}
      dirty={dirty}
      canEdit={canEdit}
      columns={setup.columns}
      fields={fields}
      rows={setup.rows}
      presets={presets}
      actions={actions}
      sortPresets={setup.sortPresets}
      sortNow={canEdit ? setup.sortNow : undefined}
    />
  );

  return {
    columns,
    ...(out.rows ? { rows: out.rows } : { groups: out.groups ?? [] }),
    sort,
    rowHeight: config.rowHeight,
    colorRules,
    collapsed,
    onCollapsedChange,
    onColumnResize,
    shownCount,
    filtered,
    mapPosition,
    groupOps,
    hold,
    trackActive,
    wrapProps,
    toolbar,
  };
}

function readStoredIds(key: string): string[] | undefined {
  return readPref<string[] | undefined>(
    key,
    undefined,
    (v): v is string[] | undefined => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
}
