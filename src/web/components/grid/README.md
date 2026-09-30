# DataGrid

The spreadsheet-like grid every table in Cuesheet uses (cues, content, scenes, notes...).
It is **data-agnostic**: you give it rows (or groups of rows), column definitions and
callbacks; it owns only UI state (active cell, editing, selection, collapse, column widths,
its undo stack). It never fetches or persists anything.

Behavior follows `docs/spec/ux.md` §Ordering and sorting, §Inserting a cue, §Grid,
§Grouping and §Conditional formatting (R1–R5a, R17, R28).

```tsx
import { DataGrid, type Column } from "../components/grid";
```

Try it at **`/dev/grid`** (`pnpm dev`, then open http://localhost:5173/dev/grid): the Some
Like It Hot cue list from `examples/`, in memory, with toggles for grouping, live sort, row
height, colors and 5,000 rows. Source: `src/web/pages/dev/`.

## Files

| File | What |
| --- | --- |
| `DataGrid.tsx` | The component (+ `GridRow`, `PickerFor`) |
| `types.ts` | All public types |
| `ordering.ts` | Pure sort / hold / flatten logic (`sortRows`, `applyHolds`, `buildLayout`) |
| `values.ts` | Empty values, formatting, parsing typed/pasted text, TSV, `UndoStack` |
| `RecordPicker.tsx` | Find-or-create popover, exported for reuse (panels, tech mode, script view) |
| `ContextMenu.tsx`, `Chip.tsx`, `cells.tsx`, `icons.tsx`, `popover.ts` | Pieces |

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `columns` | `Column<Row>[]` | Order = display order, except `frozen` columns render first |
| `rowId` | `(r) => string` | Stable id; used as React key and in every callback |
| `rows` / `groups` | `Row[]` / `Group<Row>[]` | Exactly one. Rows render **in the order given** (show order) unless `sort` is set |
| `isSection` | `(r) => boolean` | Full-width divider rows ("INTERMISSION"); not numbered or counted |
| `sectionLabelKey` | `string` | Column shown and edited as a section's label (default: first text column). Cues: `"description"` |
| `onEdit` | `(rowId, key, value) => void \| Promise` | Every cell change, including undo/redo replays |
| `onInsert` | `({afterRowId?, beforeRowId?, groupId?}) => string \| Promise<string>` | Create the row, return its id. The grid focuses its first editable cell once the id shows up in `rows`/`groups` |
| `onMove` | `(rowId, {afterRowId?, beforeRowId?, groupId?}) => void` | Drag to reorder. `groupId` is set when grouped (a different one = re-link, e.g. scene) |
| `onDelete` | `(rowIds) => void` | Delete key on a row selection, or the context menu |
| `onOpenRow` | `(rowId) => void` | Space, the expand icon, or "Open" in the menu |
| `sort` | `{key, dir}[]` | Live sort (see Ordering). Omit for show order |
| `colorRules` | `ColorRule<Row>[]` | Conditional formatting |
| `rowHeight` | `"compact" \| "normal" \| "tall"` | 30 / 40 / 72 px; long text clamps to 1 / 2 / 3 lines |
| `selectedRowIds` + `onSelectionChange` | `string[]` | Controlled row selection; omit `selectedRowIds` for internal state |
| `onColumnResize` | `(key, width) => void` | Persist widths per view; pass them back as `column.width` |
| `aria-label` | `string` | Name of the grid (e.g. "Cue list") |
| `className` | `string` | On the root. The root is `height: 100%`: **give its parent a height** |

### `Column<Row>`

| Field | Notes |
| --- | --- |
| `key`, `title` | `key` is what `onEdit` receives |
| `type` | `text`, `longtext`, `number`, `checkbox`, `select`, `multiselect`, `link`, `multilink`, `readonly` |
| `getValue(row)` | See value shapes below |
| `format(v)` | Display text for text-like and readonly cells (also used for copy) |
| `width`, `minWidth` | Default 160 / 60 |
| `frozen` | Stays put on horizontal scroll. A leading run of frozen columns; on narrow screens only the first stays frozen once they'd take > 60% of the width |
| `editable` | `boolean` or `(row) => boolean`; default true (never for `readonly`) |
| `options` | select/multiselect: `{value, label?, color?}`; order = sort order; `color` is an option palette name (`gray red orange yellow green teal blue purple pink`) |
| `search(q, row)` | link/multilink: return `PickerItem[]` (sync or async). Called debounced 100 ms with the row being edited: rank same-scene records first here; the grid adds recently picked ones on top |
| `create(name, row)` | link/multilink: create a record from the typed name in the row's context (e.g. its scene), return its `PickerItem`. Enables the "Create '…'" row |
| `compare(a, b)` | Custom sort for non-empty values |

**Value shapes** (what `getValue` returns and `onEdit` receives):

| Type | Value | Cleared (Delete) |
| --- | --- | --- |
| text, longtext | `string` | `""` |
| number | `number \| null` (typed text is parsed; `1,250.5` ok) | `null` |
| checkbox | `boolean` | `false` |
| select | option `value` or `null` | `null` |
| multiselect | option `value[]` | `[]` |
| link | `PickerItem \| null` (`{id, label, secondary?, color?}`) | `null` |
| multilink | `PickerItem[]` | `[]` |

Link values carry labels so the grid can render and undo without lookups. The consumer maps
`PickerItem.id` to its foreign keys in `onEdit`.

## Ordering (R1, R2)

- **Show order** (no `sort`): rows render exactly as given. Edits never move a row.
  Drag the handle on the row number to reorder: `onMove(id, {afterRowId | beforeRowId,
  groupId?})`. Compute the new `order_key` between those neighbors (fractional index,
  decision 0003); only the dragged row's key changes.
- **Live sort** (`sort` set): the grid sorts (stable, multi-key, **empty values last** in
  both directions; decimal strings compare numerically, so 14.2 < 14.25 < 14.3). The
  **focused row is held** at its place (anchored after its predecessor) while focus stays
  in it, even if its values now sort elsewhere. When focus leaves the row (another row,
  Escape when not editing, focus leaving the grid), it slides to its sorted place and is
  highlighted for ~2.4 s (`data-moved`). A just-inserted row is held where it was
  inserted until you leave it. Dragging is disabled and a hint explains why.
- **Groups**: sorting and holds apply within each group. If an edit moves the focused row
  to another group (e.g. the scene field changed), it stays in its old group until focus
  leaves it.
- "Sort now" (rewrite `order_key`s to match a sort) is a data-layer command, not a grid
  feature: compute the keys, then clear `sort`.

## Keyboard

| Keys | Not editing | Editing |
| --- | --- | --- |
| Arrows | Move (Shift extends a cell range) | Move the caret |
| Enter | Start editing (checkbox: toggle) | Commit, move down |
| Tab / Shift+Tab | Move right / left (wraps rows; leaves the grid at the ends) | Commit, move right / left |
| Escape | Clear range + selection; end the row hold | Cancel |
| F2, double-click | Start editing | |
| Any character | Start editing with it (select/link: open the picker with it as the query) | |
| Space | `onOpenRow` | |
| Delete / Backspace | Selected rows: `onDelete`. Else clear the range / cell | |
| ⌘/Ctrl+Enter | | New line (long text). Shift+Enter also works |
| ⌘/Ctrl+Shift+Enter | Insert row below | Commit, insert below |
| ⌘/Ctrl+Shift+↑ | Insert row above | Commit, insert above |
| ⌘/Ctrl+D | Duplicate row (insert below + `onEdit` per editable, non-empty column) | |
| ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z (or ⌘/Ctrl+Y) | Undo / redo edits made through this grid | |
| ⌘/Ctrl+A | Select all rows | |
| ⌘/Ctrl+C / V | Copy TSV (row selection, range or cell) / paste TSV from the active cell | |
| Shift+F10, ContextMenu | Row menu | |

**Pickers** (select, multiselect, link, multilink): typing filters; ↑/↓ move; Enter picks
(stays on the cell); Tab picks and moves right; Escape closes. Multi pickers stay open
after a pick, toggle already-picked items off, and Backspace in an empty search removes
the last chip. Link pickers list recently picked records first (per column, in memory) and
end with **Create "…"** when `create` is set and no label matches exactly; Enter on it
calls `create` and links the result. Enter before the debounce fires searches first, so
fast typing picks the right record.

**Paste** fills text, long text, number and select cells (select by value or label);
other types, read-only and non-editable cells are skipped. One value pasted onto a range
fills the range. A paste is one undo step.

**Undo** replays the inverse `onEdit` calls, so it works with any data layer. It covers
edits made through this grid instance only (not inserts, moves or deletes).

## Mouse

- Click selects a cell; Shift+click extends a range. Double-click edits.
- Row number: click selects the row, Shift+click a range, ⌘/Ctrl+click toggles.
- Hover the row number for the drag handle, the expand (open) icon, and a `+` on the row's
  bottom edge that inserts below.
- Right-click a row: Insert above / below, Duplicate, Open, Delete (the whole selection if
  the row is part of one).
- Group header: collapse toggle (state kept in the grid by group id) and **+ Add row**
  (`onInsert({groupId})`: append to that group).
- Drag a header's right edge to resize.

## Conditional formatting (R17)

```ts
const rules: ColorRule<Cue>[] = [
  ...STATUS.map((o) => ({ when: (c) => c.status === o.value, row: o.color })), // color by status
  { when: (c) => c.content.length === 0, cell: { key: "content", color: "orange" } },
];
```

Rules are evaluated per row in order. The first matching `row` rule sets the row
background (`--option-<color>-bg`, text stays `--color-text`); `cell` rules stack (later
wins) and set background + text (`--option-<color>-bg/fg`). Selection and range highlight
draw on top. Build the rules from a view's saved rule list (field, operator, value) in the
data layer; keep the array identity stable (`useMemo`) so rows don't re-render.

## Wiring a real table

```tsx
const columns = useMemo<Column<Cue>[]>(() => [
  { key: "number", title: "Cue", type: "text", width: 80, frozen: true, getValue: (c) => c.number },
  { key: "description", title: "Description", type: "longtext", width: 260, getValue: (c) => c.description },
  { key: "status", title: "Status", type: "select", options: STATUS, getValue: (c) => c.status },
  {
    key: "content", title: "Content", type: "multilink", width: 240,
    getValue: (c) => c.contentIds.map((id) => ({ id, label: contentById.get(id)?.name ?? "?" })),
    search: (q, cue) => store.searchContent(q, { sceneFirst: cue.sceneId }),
    create: (name, cue) => store.createContent({ name, sceneId: cue.sceneId }), // → PickerItem
  },
], [store, contentById]);

<div style={{ height: "calc(100dvh - 120px)" }}>
  <DataGrid<Cue>
    aria-label="Cue list"
    columns={columns}
    rowId={(c) => c.id}
    groups={groupsByScene}          // Unassigned first, then scenes; rows in order_key order
    isSection={(c) => c.isSection}
    sectionLabelKey="description"
    sort={view.sort}
    colorRules={rules}
    rowHeight={view.rowHeight}
    onEdit={(id, key, value) => store.updateCue(id, { [key]: toField(key, value) })}
    onInsert={(pos) => store.insertCue(pos)} // key between neighbors; sceneId = pos.groupId
    onMove={(id, pos) => store.moveCue(id, pos)}
    onDelete={(ids) => store.deleteCues(ids)}
    onOpenRow={(id) => openPanel(id)}
    onColumnResize={(key, w) => saveViewWidth(key, w)}
  />
</div>
```

Notes for the integration:

- **Optimistic updates.** Apply `onEdit`/`onInsert`/`onMove` to local state immediately
  (then send to the ShowDO). The grid reads values back from `rows`, so a slow round trip
  shows the old value until it lands. `onInsert` may be async; the new row is focused when
  its id appears.
- **Neighbors are display neighbors.** `afterRowId`/`beforeRowId` refer to the row next to
  the insert/drop point *as displayed* (possibly sorted). In show order that is also the
  `order_key` neighbor; under a live sort, place the new row by key next to that row.
- **`groupId`** is set on insert/move whenever `groups` is used. For the Unassigned group,
  use a sentinel id and map it to `scene_id = null`.
- **Stable identities.** Memoize `columns`, `groups`/`rows`, `colorRules` and `rowId`;
  rows re-render when their row object or these change.
- **Remote edits** re-render the affected rows; a remote change never moves the row you're
  in (it's held), but other rows re-sort immediately under a live sort.
- **Scroll container.** The grid scrolls internally (both axes) with a sticky header row,
  sticky group headers and a frozen row-number column. It never widens the page.

## Accessibility

`role="grid"` with `row`/`columnheader`/`rowheader`/`gridcell`, `aria-rowindex` (header =
1), `aria-colindex`, `aria-selected`, `aria-readonly`, `aria-sort`, `aria-expanded` on
group toggles. Roving tabindex: only the active cell is in the tab order; focus is always a
real cell element, and the active row is always rendered even when virtualized away. Icon
buttons have labels ("Open row 12", "Insert row below row 12", "Collapse 105 Scene Five").
The focus ring uses `--color-focus-ring`.

## Tests

- `ordering.test.ts`, `values.test.ts` (node): sort, holds, layout, TSV, parsing, undo.
- `DataGrid.test.tsx` (jsdom, `pnpm test --project dom`): keyboard, editing, undo/redo,
  live-sort holds, insert, pickers incl. create, clipboard, selection, groups, sections,
  context menu, resize.
- `e2e/grid.spec.ts` against `/dev/grid`: editing, insert under live sort, drag (within and
  across groups), picker create, collapse + sticky headers, 5,000 rows, 390 px.
