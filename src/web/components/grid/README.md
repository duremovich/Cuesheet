# DataGrid

The spreadsheet-like grid every table in Cuesheet uses (cues, content, scenes, notes...).
It is **data-agnostic**: you give it rows (or groups of rows), column definitions and
callbacks; it owns only UI state (active cell, editing, selection, collapse, column widths,
its undo stack). It never fetches or persists anything.

Behavior follows `docs/spec/ux.md` §Ordering and sorting, §Inserting a cue, §Grid,
§Grouping and §Conditional formatting (R1–R5a, R17, R28).

```tsx
import { DataGrid, type Column, type DataGridHandle } from "../components/grid";
```

Try it at **`/dev/grid`** (`pnpm dev`, then open `/dev/grid` on the dev server): the Some
Like It Hot cue list from `examples/`, in memory, with toggles for grouping, live sort, row
height, colors and 5,000 rows. It also shows `cellDecoration` (duplicate cue numbers are
underlined; an unnumbered cue suggests the midpoint number). Source: `src/web/pages/dev/`.

## Files

| File | What |
| --- | --- |
| `DataGrid.tsx` | The component (+ `GridRow`, `PickerFor`, `ConfirmDelete`) |
| `types.ts` | All public types |
| `ordering.ts` | Pure sort / hold / flatten logic (`sortRows`, `applyHolds`, `buildLayout`) |
| `values.ts` | Empty values, formatting, parsing typed/pasted text, TSV, `UndoStack` |
| `RecordPicker.tsx` | Find-or-create popover, exported for reuse (panels, tech mode, script view) |
| `ContextMenu.tsx`, `Chip.tsx`, `cells.tsx`, `icons.tsx`, `popover.ts` | Pieces |

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `columns` | `Column<Row>[]` | Order = display order, except `frozen` columns render first. Memoize it |
| `rowId` | `(r) => string` | Stable id; React key and every callback's id. An inline lambda is fine (read through a ref) |
| `rows` / `groups` | `Row[]` / `Group<Row>[]` | Exactly one. Rows render **in the order given** (show order) unless `sort` is set |
| `isSection` | `(r) => boolean` | Full-width divider rows ("INTERMISSION"); not numbered or counted. Inline is fine |
| `sectionLabelKey` | `string` | Column shown and edited as a section's label (default: first text column). Cues: `"description"` |
| `onEdit` | `(rowId, key, value) => void \| Promise` | Every cell change, including undo/redo replays |
| `onInsert` | `({afterRowId?, beforeRowId?, groupId?}) => string \| Promise<string>` | Create the row, return its id. The grid focuses its first editable cell once the id shows up in `rows`/`groups` |
| `onMove` | `(rowId, {afterRowId?, beforeRowId?, groupId?}) => void` | Drag to reorder. `groupId` is set when grouped (a different one = re-link, e.g. scene) |
| `onDelete` | `(rowIds) => void` | Delete key on a row selection (the active row must be in it), or the context menu. More than one row asks for confirmation first |
| `onOpenRow` | `(rowId) => void` | Space, the expand icon, or "Open" in the menu |
| `sort` | `{key, dir}[]` | Live sort (see Ordering). Omit for show order |
| `sortColumns` | `Column<Row>[]` | Columns `sort` keys resolve against when some aren't shown (a view sorting by a hidden field). Default: `columns` |
| `colorRules` | `ColorRule<Row>[]` | Conditional formatting. Memoize it |
| `cellDecoration` | `(row, key) => {warning?, ghost?} \| undefined` | `warning`: wavy orange underline + tooltip + screen-reader text. `ghost`: a suggestion shown in the active empty cell (and as the editor's placeholder); Tab or → accepts it, typing replaces it. Text/long text/number columns. Memoize it |
| `rowHeight` | `"compact" \| "normal" \| "tall"` | 30 / 40 / 72 px; long text clamps to 1 / 2 / 3 lines |
| `selectedRowIds` + `onSelectionChange` | `string[]` | Controlled row selection; omit `selectedRowIds` for internal state |
| `collapsed` + `onCollapsedChange` | `string[]` | Controlled collapsed group ids (per user, per ux.md); omit `collapsed` for internal state |
| `onActiveRowChange` | `(rowId \| null) => void` | The active row changed (`null`: none, or a group header). Drive the detail panel / presence from it |
| `extraMenuItems` | `({rowId, selectedRowIds}) => MenuItem[]` | Extra context-menu entries ("Show in script", "Move to scene…"), inserted before Delete |
| `onColumnResize` | `(key, width) => void` | Persist widths per view; pass them back as `column.width` |
| `onError` | `(error, action) => void` | A callback threw or rejected (`action`: edit / insert / duplicate / move / delete). The grid also shows a short inline message. Default: `console.error` |
| `onEscape` | `() => void` | Escape with nothing left to cancel in the grid (not editing; no range, row selection, or held row that would move). E.g. close a detail panel |
| `addRowLabel` | `string` | The group header's add button ("Add cue"; default "Add row"); its accessible name is "<label> to <group>" |
| `ref` | `Ref<DataGridHandle>` | `focusRow(id, columnKey?)` activates and focuses a row (expanding its group; a row outside the view is scrolled to the vertical middle); `stepRow(±1)` makes the next/previous row active without moving DOM focus (↑/↓ in a panel); `scrollToRow(id)` scrolls to it without moving focus |
| `aria-label` | `string` | Name of the grid (e.g. "Cue list") |
| `className` | `string` | On the root. The root is `height: 100%`: **give its parent a height** |

### `Column<Row>`

| Field | Notes |
| --- | --- |
| `key`, `title` | `key` is what `onEdit` receives |
| `type` | `text`, `longtext`, `number`, `checkbox`, `select`, `multiselect`, `link`, `multilink`, `readonly`, `attachment` |
| `getValue(row)` | See value shapes below |
| `format(v)` | Display text for text-like and readonly cells (also used for copy) |
| `width`, `minWidth` | Default 160 / 60 |
| `frozen` | Stays put on horizontal scroll. A leading run of frozen columns; on narrow screens only the first stays frozen once they'd take > 60% of the width |
| `editable` | `boolean` or `(row) => boolean`; default true (never for `readonly`) |
| `options` | select/multiselect: `{value, label?, color?}`; order = sort order; `color` is an option palette name (`gray red orange yellow green teal blue purple pink`) |
| `search(q, row)` | link/multilink: return `PickerItem[]` (sync or async). Called debounced 100 ms with the row being edited: rank same-scene records first here; the grid adds recently picked ones on top |
| `create(name, row)` | link/multilink: create a record from the typed name in the row's context (e.g. its scene), return its `PickerItem`. Enables the "Create '…'" row |
| `compare(a, b)` | Custom sort for non-empty values |
| `renderCell(row)` | attachment: the cell's content (a thumbnail strip) |
| `onOpen(row)` | attachment: Enter, F2 or double-click (open a lightbox) |
| `onFiles(row, files)` | attachment: files dropped or pasted onto the cell, when it's `editable` (the cell shows a drop outline while dragging) |

**Value shapes** (what `getValue` returns and `onEdit` receives):

| Type | Value | Cleared (Delete/Backspace) |
| --- | --- | --- |
| text, longtext | `string` | `""` |
| number | `number \| null` (typed text is parsed; `1,250.5` ok) | `null` |
| checkbox | `boolean` | `false` |
| select | option `value` or `null` | `null` |
| multiselect | option `value[]` | `[]` |
| link | `PickerItem \| null` (`{id, label, secondary?, color?, badge?, thumb?}`; `badge`/`thumb` are display only: "· V03", a tiny image) | `null` |
| multilink | `PickerItem[]` | `[]` |
| attachment | anything (e.g. the files); shown by `renderCell`, filtered/copied via `format` | never cleared: attachment cells aren't edited as text, pasted text or Backspace skip them |

Link values carry labels so the grid can render and undo without lookups. The consumer maps
`PickerItem.id` to its foreign keys in `onEdit`.

## Ordering (R1, R2)

- **Show order** (no `sort`): rows render exactly as given. Edits never move a row.
  Drag the handle on the row number to reorder: `onMove(id, {afterRowId | beforeRowId,
  groupId?})`. Compute the new `order_key` between those neighbors (fractional index,
  decision 0003); only the dragged row's key changes. Dropping onto a collapsed group
  appends to it and expands it.
- **Live sort** (`sort` set): the grid sorts (stable, multi-key, **empty values last** in
  both directions; cue-number-like strings compare by `compareNumericText`: the decimal
  numerically, then the letter suffix, so 14.2 < 14.25 < 14.3 < 14.3A < 14.5). The row
  you're in is **held in its slot** (its position within its group) while focus stays in
  it, whatever its own values or its neighbors' values do, including remote edits. When
  focus leaves the row (another row, Escape when not editing, focus leaving the grid), it
  slides (a FLIP animation; none with `prefers-reduced-motion`) to its sorted place and is
  highlighted for ~2.4 s (`data-moved`). After Escape the grid scrolls to it and keeps focus
  on it. A just-inserted row is held where it was inserted until you leave it. Dragging is
  disabled and a hint explains why.
- **Groups**: sorting and holds apply within each group. If an edit moves the focused row
  to another group (e.g. the scene field changed), it stays in its old group until focus
  leaves it.
- "Sort now" (rewrite `order_key`s to match a sort) is a data-layer command, not a grid
  feature: compute the keys, then clear `sort`.

## Keyboard

| Keys | Not editing | Editing |
| --- | --- | --- |
| ↑ / ↓ | Move (group headers are rows too). Clears a row selection | Move the caret |
| ← / → | Move (on an empty cell with a ghost, → accepts it) | Move the caret (→ on an empty editor with a ghost fills it in) |
| Shift+arrows | Extend a cell range | |
| Enter | Start editing (checkbox: toggle) | Commit, move down |
| Tab / Shift+Tab | Move right / left (wraps rows; leaves the grid at the ends). Tab accepts a ghost | Commit, move right / left (Tab on an empty editor commits the ghost) |
| Escape | Clear range + selection; end the row hold (the row settles, grid scrolls to it). If there was nothing to cancel: `onEscape` | Cancel |
| F2, double-click | Start editing | |
| Any character | Start editing with it (select/link: open the picker with it as the query) | |
| Space | `onOpenRow` | |
| Delete | If the active row is in the row selection: delete the selection (confirm if > 1). Else clear the range / cell | |
| Backspace | Clear the range / cell (never deletes rows) | |
| ⌘/Ctrl+Enter | | New line (long text). Shift+Enter also works |
| ⌘/Ctrl+Shift+Enter | Insert row below | Commit, insert below |
| ⌘/Ctrl+Shift+↑ | Insert row above | Commit, insert above |
| ⌘/Ctrl+D | Duplicate row (insert below + `onEdit` per editable, non-empty column); only rows with an editable cell (also hidden from the row menu otherwise) | |
| ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z (or ⌘/Ctrl+Y) | Undo / redo edits made through this grid | |
| ⌘/Ctrl+A | Select all rows | |
| ⌘/Ctrl+C / V | Copy TSV (row selection, range or cell) / paste TSV from the active cell | |
| Shift+F10, ContextMenu | Row menu (↑/↓/Home/End, Enter, Escape returns to the cell) | |
| On a group header | Enter / Space toggles; ← collapses; → expands; ⌘/Ctrl+Shift+Enter adds a row to the group | |

Keys during IME composition (`isComposing`) are left to the input method, in cells and
pickers.

**Pickers** (select, multiselect, link, multilink): typing filters; ↑/↓ move; Enter picks
(stays on the cell); Tab picks and moves right; Escape closes. Multi pickers stay open
after a pick, toggle already-picked items off, and Backspace in an empty search removes
the last chip. Link pickers list recently picked records first (per column, in memory) and
end with **Create "…"** when `create` is set and no label (or `PickerItem.aliases` entry,
e.g. content "VAMP" for "105-001-VAMP") matches exactly; Enter on it
calls `create` once (repeated Enter/clicks while it's running are ignored) and links the
result. Enter before the debounce fires searches first, so fast typing picks the right
record.

**Paste** fills text, long text, number and select cells (select by value or label);
other types, read-only and non-editable cells are skipped, and section rows are skipped
without using up a pasted row. One value pasted onto a range fills the range. A paste is
one undo step.

**Undo** replays inverse `onEdit` calls, so it works with any data layer. It covers edits
made through this grid instance only (not inserts, moves or deletes). **Remote changes
win:** each undo/redo step only touches a cell that still holds the value this grid left
there; cells someone else changed since are skipped, with an inline "Skipped N cells
changed by someone else" message. The step is still consumed.

## Mouse

- Click selects a cell; Shift+click extends a range. Double-click edits.
- Row number: click selects the row, Shift+click a range, ⌘/Ctrl+click toggles.
- Hover the row number for the drag handle, the expand (open) icon, and a `+` on the row's
  bottom edge that inserts below.
- Right-click a row: Insert above / below, Duplicate, Open, your `extraMenuItems`, Delete
  (the whole selection if the row is part of one).
- Group header: collapse toggle and **+ Add row** (`onInsert({groupId})`: append to that
  group). These buttons aren't tab stops; the header row itself is (via arrow keys).
- Drag a header's right edge to resize; or Tab to the resizer (they're in the tab order
  before the cells) and use ←/→ (Shift for 50 px steps).

## Focus

Roving tabindex: one cell (or group header) is in the tab order; Tabbing into the grid, or
any other way of focusing a cell, makes it the active cell. Focus never falls to `<body>`
because of the grid: after deleting the active row it moves to the next remaining row
(else the previous); if a collapse hides it, to that group's header; if a re-sort moves
the row's DOM node, focus is put back. Buttons inside rows don't take focus on click.

## Conditional formatting (R17)

```ts
const rules: ColorRule<Cue>[] = [
  ...STATUS.map((o) => ({ when: (c) => c.status === o.value, row: o.color })), // color by status
  { when: (c) => c.content.length === 0, cell: { key: "content", color: "orange" } },
];
```

Rules are evaluated per row in order. The first matching `row` rule sets the row
background (`--option-<color>-bg`, text stays `--color-text`); `cell` rules stack (later
wins) and set background + text (`--option-<color>-bg/fg`). Chips keep a faint outline so
they still read as pills on a row of the same color. Selection and range highlight draw on
top. Build the rules from a view's saved rule list (field, operator, value) in the data
layer; keep the array identity stable (`useMemo`). The show's tabs do this with
`gridColorRules` in `src/web/features/views/evaluate.ts` (saved views, CLAUDE.md "Saved
views"), which also lays out `columns` (order, hidden, widths, `frozen`) and the `sort`
from the view.

## Wiring a real table

The real tables are wired in `src/web/features/` (see "Table views" in CLAUDE.md):
`features/cues/CueGrid.tsx` for the cue list, `features/shared/TableGrid.tsx` for the
others. A sketch:

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
const rules = useMemo(() => colorRulesFor(view), [view]);
const cellDecoration = useCallback(
  (c: Cue, key: string) => (key === "number" ? numberHints.get(c.id) : undefined), // warning / ghost
  [numberHints],
);
const grid = useRef<DataGridHandle>(null); // grid.current?.focusRow(id) from ⌘K / script view

<div style={{ height: "calc(100dvh - 120px)" }}>
  <DataGrid<Cue>
    ref={grid}
    aria-label="Cue list"
    columns={columns}
    rowId={(c) => c.id}
    groups={groupsByScene}          // Unassigned first, then scenes; rows in order_key order
    isSection={(c) => c.isSection}
    sectionLabelKey="description"
    sort={view.sort}
    colorRules={rules}
    cellDecoration={cellDecoration}
    rowHeight={view.rowHeight}
    collapsed={prefs.collapsedScenes}
    onCollapsedChange={(ids) => savePrefs({ collapsedScenes: ids })}
    onActiveRowChange={(id) => setPanelRow(id)}
    extraMenuItems={({ rowId }) => [{ label: "Show in script", onSelect: () => showInScript(rowId) }]}
    onEdit={(id, key, value) => store.updateCue(id, { [key]: toField(key, value) })}
    onInsert={(pos) => store.insertCue(pos)} // key between neighbors; sceneId = pos.groupId
    onMove={(id, pos) => store.moveCue(id, pos)}
    onDelete={(ids) => store.deleteCues(ids)}
    onOpenRow={(id) => openPanel(id)}
    onColumnResize={(key, w) => saveViewWidth(key, w)}
    onError={(err, action) => toast(`Couldn't ${action}`, err)}
  />
</div>
```

Notes for the integration:

- **Optimistic updates.** Apply `onEdit`/`onInsert`/`onMove` to local state immediately
  (then send to the ShowDO). The grid reads values back from `rows`, so a slow round trip
  shows the old value until it lands. `onInsert` may be async; the new row is focused when
  its id appears. Rejections go to `onError`.
- **Neighbors are display neighbors.** `afterRowId`/`beforeRowId` refer to the row next to
  the insert/drop point *as displayed* (possibly sorted). In show order that is also the
  `order_key` neighbor; under a live sort, place the new row by key next to that row.
- **`groupId`** is set on insert/move whenever `groups` is used. For the Unassigned group,
  use a sentinel id and map it to `scene_id = null`.
- **Re-renders.** Rows are memoized on primitives and the row object: a keystroke
  re-renders only the edited row, and a data change only the rows whose objects changed
  (keep unchanged row objects identical, as immutable updates do). Memoize `columns`,
  `groups`/`rows`, `colorRules` and `cellDecoration`; `rowId`/`isSection` may be inline.
- **Remote edits** re-render the affected rows. The row you're in never moves (it's held
  in its slot); other rows re-sort immediately under a live sort. Undo won't overwrite a
  remote change (see Undo).
- **Scroll container.** The grid scrolls internally (both axes) with a sticky header row,
  a sticky group header (always the group of the first rows visible under it) and a frozen
  row-number column. It never widens the page.

## Accessibility

`role="grid"` with `row`/`columnheader`/`rowheader`/`gridcell`, `aria-rowindex` (header =
1), `aria-colindex`, `aria-selected`, `aria-readonly`, `aria-sort`, `aria-expanded` on
group rows and toggles, `role="separator"` resizers with `aria-valuenow`, an
`alertdialog` for the multi-row delete confirmation. See Focus for tab order. Icon buttons
have labels ("Open row 12", "Insert row below row 12", "Collapse 105 Scene Five"). The
focus ring uses `--color-focus-ring`.

## Tests

- `ordering.test.ts`, `values.test.ts` (node): sort, slot holds, layout, TSV, parsing, undo.
- `DataGrid.test.tsx` (jsdom, `pnpm test --project dom`): keyboard, editing, IME, undo/redo
  incl. remote-change skip, live-sort holds, insert, pickers incl. create (once), clipboard
  incl. sections, selection + delete confirmation + focus after delete, group headers as
  rows, sections, context menu, resize, ghosts/warnings, imperative handle, errors, and a
  render-count check.
- `e2e/grid.spec.ts` against `/dev/grid`: editing, insert under live sort (hold, ghost,
  Escape → slide + scroll + focus), drag (within and across groups), picker create,
  collapse + sticky header correctness, keyboard row menu, Tab into the grid, 5,000 rows,
  390 px.
