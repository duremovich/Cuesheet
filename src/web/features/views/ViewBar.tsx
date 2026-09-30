// The view toolbar above each grid: the view switcher (shared views, then "My views"; save /
// discard for a changed shared view; duplicate, rename, delete, set as default) and the
// Filter, Sort, Group, Fields, Row height and Color panels. Every change goes through
// `actions.update`, which decides between a draft, a save, or a personal copy.

import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { ViewRow, ViewTable } from "../../../shared/tables";
import { isUnit, UNIT_LABELS, UNITS } from "../../../shared/units";
import {
  type ColorRule,
  defaultViewConfig,
  type OptionColor,
  type RowHeightName,
  type ViewConfig,
} from "../../../shared/views";
import { type Column, OPTION_COLORS } from "../../components/grid/types";
import { FieldsManager } from "../custom/FieldsManager";
import { type FieldDef, fieldList, isComplete, withFieldOrder } from "./evaluate";
import { FilterEditor, newFilter } from "./FilterEditor";
import { isGroupable } from "./grouping";
import { Popover } from "./Popover";
import type { ColorPreset } from "./presets";
import type { SortPreset, ViewActions } from "./useViewConfig";
import styles from "./ViewBar.module.css";

export interface ViewBarProps<V> {
  table: ViewTable;
  current: ViewRow | null;
  shared: ViewRow[];
  mine: ViewRow[];
  config: ViewConfig;
  dirty: boolean;
  /** The shared view was saved by someone else since this draft started. */
  conflict: boolean;
  canEdit: boolean;
  columns: Column<V>[];
  fields: ReadonlyMap<string, FieldDef<V>>;
  rows: readonly V[];
  presets: ColorPreset[];
  actions: ViewActions;
  sortPresets?: SortPreset[] | undefined;
  sortNow?: { label: string; run: () => Promise<boolean> } | undefined;
  /** Offer the Grid / Gallery toggle and a gallery preset view (R19). */
  gallery?: { presetName: string } | undefined;
  /**
   * Tables with measurements: the Fields popover's "Unit override" (the view's unit, which
   * wins over everyone's own unit). `editable`: editors (and a personal view's owner).
   */
  unitOverride?: { editable: boolean } | undefined;
  /** The table's custom fields (Fields → the Fields manager, R9); omit: none. */
  fieldTable?: string | undefined;
  /** One-click personal views under My views. */
  viewPresets?: { name: string; config: ViewConfig }[] | undefined;
  /** Export CSV (R26). */
  onExport?: ((opts: { bom?: boolean; includeSensitive?: boolean }) => void) | undefined;
  /** Owners may include sensitive (masked) fields in an export. */
  canExportSensitive?: boolean;
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined || to < 0 || to > next.length) return [...list];
  next.splice(to, 0, item);
  return next;
}

export function ViewBar<V>(p: ViewBarProps<V>) {
  return (
    <div className={styles.bar} data-testid="view-bar">
      <ViewSwitcher {...p} />
      {p.dirty && p.canEdit && p.conflict && (
        <span className={styles.dirty} role="status">
          <span data-testid="view-conflict" className={styles.dirtyBadge}>
            This view changed since your draft
          </span>
          <button type="button" className={styles.toolButton} onClick={p.actions.rebase}>
            Rebase
          </button>
          <button type="button" className={styles.toolButton} onClick={p.actions.discard}>
            Discard
          </button>
        </span>
      )}
      {p.dirty && p.canEdit && !p.conflict && (
        <span className={styles.dirty}>
          <span data-testid="view-dirty" className={styles.dirtyBadge}>
            Unsaved changes
          </span>
          <button type="button" className={styles.toolButton} onClick={p.actions.save}>
            Save view
          </button>
          <button type="button" className={styles.toolButton} onClick={p.actions.discard}>
            Discard
          </button>
        </span>
      )}
      <FilterPanel {...p} />
      <SortPanel {...p} />
      <GroupPanel {...p} />
      <FieldsPanel {...p} />
      <RowHeightPanel {...p} />
      <ColorPanel {...p} />
      {p.gallery && <LayoutToggle {...p} />}
      {p.onExport && <ExportPanel {...p} />}
    </div>
  );
}

// ---- Export (R26) ----

function ExportPanel<V>({ onExport, canExportSensitive, columns }: ViewBarProps<V>) {
  const [bom, setBom] = useState(true);
  const [sensitive, setSensitive] = useState(false);
  const hasSensitive = columns.some((c) => c.masked);
  return (
    <Popover label="Export CSV" testId="view-export" button="Export">
      {(close) => (
        <div className={styles.stack}>
          <p className={styles.muted}>
            The rows and fields of this view, as shown (filters, sort and grouping).
          </p>
          <label className={styles.check}>
            <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} />
            For Excel (UTF-8 byte order mark)
          </label>
          {hasSensitive && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={sensitive}
                disabled={!canExportSensitive}
                onChange={(e) => setSensitive(e.target.checked)}
              />
              Include sensitive fields{canExportSensitive ? "" : " (owner only)"}
            </label>
          )}
          <div className={styles.row}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                onExport?.({ bom, includeSensitive: sensitive && !!canExportSensitive });
                close();
              }}
            >
              Download CSV
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

// ---- View switcher ----

function ViewSwitcher<V>({
  table,
  current,
  shared,
  mine,
  canEdit,
  actions,
  dirty,
  gallery,
  viewPresets,
}: ViewBarProps<V>) {
  const [form, setForm] = useState<null | { kind: "mine" | "shared" | "rename"; name: string }>(
    null,
  );
  const name = current?.name ?? "Default view";
  const canManage = !!current && (current.owner_user_id !== null || canEdit);
  const isShared = !!current && current.owner_user_id === null;
  const lastShared = isShared && shared.length <= 1;

  const item = (v: ViewRow, close: () => void) => (
    <li key={v.id}>
      <button
        type="button"
        className={styles.viewItem}
        aria-current={v.id === current?.id ? "true" : undefined}
        onClick={() => {
          actions.select(v.id);
          close();
        }}
      >
        <span>{v.name || "Untitled view"}</span>
        {v.is_default && <span className={styles.muted}> · default</span>}
      </button>
    </li>
  );

  return (
    <Popover
      label="Views"
      testId="view-switcher"
      button={
        <>
          <span className={styles.muted}>View:</span>{" "}
          <span className={styles.viewName} data-testid="current-view">
            {name}
          </span>
          {dirty && <span aria-hidden="true"> •</span>} ▾
        </>
      }
      onOpenChange={(o) => {
        if (!o) setForm(null);
      }}
    >
      {(close) => (
        <div className={styles.stack}>
          <section aria-label="Shared views">
            <h4 className={styles.sectionTitle}>Shared views</h4>
            <ul className={styles.viewList}>
              {shared.map((v) => item(v, close))}
              {shared.length === 0 && <li className={styles.muted}>None yet</li>}
            </ul>
          </section>
          <section aria-label="My views">
            <h4 className={styles.sectionTitle}>My views</h4>
            <ul className={styles.viewList}>
              {mine.map((v) => item(v, close))}
              {mine.length === 0 && <li className={styles.muted}>None yet</li>}
              {gallery && !mine.some((v) => v.name === gallery.presetName) && (
                <li>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                      actions.createPersonal(gallery.presetName, {
                        ...defaultViewConfig(table),
                        layout: "gallery",
                      });
                      close();
                    }}
                  >
                    + {gallery.presetName}
                  </button>
                </li>
              )}
              {viewPresets
                ?.filter((p) => !mine.some((v) => v.name === p.name))
                .map((p) => (
                  <li key={p.name}>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => {
                        actions.createPersonal(p.name, p.config);
                        close();
                      }}
                    >
                      + {p.name}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
          {form ? (
            <form
              className={styles.nameForm}
              onSubmit={(e) => {
                e.preventDefault();
                const n = form.name.trim();
                if (!n) return;
                if (form.kind === "rename" && current) actions.rename(current.id, n);
                else if (form.kind !== "rename") actions.duplicate(n, form.kind === "shared");
                setForm(null);
                close();
              }}
            >
              <label className={styles.field}>
                <span>
                  {form.kind === "rename"
                    ? "New name"
                    : form.kind === "shared"
                      ? "Shared view name"
                      : "My view name"}
                </span>
                <input
                  className={styles.input}
                  value={form.name}
                  maxLength={100}
                  data-autofocus
                  // biome-ignore lint/a11y/noAutofocus: the form appears on request
                  autoFocus
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <div className={styles.row}>
                <button type="submit" className={styles.primary}>
                  {form.kind === "rename" ? "Rename" : "Create"}
                </button>
                <button type="button" className={styles.toolButton} onClick={() => setForm(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setForm({ kind: "mine", name: `${name} (copy)` })}
              >
                Duplicate as my view…
              </button>
              {canEdit && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setForm({ kind: "shared", name: `${name} (copy)` })}
                >
                  Duplicate as shared view…
                </button>
              )}
              {canManage && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setForm({ kind: "rename", name })}
                >
                  Rename…
                </button>
              )}
              {canEdit && isShared && current && !current.is_default && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    actions.setDefault(current.id);
                    close();
                  }}
                >
                  Set as default for everyone
                </button>
              )}
              {canManage && current && (
                <button
                  type="button"
                  className={styles.dangerButton}
                  data-destructive
                  disabled={lastShared}
                  title={lastShared ? "The table needs at least one shared view" : undefined}
                  onClick={() => {
                    if (!window.confirm(`Delete the view "${name}"?`)) return;
                    actions.remove(current.id);
                    close();
                  }}
                >
                  Delete view
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}

// ---- Filter ----

function ModeSelect({
  value,
  onChange,
  label,
}: {
  value: "and" | "or";
  onChange: (m: "and" | "or") => void;
  label: string;
}) {
  return (
    <label className={styles.inline}>
      <span>Match</span>
      <select
        className={styles.input}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as "and" | "or")}
      >
        <option value="and">all conditions</option>
        <option value="or">any condition</option>
      </select>
    </label>
  );
}

function FilterPanel<V>({ config, fields, rows, actions }: ViewBarProps<V>) {
  const list = [...fields.values()];
  const active = config.filters.filter(isComplete).length;
  const set = (filters: ViewConfig["filters"]) => actions.update((c) => ({ ...c, filters }));
  const stack = useRef<HTMLDivElement>(null);
  const focusNew = useFocusNew(stack, config.filters.length, (n) => `Filter ${n} field`);
  return (
    <Popover
      label="Filter"
      testId="view-filter"
      pressed={active > 0}
      wide
      button={active > 0 ? `Filter (${active})` : "Filter"}
    >
      <div className={styles.stack} ref={stack}>
        {config.filters.length > 1 && (
          <ModeSelect
            label="Filter match"
            value={config.filterMode}
            onChange={(filterMode) => actions.update((c) => ({ ...c, filterMode }))}
          />
        )}
        {config.filters.length === 0 && (
          <p className={styles.muted}>No filters: every row shows.</p>
        )}
        {config.filters.map((f, i) => (
          <FilterEditor
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids; position is identity
            key={i}
            label={`Filter ${i + 1}`}
            filter={f}
            fields={list}
            rows={rows}
            onChange={(nf) => set(config.filters.map((x, j) => (j === i ? nf : x)))}
            onRemove={() => set(config.filters.filter((_, j) => j !== i))}
          />
        ))}
        <div className={styles.row}>
          <button
            type="button"
            className={styles.linkButton}
            disabled={list.length === 0}
            onClick={() => {
              const first = list[0];
              if (!first) return;
              focusNew();
              set([...config.filters, newFilter(first)]);
            }}
          >
            + Add filter
          </button>
          {config.filters.length > 0 && (
            <button
              type="button"
              className={styles.linkButton}
              data-destructive
              onClick={() => set([])}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>
    </Popover>
  );
}

// ---- Sort ----

function SortPanel<V>({ config, columns, actions, sortPresets, sortNow }: ViewBarProps<V>) {
  const live = config.sortMode === "live" && config.sorts.length > 0;
  const first = config.sorts[0];
  const title = (key: string) => columns.find((c) => c.key === key)?.title ?? key;
  const set = (sorts: ViewConfig["sorts"], sortMode = config.sortMode) =>
    actions.update((c) => ({ ...c, sorts, sortMode: sorts.length ? sortMode : "none" }));
  const [busy, setBusy] = useState(false);
  return (
    <Popover
      label="Sort"
      testId="view-sort"
      pressed={live}
      wide
      button={
        live && first
          ? `Sorted by ${title(first.key)} ${first.dir === "desc" ? "↓" : "↑"}${config.sorts.length > 1 ? ` +${config.sorts.length - 1}` : ""}`
          : "Sort"
      }
    >
      {(close) => (
        <div className={styles.stack}>
          {sortPresets?.map((sp) => (
            <button
              key={sp.label}
              type="button"
              className={styles.linkButton}
              aria-pressed={live && JSON.stringify(config.sorts) === JSON.stringify(sp.sorts)}
              onClick={() => {
                set(sp.sorts, "live");
                close();
              }}
            >
              {sp.label}
            </button>
          ))}
          {config.sorts.map((s, i) => (
            <div key={s.key} className={styles.condition}>
              <select
                className={styles.input}
                aria-label={`Sort ${i + 1} field`}
                value={s.key}
                onChange={(e) =>
                  set(config.sorts.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                }
              >
                {columns.map((c) => (
                  <option
                    key={c.key}
                    value={c.key}
                    disabled={c.key !== s.key && config.sorts.some((x) => x.key === c.key)}
                  >
                    {c.title}
                  </option>
                ))}
              </select>
              <select
                className={styles.input}
                aria-label={`Sort ${i + 1} direction`}
                value={s.dir}
                onChange={(e) =>
                  set(
                    config.sorts.map((x, j) =>
                      j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x,
                    ),
                  )
                }
              >
                <option value="asc">A → Z, 1 → 9</option>
                <option value="desc">Z → A, 9 → 1</option>
              </select>
              <button
                type="button"
                className={styles.iconButton}
                data-destructive
                aria-label={`Remove sort ${i + 1}`}
                onClick={() => set(config.sorts.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <div className={styles.row}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                const c = columns.find((col) => !config.sorts.some((s) => s.key === col.key));
                if (c) set([...config.sorts, { key: c.key, dir: "asc" }], "live");
              }}
            >
              + Add sort
            </button>
            {config.sorts.length > 0 && (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  set([], "none");
                  close();
                }}
              >
                Remove sort
              </button>
            )}
          </div>
          {config.sorts.length > 0 && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={config.sortMode === "live"}
                onChange={(e) => set(config.sorts, e.target.checked ? "live" : "none")}
              />
              Keep rows sorted (live; a row you're editing stays put until you leave it)
            </label>
          )}
          {sortNow && (
            <button
              type="button"
              className={styles.linkButton}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                close();
                void sortNow.run().then((done) => {
                  setBusy(false);
                  // Show order now matches: the live sort has nothing left to do.
                  if (done) actions.update((c) => ({ ...c, sortMode: "none" }));
                });
              }}
            >
              {sortNow.label}
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}

// ---- Group ----

function GroupPanel<V>({ config, fields, actions }: ViewBarProps<V>) {
  const groupable = [...fields.values()].filter(isGroupable);
  const current = config.group.key;
  const title = current ? (fields.get(current)?.title ?? current) : null;
  return (
    <Popover
      label="Group"
      testId="view-group"
      pressed={!!current}
      button={title ? `Grouped by ${title}` : "Group"}
    >
      <div className={styles.stack}>
        <fieldset className={styles.radioList}>
          <legend className={styles.sectionTitle}>Group rows by</legend>
          {[{ key: null, title: "None" }, ...groupable].map((f) => (
            <label key={f.key ?? "none"} className={styles.check}>
              <input
                type="radio"
                name="group-by"
                checked={current === f.key}
                onChange={() =>
                  actions.update((c) => ({ ...c, group: { ...c.group, key: f.key } }))
                }
              />
              {f.title}
            </label>
          ))}
        </fieldset>
        {current && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={!!config.group.collapsedByDefault}
              onChange={(e) =>
                actions.update((c) => ({
                  ...c,
                  group: {
                    key: c.group.key,
                    ...(e.target.checked ? { collapsedByDefault: true } : {}),
                  },
                }))
              }
            />
            Start with groups collapsed
          </label>
        )}
      </div>
    </Popover>
  );
}

// ---- Fields ----

function FieldsPanel<V>({
  config,
  columns,
  actions,
  unitOverride,
  fieldTable,
  canEdit,
}: ViewBarProps<V>) {
  const list = fieldList(columns, config);
  const hiddenCount = list.filter((f) => f.hidden).length;
  const [dragging, setDragging] = useState<number | null>(null);
  const setOrder = (order: { key: string; hidden: boolean }[]) =>
    actions.update((c) => ({ ...c, fields: withFieldOrder(columns, c, order) }));
  const visibleCount = list.length - hiddenCount;
  return (
    <Popover
      label="Fields"
      testId="view-fields"
      pressed={hiddenCount > 0}
      button={hiddenCount > 0 ? `Fields (${hiddenCount} hidden)` : "Fields"}
    >
      <div className={styles.stack}>
        <ul className={styles.fieldList}>
          {list.map((f, i) => (
            <li
              key={f.key}
              className={styles.fieldItem}
              data-dragging={dragging === i || undefined}
              draggable
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", f.key);
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== i) setOrder(move(list, dragging, i));
                setDragging(null);
              }}
            >
              <span className={styles.handle} aria-hidden="true">
                ⠿
              </span>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={!f.hidden}
                  onChange={(e) =>
                    setOrder(
                      list.map((x) => (x.key === f.key ? { ...x, hidden: !e.target.checked } : x)),
                    )
                  }
                />
                {f.title}
              </label>
              <span className={styles.moveButtons}>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={`Move ${f.title} up`}
                  disabled={i === 0}
                  onClick={() => setOrder(move(list, i, i - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={`Move ${f.title} down`}
                  disabled={i === list.length - 1}
                  onClick={() => setOrder(move(list, i, i + 1))}
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ul>
        <div className={`${styles.row} ${styles.frozenRow}`}>
          <label className={styles.inline}>
            <span>Frozen columns</span>
            <input
              type="number"
              className={styles.input}
              style={{ width: "4.5em" }}
              min={0}
              max={Math.min(5, visibleCount)}
              value={config.frozenCount}
              onChange={(e) => {
                const n = Math.max(0, Math.min(5, Math.round(Number(e.target.value) || 0)));
                actions.update((c) => ({ ...c, frozenCount: n }));
              }}
            />
          </label>
          {hiddenCount > 0 && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setOrder(list.map((x) => ({ ...x, hidden: false })))}
            >
              Show all
            </button>
          )}
        </div>
        {unitOverride && (
          <div className={styles.row}>
            <label className={styles.inline}>
              <span>Unit override</span>
              <select
                className={styles.input}
                disabled={!unitOverride.editable}
                value={config.unit ?? ""}
                onChange={(e) => {
                  const u = e.target.value;
                  actions.update((c) => {
                    const { unit: _u, ...rest } = c;
                    return isUnit(u) ? { ...rest, unit: u } : rest;
                  });
                }}
              >
                <option value="">None (everyone's own unit)</option>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABELS[u]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {fieldTable && <FieldsManager fieldTable={fieldTable} canEdit={canEdit} />}
      </div>
    </Popover>
  );
}

// ---- Layout: grid / gallery (R19) ----

function LayoutToggle<V>({ config, actions }: ViewBarProps<V>) {
  const gallery = config.layout === "gallery";
  return (
    <button
      type="button"
      className={styles.toolButton}
      aria-pressed={gallery}
      data-testid="view-layout"
      title={gallery ? "Show as a grid" : "Show as gallery cards"}
      onClick={() =>
        actions.update((c) => {
          const { layout: _l, ...rest } = c;
          return gallery ? rest : { ...rest, layout: "gallery" };
        })
      }
    >
      Gallery
    </button>
  );
}

// ---- Row height ----

const HEIGHTS: { value: RowHeightName; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "normal", label: "Normal" },
  { value: "tall", label: "Tall" },
];

function RowHeightPanel<V>({ config, actions }: ViewBarProps<V>) {
  return (
    <Popover label="Row height" testId="view-row-height" button="Row height">
      <fieldset className={styles.radioList}>
        <legend className={styles.sectionTitle}>Row height</legend>
        {HEIGHTS.map((h) => (
          <label key={h.value} className={styles.check}>
            <input
              type="radio"
              name="row-height"
              checked={config.rowHeight === h.value}
              onChange={() => actions.update((c) => ({ ...c, rowHeight: h.value }))}
            />
            {h.label}
          </label>
        ))}
      </fieldset>
    </Popover>
  );
}

// ---- Color ----

function Swatches({
  value,
  onChange,
  label,
}: {
  value: OptionColor;
  onChange: (c: OptionColor) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={styles.swatches}>
      {OPTION_COLORS.map((c) => (
        // biome-ignore lint/a11y/useSemanticElements: a swatch is a visual radio button
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          className={styles.swatch}
          style={{ background: `var(--option-${c}-bg)`, borderColor: `var(--option-${c}-fg)` }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function ColorPanel<V>({ config, fields, columns, rows, presets, actions }: ViewBarProps<V>) {
  const list = [...fields.values()];
  const rules = config.colorRules;
  const set = (colorRules: ColorRule[]) => actions.update((c) => ({ ...c, colorRules }));
  const setRule = (i: number, r: ColorRule) => set(rules.map((x, j) => (j === i ? r : x)));
  const [dragging, setDragging] = useState<number | null>(null);
  const first = list[0];
  return (
    <Popover
      label="Color"
      testId="view-color"
      pressed={rules.length > 0}
      wide
      button={rules.length > 0 ? `Color (${rules.length})` : "Color"}
    >
      <div className={styles.stack}>
        <p className={styles.muted}>
          Rules apply in order: the first matching row rule colors the row; cell rules stack.
        </p>
        <ol className={styles.ruleList}>
          {rules.map((r, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids; position is identity
              key={i}
              className={styles.rule}
              data-testid="color-rule"
              draggable
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging !== null && dragging !== i) set(move(rules, dragging, i));
                setDragging(null);
              }}
            >
              <div className={styles.ruleHeader}>
                <span className={styles.handle} aria-hidden="true">
                  ⠿
                </span>
                <strong>Rule {i + 1}</strong>
                <span className={styles.moveButtons}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={`Move rule ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => set(move(rules, i, i - 1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={`Move rule ${i + 1} down`}
                    disabled={i === rules.length - 1}
                    onClick={() => set(move(rules, i, i + 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    data-destructive
                    aria-label={`Remove rule ${i + 1}`}
                    onClick={() => set(rules.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              </div>
              {r.when.length > 1 && (
                <ModeSelect
                  label={`Rule ${i + 1} match`}
                  value={r.mode}
                  onChange={(mode) => setRule(i, { ...r, mode })}
                />
              )}
              {r.when.map((f, j) => (
                <FilterEditor
                  // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids
                  key={j}
                  label={`Rule ${i + 1} condition ${j + 1}`}
                  filter={f}
                  fields={list}
                  rows={rows}
                  onChange={(nf) =>
                    setRule(i, { ...r, when: r.when.map((x, k) => (k === j ? nf : x)) })
                  }
                  onRemove={() => setRule(i, { ...r, when: r.when.filter((_, k) => k !== j) })}
                />
              ))}
              <button
                type="button"
                className={styles.linkButton}
                disabled={!first}
                onClick={() => first && setRule(i, { ...r, when: [...r.when, newFilter(first)] })}
              >
                + Add condition
              </button>
              <div className={styles.row}>
                <label className={styles.inline}>
                  <span>Color</span>
                  <select
                    className={styles.input}
                    aria-label={`Rule ${i + 1} target`}
                    value={r.target === "row" ? "" : r.target.cell}
                    onChange={(e) =>
                      setRule(i, {
                        ...r,
                        target: e.target.value ? { cell: e.target.value } : "row",
                      })
                    }
                  >
                    <option value="">the whole row</option>
                    {columns.map((c) => (
                      <option key={c.key} value={c.key}>
                        the {c.title} cell
                      </option>
                    ))}
                  </select>
                </label>
                <Swatches
                  label={`Rule ${i + 1} color`}
                  value={r.color}
                  onChange={(color) => setRule(i, { ...r, color })}
                />
              </div>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className={styles.linkButton}
          disabled={!first}
          onClick={() =>
            first &&
            set([
              ...rules,
              { when: [newFilter(first)], mode: "and", target: "row", color: "green" },
            ])
          }
        >
          + Add rule
        </button>
        {presets.length > 0 && (
          <section aria-label="Presets">
            <h4 className={styles.sectionTitle}>Presets</h4>
            <div className={styles.presetList}>
              {presets.map((pr) => (
                <button
                  key={pr.id}
                  type="button"
                  className={styles.toolButton}
                  onClick={() => set([...rules, ...pr.rules])}
                >
                  + {pr.label}
                </button>
              ))}
            </div>
          </section>
        )}
        {rules.length > 0 && (
          <button
            type="button"
            className={styles.dangerButton}
            data-destructive
            onClick={() => set([])}
          >
            Remove all rules
          </button>
        )}
      </div>
    </Popover>
  );
}

/**
 * After "+ Add …": focus the new row's first control once it renders. Call the returned
 * function right before adding; `label(n)` is the accessible name of row n's control.
 */
function useFocusNew(
  container: RefObject<HTMLElement | null>,
  count: number,
  label: (n: number) => string,
): () => void {
  const want = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (want.current === null || count < want.current) return;
    const n = want.current;
    want.current = null;
    container.current
      ?.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label(n))}"]`)
      ?.focus();
  });
  return () => {
    want.current = count + 1;
  };
}
