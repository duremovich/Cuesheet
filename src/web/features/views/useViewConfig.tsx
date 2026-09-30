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
import type { Unit } from "../../../shared/units";
import {
  DEFAULT_VIEW_NAMES,
  defaultViewConfig,
  normalizeViewConfig,
  type ViewConfig,
  type ViewLayout,
} from "../../../shared/views";
import type {
  Column,
  Group,
  InsertPosition,
  PickerItem,
  RowHeight,
  SortSpec,
} from "../../components/grid/types";
import { ApiError, api } from "../../lib/api";
import { jsonEqual } from "../../lib/show-state";
import {
  useShowSocketState,
  useShowStore,
  useShowStoreInstance,
  useViewsFor,
} from "../../lib/show-store";
import { groupOrder, placementFor } from "../shared/ops";
import { readPref, writePref } from "../shared/prefs";
import { useMediaQuery } from "../shared/useMediaQuery";
import { useWorkspace } from "../show/workspace";
import { type Draft, draftKey, getDraft, rebaseDraft, setDraft, useDraft } from "./drafts";
import {
  applyLayoutOverlay,
  compileFilters,
  differsOnlyInLayout,
  type FieldDef,
  gridColorRules,
  gridSort,
  isComplete,
  type LayoutOverlay,
  layoutColumns,
  layoutOverlayOf,
  linkItems,
  migrateLinkFilters,
} from "./evaluate";
import { filterGroups, groupRows, isGroupable } from "./grouping";
import { clearLegacyPrefs, collapsedKey, lastViewKey, layoutKey, readLegacyPrefs } from "./legacy";
import { colorPresets } from "./presets";
import {
  hasMeasurements,
  resolveUnit,
  setUserUnit,
  UnitToggle,
  useUserUnit,
  ViewUnitChip,
  withUnit,
  withUnitFields,
} from "./units";
import { ViewBar } from "./ViewBar";

/** Personal views save this long after the last change (typing in a filter value). */
const SAVE_DELAY = 400;

export const HIDDEN_BY_FILTER = "Hidden by the current filter";

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
  /** Focus a row in the grid ("Keep shown" puts you back in a hidden row). */
  focusRow?: (id: string) => void;
  /** One-click sorts in the Sort popover. */
  sortPresets?: SortPreset[];
  /**
   * Columns hidden at phone width (≤ 480 px) unless the view lists them in its fields
   * (so showing one in Fields sticks).
   */
  narrowHidden?: readonly string[];
  /** "Sort now by cue number" (editors): resolves true when done. */
  sortNow?: { label: string; run: () => Promise<boolean> };
  /** The table can be shown as a gallery (R19): the view bar offers the toggle and preset. */
  gallery?: { presetName: string };
}

export interface ViewState<V> {
  /** Columns laid out by the view (order, hidden, widths, frozen). */
  columns: Column<V>[];
  rows?: V[];
  groups?: Group<V>[];
  sort: SortSpec[] | undefined;
  /** Every column, for the grid's `sortColumns` (a view may sort by a hidden field). */
  sortColumns: Column<V>[];
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
  /**
   * Before focusing a row from the URL or ⌘K: "shown", "missing", or "pending" when the
   * filter hides it (it's then held, and a toast offers Keep shown / Clear filters; focus
   * once it shows up).
   */
  reveal: (id: string) => "shown" | "pending" | "missing";
  /** Call from the grid's onActiveRowChange. */
  trackActive: (id: string | null) => void;
  /** Spread on an element wrapping the grid (focus leaving it releases held rows). */
  wrapProps: {
    onBlur: (e: FocusEvent<HTMLElement>) => void;
    onFocus: (e: FocusEvent<HTMLElement>) => void;
    style: { display: "contents" };
  };
  toolbar: ReactNode;
  /** Grid or gallery cards (R19). */
  layout: ViewLayout;
  /** The active measurement unit (view override → your unit → show default → m). */
  unit: Unit;
  /** The view's own unit override, if it has one. */
  viewUnit: Unit | undefined;
  /** The saved view shown (null: the built-in default), e.g. for the Print view link. */
  viewId: string | null;
}

const NO_IDS: string[] = [];
const NO_EXTRAS: FieldDef<never>[] = [];

/** Handlers the toolbar calls (see ViewBar). */
export interface ViewActions {
  update(fn: (c: ViewConfig) => ViewConfig): void;
  select(id: string | null): void;
  save(): void;
  discard(): void;
  /** Conflict: your changes onto the view as it is now. */
  rebase(): void;
  duplicate(name: string, shared: boolean): void;
  rename(id: string, name: string): void;
  remove(id: string): void;
  setDefault(id: string): void;
  /** A new personal view with this config (the "Content gallery" preset), opened. */
  createPersonal(name: string, config: ViewConfig): void;
}

/** A failed request that never reached the server (offline): worth retrying. */
const isNetworkError = (e: unknown) => !(e instanceof ApiError);

export function useViewConfig<V>(setup: ViewSetup<V>): ViewState<V> {
  const ws = useWorkspace();
  const { showId, userId, canEdit, toast, reportError } = ws;
  const store = useShowStoreInstance();
  const ready = useShowStore((s) => s.status) === "ready";
  const socket = useShowSocketState();
  const { table } = setup;
  const { shared, mine } = useViewsFor(table, userId);
  const [params, setParams] = useSearchParams();
  const urlView = params.get("view");
  // `select` writes ?view=, but the router applies navigations asynchronously (in a
  // transition), so for a render or two the URL still names the old view. Until it catches
  // up, the view just picked wins: otherwise a change that switched views (a viewer's edit
  // going to their copy) renders once with the old view's config, and a controlled
  // checkbox / radio in a panel snaps back under the click (e2e flake: "Clicking the
  // checkbox did not change its state").
  const [picked, setPicked] = useState<{ id: string | null; urlWas: string | null } | null>(null);
  const urlViewRef = useRef(urlView);
  urlViewRef.current = urlView;
  const pickPending = !!picked && picked.urlWas === urlView && picked.id !== urlView;
  const wantedView = pickPending ? picked.id : urlView;
  // The URL moved on (to the pick, or elsewhere): the URL rules again.
  useEffect(() => {
    if (picked && picked.urlWas !== urlView) setPicked(null);
  }, [picked, urlView]);

  // --- Which view ---
  const lastKey = lastViewKey(userId, showId, table);
  const [lastView, setLastView] = useState<string | null>(() =>
    readPref(lastKey, null, (v): v is string | null => typeof v === "string" || v === null),
  );
  const current: ViewRow | null = useMemo(() => {
    const all = [...shared, ...mine];
    return (
      all.find((v) => v.id === wantedView) ??
      all.find((v) => v.id === lastView) ??
      shared.find((v) => v.is_default) ??
      shared[0] ??
      mine[0] ??
      null
    );
  }, [shared, mine, wantedView, lastView]);
  const viewId = current?.id ?? `builtin:${table}`;
  const isPersonal = !!current && current.owner_user_id !== null;

  const select = useCallback(
    (id: string | null) => {
      setLastView(id);
      setPicked({ id, urlWas: urlViewRef.current });
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

  // A ?view= naming no view you can see (deleted, someone else's): drop it.
  useEffect(() => {
    if (!ready || !urlView || pickPending) return;
    if ([...shared, ...mine].some((v) => v.id === urlView)) return;
    toast("That view no longer exists.");
    if (lastView === urlView) setLastView(null);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("view");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [ready, urlView, pickPending, shared, mine, toast, setParams, lastView]);

  // --- Fields (columns + extras) ---
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
  const columnsRef = useRef(setup.columns);
  columnsRef.current = setup.columns;

  // --- Config: saved, draft (unsaved changes), layout overlay, working ---
  const dKey = draftKey(userId, showId, viewId);
  const draftEntry = useDraft(dKey);
  const draft = draftEntry?.config;
  const savedConfig = current?.config;
  const saved = useMemo(
    () =>
      savedConfig !== undefined
        ? normalizeViewConfig(savedConfig, table)
        : defaultViewConfig(table),
    [savedConfig, table],
  );
  const dirty = !isPersonal && !!draft && !jsonEqual(draft, saved);
  // The shared view changed (someone saved it) since the draft started.
  const conflict =
    dirty && !!draftEntry && !!current && draftEntry.baseUpdatedAt !== current.updated_at;
  // A draft that matches what's saved (after a save lands) is dropped.
  useEffect(() => {
    if (draft && jsonEqual(draft, saved)) setDraft(dKey, undefined);
  }, [draft, saved, dKey]);
  // Link filters saved with labels (before ids) resolve to ids here, once per config.
  const rowsForLookup = useRef(setup.rows);
  rowsForLookup.current = setup.rows;
  const base = draft ?? saved;
  const migratedBase = useMemo(
    () =>
      migrateLinkFilters(base, fields, (field, label) =>
        findRecord(field, label, rowsForLookup.current),
      ),
    [base, fields],
  );
  // Your own widths / frozen count on a shared view (viewers' changes; migrated M1c widths).
  const lKey = layoutKey(userId, showId, viewId);
  const [overlayState, setOverlayState] = useState<{ key: string; value?: LayoutOverlay }>(() => ({
    key: lKey,
    ...readOverlay(lKey),
  }));
  const overlay = overlayState.key === lKey ? overlayState.value : readOverlay(lKey).value;
  useEffect(() => {
    if (overlayState.key !== lKey) setOverlayState({ key: lKey, ...readOverlay(lKey) });
  }, [lKey, overlayState.key]);
  const writeOverlay = useCallback((key: string, value: LayoutOverlay | undefined) => {
    writePref(key, value);
    setOverlayState(value ? { key, value } : { key });
  }, []);
  const config = useMemo(
    () =>
      !isPersonal && overlay
        ? applyLayoutOverlay(
            migratedBase,
            overlay,
            setup.columns.map((c) => c.key),
          )
        : migratedBase,
    [isPersonal, overlay, migratedBase, setup.columns],
  );

  const latest = useRef({ current, config, saved, viewId, dKey, lKey, overlay, shared, mine });
  latest.current = { current, config, saved, viewId, dKey, lKey, overlay, shared, mine };

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

  /** A draft entry for `next`, keeping the base it started from. */
  const draftFor = useCallback((key: string, next: ViewConfig): Draft => {
    const cur = latest.current;
    const prev = getDraft(key);
    return {
      config: next,
      base: prev?.base ?? cur.saved,
      baseUpdatedAt: prev ? prev.baseUpdatedAt : (cur.current?.updated_at ?? null),
      savedAt: Date.now(),
    };
  }, []);

  // --- Personal views: debounced saves; offline → keep the draft and retry ---
  const saveTimer = useRef<number | null>(null);
  const pending = useRef(new Map<string, string>()); // draft key → view id to retry
  const flush = useCallback(
    (id: string, key: string, keepalive = false) => {
      saveTimer.current = null;
      const entry = getDraft(key);
      if (!entry) return;
      const ops: Op[] = [{ op: "update", table: "views", id, fields: { config: entry.config } }];
      if (keepalive) {
        // The page is going away: a request that outlives it (the store can't wait).
        void api
          .mutate(showId, { clientId: store.clientId, ops }, { keepalive: true })
          .catch(() => undefined);
        return;
      }
      store
        .mutate(ops)
        .then(() => pending.current.delete(key))
        .catch((e: unknown) => {
          if (isNetworkError(e)) {
            // Keep it (also across a reload) and try again when the socket is back.
            setDraft(key, entry, true);
            pending.current.set(key, id);
          } else reportError(e, "save the view");
        });
    },
    [store, reportError, showId],
  );
  const socketStatus = socket.status;
  useEffect(() => {
    if (socketStatus !== "connected") return;
    for (const [key, id] of [...pending.current]) flush(id, key);
  }, [socketStatus, flush]);
  // Leaving the tab, hiding or leaving the page with a pending personal save: send it.
  useEffect(() => {
    const flushNow = (keepalive: boolean) => {
      if (saveTimer.current === null) return;
      window.clearTimeout(saveTimer.current);
      const cur = latest.current;
      if (cur.current) flush(cur.current.id, cur.dKey, keepalive);
    };
    const onPageHide = () => flushNow(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow(true);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flushNow(false);
    };
  }, [flush]);

  const savePersonal = useCallback(
    (view: ViewRow, key: string, next: ViewConfig) => {
      setDraft(key, draftFor(key, next));
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => flush(view.id, key), SAVE_DELAY);
    },
    [draftFor, flush],
  );

  const update = useCallback(
    (fn: (c: ViewConfig) => ViewConfig) => {
      const cur = latest.current;
      const next = fn(cur.config);
      if (jsonEqual(next, cur.config)) return;
      const view = cur.current;
      if (view && view.owner_user_id === userId) {
        // Personal: save shortly (the draft shows the change meanwhile).
        savePersonal(view, cur.dKey, next);
        latest.current = { ...cur, config: next };
        return;
      }
      if (!view || canEdit) {
        // Shared view, editor: a draft until Save / Discard (kept across reloads). Your own
        // overlay widths for columns you now size in the view give way.
        if (cur.overlay) {
          const widths = { ...cur.overlay.widths };
          const nextWidths = layoutOverlayOf(next).widths;
          const prevWidths = layoutOverlayOf(cur.config).widths;
          for (const k of Object.keys(widths))
            if (nextWidths[k] !== prevWidths[k]) delete widths[k];
          const frozenChanged = next.frozenCount !== cur.config.frozenCount;
          const left: LayoutOverlay = {
            widths,
            ...(!frozenChanged && cur.overlay.frozenCount !== undefined
              ? { frozenCount: cur.overlay.frozenCount }
              : {}),
          };
          const empty = Object.keys(widths).length === 0 && left.frozenCount === undefined;
          writeOverlay(cur.lKey, empty ? undefined : left);
        }
        setDraft(cur.dKey, draftFor(cur.dKey, next), true);
        latest.current = { ...cur, config: next };
        return;
      }
      if (differsOnlyInLayout(cur.config, next, columnsRef.current)) {
        // Viewers/commenters: widths / frozen columns are theirs, in this browser.
        writeOverlay(cur.lKey, layoutOverlayOf(next));
        latest.current = { ...cur, config: next };
        return;
      }
      // Other changes to a shared view: into their personal copy of it (made once).
      const copy = cur.mine.find(
        (v) => normalizeViewConfig(v.config, table).forkedFrom === view.id,
      );
      if (copy) {
        const copyKey = draftKey(userId, showId, copy.id);
        const copyConfig = getDraft(copyKey)?.config ?? normalizeViewConfig(copy.config, table);
        const forCopy = { ...fn(copyConfig), forkedFrom: view.id };
        savePersonal(copy, copyKey, forCopy);
        latest.current = {
          ...cur,
          current: copy,
          config: forCopy,
          viewId: copy.id,
          dKey: copyKey,
          lKey: layoutKey(userId, showId, copy.id),
        };
        select(copy.id);
        toast("Changed in your copy of this view");
        return;
      }
      const id = newId();
      const forCopy = { ...next, forkedFrom: view.id };
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
              config: forCopy,
            },
          },
        ])
        .catch((e: unknown) => reportError(e, "save your view"));
      const row = store.getState().tables.views.get(id) ?? null;
      latest.current = {
        ...cur,
        current: row,
        config: forCopy,
        viewId: id,
        dKey: draftKey(userId, showId, id),
        lKey: layoutKey(userId, showId, id),
      };
      select(id);
      toast("Saved as my view");
    },
    [
      userId,
      canEdit,
      store,
      table,
      nextPosition,
      reportError,
      select,
      toast,
      showId,
      savePersonal,
      draftFor,
      writeOverlay,
    ],
  );

  const actions = useMemo<ViewActions>(
    () => ({
      update,
      select,
      save: () => {
        const cur = latest.current;
        const entry = getDraft(cur.dKey);
        if (!entry) return;
        if (cur.current && entry.baseUpdatedAt !== cur.current.updated_at) {
          // Someone saved this view since: never write over it silently.
          toast("This view changed since your draft: rebase or discard.", "error");
          return;
        }
        if (cur.current) {
          send(
            [
              {
                op: "update",
                table: "views",
                id: cur.current.id,
                fields: { config: entry.config },
              },
            ],
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
                fields: {
                  table,
                  name: DEFAULT_VIEW_NAMES[table],
                  is_default: true,
                  config: entry.config,
                },
              },
            ],
            "save the view",
          );
          select(id);
        }
        setDraft(cur.dKey, undefined);
      },
      discard: () => setDraft(latest.current.dKey, undefined),
      rebase: () => {
        const cur = latest.current;
        const entry = getDraft(cur.dKey);
        if (!entry || !cur.current) return;
        const next = rebaseDraft(entry, cur.saved);
        if (jsonEqual(next, cur.saved)) {
          setDraft(cur.dKey, undefined);
          return;
        }
        setDraft(
          cur.dKey,
          {
            config: next,
            base: cur.saved,
            baseUpdatedAt: cur.current.updated_at,
            savedAt: Date.now(),
          },
          true,
        );
      },
      createPersonal: (name, config) => {
        const id = newId();
        send(
          [
            {
              op: "create",
              table: "views",
              id,
              fields: { table, name, owner_user_id: userId, position: nextPosition(), config },
            },
          ],
          "create the view",
        );
        select(id);
      },
      duplicate: (name, asShared) => {
        const cur = latest.current;
        const id = newId();
        const { forkedFrom: _f, ...config } = cur.config;
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
                config,
              },
            },
          ],
          "create the view",
        );
        // The unsaved changes went into the new view.
        if (!(cur.current && cur.current.owner_user_id !== null)) setDraft(cur.dKey, undefined);
        select(id);
      },
      rename: (id, name) =>
        send([{ op: "update", table: "views", id, fields: { name } }], "rename the view"),
      remove: (id) => {
        send([{ op: "delete", table: "views", id }], "delete the view");
        setDraft(draftKey(userId, showId, id), undefined);
        if (latest.current.current?.id === id) select(null);
      },
      setDefault: (id) =>
        send(
          [{ op: "update", table: "views", id, fields: { is_default: true } }],
          "set the default view",
        ),
    }),
    [update, select, send, table, userId, nextPosition, showId, toast],
  );

  // --- Migrate the M1c localStorage prefs (once per show + table, silently) ---
  // Widths go into your own overlay on the view you're on (shared); collapsed groups to
  // the per-view key; the old live sort is dropped.
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
    if (Object.keys(prefs.widths).length > 0 && cur.current?.owner_user_id === null) {
      writeOverlay(cur.lKey, {
        ...(cur.overlay ?? {}),
        widths: { ...prefs.widths, ...(cur.overlay?.widths ?? {}) },
      });
    }
    try {
      clearLegacyPrefs(localStorage, showId, userId, table);
    } catch {
      // storage blocked
    }
  });

  // --- Units (R11): the view's override, else yours, else the show's default ---
  const userUnit = useUserUnit(userId);
  const showUnit = useShowStore((s) => s.meta.default_unit);
  const unit = resolveUnit(config.unit, userUnit, showUnit);
  const allColumns = useMemo(() => withUnit(setup.columns, unit), [setup.columns, unit]);
  const unitFields = useMemo(() => withUnitFields(fields, unit), [fields, unit]);
  const showUnits = useMemo(() => hasMeasurements(setup.columns), [setup.columns]);

  const narrow = useMediaQuery("(max-width: 480px)");
  const narrowHidden = setup.narrowHidden;
  const layoutConfig = useMemo(() => {
    if (!narrow || !narrowHidden?.length) return config;
    const listed = new Set(config.fields.map((f) => f.key));
    const extra = narrowHidden.filter((k) => !listed.has(k)).map((key) => ({ key, hidden: true }));
    return extra.length ? { ...config, fields: [...config.fields, ...extra] } : config;
  }, [narrow, narrowHidden, config]);
  const columns = useMemo(
    () => layoutColumns(allColumns, layoutConfig),
    [allColumns, layoutConfig],
  );
  const sortKey = JSON.stringify(gridSort(config, allColumns) ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the sort's value
  const sort = useMemo(() => gridSort(config, allColumns), [sortKey]);
  const colorRules = useMemo(
    () => gridColorRules(config.colorRules, unitFields),
    [config.colorRules, unitFields],
  );
  const presets = useMemo(() => colorPresets(table, unitFields), [table, unitFields]);

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
    () => compileFilters(config.filters, config.filterMode, unitFields, true),
    [config.filters, config.filterMode, unitFields],
  );
  /** Rows shown although the filter hides them: the active row, inserts, reveals. */
  const held = useRef(new Set<string>());
  /** Held rows whose hiding was already announced (no second toast when they go). */
  const quiet = useRef(new Set<string>());
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
  const groupField = groupKey ? unitFields.get(groupKey) : undefined;
  const useNative = !!groupKey && groupKey === setup.nativeGroupKey && !!setup.groups;
  const useGeneric = !!groupKey && !useNative && !!groupField && isGroupable(groupField);
  const out = useMemo(() => {
    if (useNative && setup.groups) {
      return { groups: keep ? filterGroups(setup.groups, keep) : setup.groups };
    }
    const rows = keep ? setup.rows.filter(keep) : setup.rows;
    if (useGeneric && groupField) {
      const g = groupRows(rows, groupField, { keepEmpty: !keep });
      // Filtered: only the groups that have rows (like the tab's own groups above).
      return {
        groups: keep ? g.groups.filter((x) => x.rows.length > 0) : g.groups,
        values: g.values,
      };
    }
    return { rows };
  }, [useNative, useGeneric, setup.groups, setup.rows, keep, groupField]);
  const outRef = useRef(out);
  outRef.current = out;

  const shownIds = useMemo(() => {
    const list = out.rows ?? out.groups?.flatMap((g) => g.rows) ?? [];
    return new Set(list.map((r) => rowIdRef.current(r)));
  }, [out]);
  const shownRef = useRef(shownIds);
  shownRef.current = shownIds;
  const rowIds = useMemo(() => new Set(setup.rows.map((r) => rowIdRef.current(r))), [setup.rows]);
  const rowById = useMemo(
    () => new Map(setup.rows.map((r) => [rowIdRef.current(r), r] as const)),
    [setup.rows],
  );
  const rowIdsRef = useRef(rowIds);
  rowIdsRef.current = rowIds;

  const focusRowRef = useRef(setup.focusRow);
  focusRowRef.current = setup.focusRow;
  const clearFilters = useCallback(() => update((c) => ({ ...c, filters: [] })), [update]);
  /** Show a hidden row again and put you in it ("Keep shown"); it goes when you leave it. */
  const keepShown = useCallback((id: string) => {
    held.current.add(id);
    quiet.current.add(id);
    setHeldTick((t) => t + 1);
    requestAnimationFrame(() => focusRowRef.current?.(id));
  }, []);
  const hiddenToast = useCallback(
    (id: string) =>
      toast(HIDDEN_BY_FILTER, "info", {
        actions: [
          { label: "Keep shown", run: () => keepShown(id) },
          { label: "Clear filters", run: clearFilters },
        ],
      }),
    [toast, keepShown, clearFilters],
  );

  // Rows released from a hold that the filter now hides: say so once.
  const released = useRef<string[]>([]);
  useEffect(() => {
    if (released.current.length === 0) return;
    // A render can land between the release and the re-filter (an Enter commit renders the
    // store change first): a released row still shown although the filter rejects it and
    // nothing holds it is waiting for that next render, so keep it until then.
    const waiting: string[] = [];
    const hidden: string[] = [];
    for (const id of released.current) {
      if (!rowIds.has(id) || held.current.has(id)) continue;
      if (!shownIds.has(id)) hidden.push(id);
      else {
        const row = rowById.get(id);
        if (row !== undefined && predicate && !predicate(row)) waiting.push(id);
      }
    }
    released.current = waiting;
    const loud = hidden.filter((id) => !quiet.current.has(id));
    for (const id of hidden) quiet.current.delete(id);
    const first = loud[0];
    if (first !== undefined) hiddenToast(first);
  }, [shownIds, rowIds, rowById, predicate, hiddenToast]);

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
  const reveal = useCallback(
    (id: string): "shown" | "pending" | "missing" => {
      if (shownRef.current.has(id)) return "shown";
      if (!rowIdsRef.current.has(id)) return "missing";
      if (!held.current.has(id)) {
        held.current.add(id);
        quiet.current.add(id); // announced now, not again when you leave it
        setHeldTick((t) => t + 1);
        hiddenToast(id);
      }
      return "pending";
    },
    [hiddenToast],
  );
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
        // into its pickers/menus (portals). Focus that merely dropped (to <body>, e.g. a
        // cell re-rendered after an Enter commit) isn't leaving: only a real element
        // elsewhere is.
        window.setTimeout(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return;
          if (wrap.contains(el) || el.closest("[data-grid-portal]")) return;
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
    <>
      <ViewBar
        table={table}
        current={current}
        shared={shared}
        mine={mine}
        config={layoutConfig}
        dirty={dirty}
        conflict={conflict}
        canEdit={canEdit}
        columns={allColumns}
        fields={unitFields}
        rows={setup.rows}
        presets={presets}
        actions={actions}
        sortPresets={setup.sortPresets}
        sortNow={canEdit ? setup.sortNow : undefined}
        unitOverride={showUnits ? { editable: canEdit || isPersonal } : undefined}
        gallery={setup.gallery}
      />
      {showUnits && (
        <>
          {/* Your unit (a preference in this browser), never the view's. */}
          <UnitToggle
            unit={resolveUnit(undefined, userUnit, showUnit)}
            onChange={(u) => setUserUnit(userId, u)}
          />
          {config.unit && <ViewUnitChip unit={config.unit} />}
        </>
      )}
    </>
  );

  return {
    columns,
    ...(out.rows ? { rows: out.rows } : { groups: out.groups ?? [] }),
    sort,
    sortColumns: allColumns,
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
    reveal,
    trackActive,
    wrapProps,
    toolbar,
    layout: setup.gallery && config.layout === "gallery" ? "gallery" : "grid",
    unit,
    viewUnit: config.unit,
    viewId: current?.id ?? null,
  };
}

function readOverlay(key: string): { value?: LayoutOverlay } {
  const v = readPref<LayoutOverlay | undefined>(
    key,
    undefined,
    (x): x is LayoutOverlay | undefined =>
      typeof x === "object" &&
      x !== null &&
      typeof (x as LayoutOverlay).widths === "object" &&
      (x as LayoutOverlay).widths !== null,
  );
  return v ? { value: v } : {};
}

/** A linked record by label: among the rows' links first, then the column's picker search. */
function findRecord<V>(
  field: FieldDef<V>,
  label: string,
  rows: readonly V[],
): PickerItem | undefined {
  const want = label.trim().toLocaleLowerCase();
  const same = (p: PickerItem) => p.label.trim().toLocaleLowerCase() === want;
  for (const r of rows) {
    const hit = linkItems(field.getValue(r)).find(same);
    if (hit) return hit;
  }
  const first = rows[0];
  if (!field.search || first === undefined) return undefined;
  const found = field.search(label, first);
  return Array.isArray(found) ? found.find(same) : undefined;
}

function readStoredIds(key: string): string[] | undefined {
  return readPref<string[] | undefined>(
    key,
    undefined,
    (v): v is string[] | undefined => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
}
