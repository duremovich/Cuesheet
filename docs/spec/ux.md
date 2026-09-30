# UX spec

How the app behaves in the places where Airtable gets in the way. Requirement IDs refer to
[requirements.md](requirements.md).

## Ordering and sorting

*R1, R2, R3*

Every ordered table (cues, content, scenes, shots) has a hidden `order_key`: a
fractional-index string. Show order is the order of those keys. A view is always in one of
three modes:

| Mode | Rows are ordered by | Editing a row | Drag | Insert |
| --- | --- | --- | --- | --- |
| **Show order** (default) | `order_key` | never moves it | reorders, rewriting only the dragged row's key | new row gets a key between its neighbors |
| **Live sort** | one or more fields | row stays put while it has focus; when focus leaves, it slides to its sorted position with a short animation and a "moved" highlight | disabled | new row is placed where you inserted it and is treated as "focused" until you leave it |
| **Grouped** | scene (or act > scene), then show order or live sort within the group | as above; changing the scene field moves the row to the other group on blur | within group reorders; across groups re-links the scene and reorders | inserts into the group |

Rules:

- No view ever re-sorts on a keystroke. The trigger is **focus leaving the row** (click
  elsewhere, Escape, Enter on the last field, or navigating away with the keyboard), and
  even then the row is highlighted for a few seconds so your eye can follow it.
- **Sort now** (in the sort menu) rewrites `order_key` for the whole view so that show
  order matches the chosen sort. This is the "make the cue list match cue numbers" action.
  It is an explicit, undoable command, not a persistent state.
- Rows with an empty sort field sort **last**, not first, in a live sort. An unnumbered cue
  never jumps to the top.
- A live sort is stored on the view and shown as a chip in the toolbar; clicking it
  offers "Sort now and clear" or "Remove sort".
- Concurrent inserts at the same spot by two users are ordered by insert time and both
  shown; nobody's row disappears.

### Inserting a cue

- Right-click a row, or press `Ctrl/⌘+Shift+Enter` (below) or `Ctrl/⌘+Shift+↑` (above),
  or hover the left edge and click the `+` that appears between rows.
- The new row appears in place, in the same scene, with the cue number **empty and
  focused**. A ghost suggestion shows the midpoint number (between 14.2 and 14.4 → 14.3;
  between 14.2 and 14.25 → 14.22; after the last cue in the show → next whole number).
  Tab or → accepts it; typing replaces it; leaving it empty is fine.
- Duplicate numbers get an orange underline and a tooltip, never a modal.
- **Renumber…** on a selection: start number, increment, decimal places. Preview before
  apply. Also offered as "Renumber scene".

## Grid

*R5*

- Click selects a cell; typing starts editing; Enter commits and moves down; Tab commits
  and moves right; Escape cancels the edit; arrow keys move; Space opens the detail panel
  for the row; `Ctrl/⌘+Enter` inserts a newline in long text.
- Select, multi-select and link cells open a picker on typing. The picker searches the
  primary field (cue number, content name, person name) and shows a "Create '…'" row.
  Enter picks, Tab picks and moves on, Escape closes.
- Multi-select and link cells show chips; Backspace removes the last chip while editing.
- Long text expands inline while editing and collapses to two lines when not.
- Column widths, order, hidden fields, row height and frozen columns are per view.
- Bulk: select rows with Shift/⌘-click or drag on row numbers; paste fills a range; the
  context menu offers duplicate, delete, set field for selection, move to scene.
- Undo/redo (`⌘Z` / `⌘⇧Z`) for your own edits, across rows.

## Grouping

*R4*

- Group by scene (default for cues and content) with optional act as an outer group.
- Group header: scene number and name, cue count, open-notes count, a collapse toggle,
  and a `+ Add cue` button that inserts at the end of the group.
- Headers are sticky while scrolling. Collapse state is per user, not per view.
- Dragging a row into another group changes its scene link. Editing the scene field does
  the same on blur.
- Cues with no scene appear in an **Unassigned** group at the top so they're visible, not
  lost.
- Section rows (`is_section`) render as full-width dividers with their description as the
  label, inside whichever group they're in. Used for "ACT 2 TOP", "INTERMISSION".

## Detail panel and notes panel

*R6, R18, R15*

- Space or a row's expand icon opens a side panel (not a modal) so the grid stays visible.
  ↑/↓ in the panel move to the previous/next row.
- Cue panel: all fields in a two-column form; linked content as cards with thumbnail,
  current version and status; **Notes** tab with the note list and a compose box already
  linked to this cue (and to its content when there's exactly one); **Script** tab showing
  the anchor context; **History** tab.
- Content panel: fields, version list (add version; set current), cues that use it, notes,
  thumbnail.
- Surface panel: fields, the calculator (below), images at full width, content that plays
  on it.
- Notes in a panel show type chips, priority, assignee avatars and status; clicking status
  cycles Open → In progress → Done.

## Tech mode

*R7*

A layout for taking notes fast during tech and previews, from a laptop at the tech table.

```
┌──────────────────────────────┬──────────────────────────────────┐
│  Cue list (compact)          │  Notes for current cue           │
│  ▸ 14.00  dinge dissipates   │  ○ Content · P3 · Casey          │
│  ▸ 14.20  no change    ◀ cur │    add grunge overlay…           │
│  ▸ 14.25  …                  │  ○ Programming                   │
│  ▸ 14.30  …                  │    strumming effect timing       │
│                              │  ──────────────────────────────  │
│  [Scene 105 Backstage]       │  > type a note…    [C][P][D] P⌄ │
└──────────────────────────────┴──────────────────────────────────┘
```

- The **current cue** is highlighted. `↓`/`↑` or `Space`/`Shift+Space` move it; typing a
  cue number and Enter jumps to it.
- Focus lives in the compose box. Type, Enter: the note is saved against the current cue
  (and its content if exactly one), with the session label, type defaulting to the last
  used, and the box clears. `Tab` before Enter cycles type chips; `1`–`5` with `⌥`
  sets priority; `@name` assigns.
- A note that isn't about the current cue: prefix with the cue number (`8.5 needs to be a
  fade`) and it links there instead; prefix with `*` for a general note.
- Photos: paste or drop into the compose box.
- The session label ("Tech 3") is set once at the top and stamped on every note.
- The right column can show **all open notes for the current scene** instead, or the
  content cards for the cue.
- **Phone quick-add**: a single page with the current cue picker (searchable), the
  compose box, type chips and a camera button. Designed to be used with one thumb.

## Conditional formatting

*R17*

- Per view. Rule = *when* (field, operator, value; or a formula that returns true/false)
  → *then* (row background, or a specific cell's background/text color).
- Operators by type: is / is not / contains / is empty / greater than / before / after / is
  any of.
- Rules are ordered; the first match wins for row color; cell rules stack.
- Built-in presets offered on cue and note tables: color by status, color by priority,
  highlight cues with open notes, highlight cues with no content, highlight cues whose
  script anchor is `changed`/`missing`.
- Select options already carry a color; "color row by select field" is a one-click rule.

## Measurements and the surface calculator

*R11, R12*

- A measurement cell shows the value in the active unit with a small unit label. Typing
  accepts `4.5`, `4.5 m`, `14'9"`, `14 ft 9 in`, `177in`, `450cm`. A value typed without
  a unit is taken in the active unit.
- The active unit is: the view's unit override if set, else the user's preference, else
  the show default. A toolbar toggle switches m / cm / ft-in for the whole view instantly.
- Surface panel calculator: physical size, pixel size and PPI shown together. Editing any
  two recomputes the third (with the pixel size read-only when the surface is a region of
  a parent with a fixed canvas). Aspect ratio and pixel pitch are shown alongside.
- Formula errors (unit mismatch, divide by zero) show as a red cell with the message on
  hover, never as a stuck value.

## Images

*R13, R19*

- Attachment cells show thumbnails; click for a lightbox with prev/next.
- Gallery view: one card per record with the first image large, chosen fields beneath.
  Default for Surfaces (the set photo with the channel's coverage) and useful for Content.
- Detail panels show images full width with captions; drag-and-drop or paste to add.

## Script view

*R20*

### Reading

- The script renders as pages of extracted text (not the PDF image), in a readable
  column, with a wide right margin for cue markers. Page labels follow the printed page
  numbers. A page/scene navigator sits on the left.
- A **cue marker** in the margin shows the cue number, a trigger badge and the trigger text:
  - `Q 14.2 · LINE` "Sweet Sue needs a sax and a bass…" — the quoted text is also
    underlined in the body.
  - `Q 5 · LX 117` placed at a position, drawn with a horizontal tick into the text.
  - `Q 2 · TC 1:00:00`, `Q 3.4 · VISUAL dance break`, `Q 8.2 · FOLLOW`.
- Markers are colored by a per-view rule (default: by status) and show an open-notes dot.
- Clicking a marker opens the cue's detail panel; in the grid, a "Show in script" action
  scrolls the script to the marker, and the script view has a "Show in list" action.
- A filter bar limits markers by status, assignee or trigger type; a toggle shows other
  departments' cues if they've been entered (LX/SQ as text) for context.

### Placing cues

- Select text → a popover offers **New cue on this line** or **Attach existing cue** (a
  picker). For a new cue: number suggestion (based on the surrounding cues in script
  order), description field, trigger type pre-set to Line, trigger text = selection. The
  cue lands in show order between the nearest anchored cues.
- Click in the margin at a position (no selection) → same popover, trigger type defaults
  to LX/Timecode/Visual; the anchor is the nearest text.
- Drag a marker to move its anchor. Cue.page updates automatically from the anchor.

### New script version

1. **Import** the new file; give it a label. Text is extracted (OCR for scanned PDFs, with
   a warning banner).
2. **Re-anchor**: each cue anchored in the previous version is matched in the new text:
   exact quote with context → exact quote → fuzzy quote (similarity above threshold) →
   context only. The result is a new anchor per cue with a state:
   - `matched` — same text, same relative position.
   - `moved` — same text, different page or a large shift. Informational.
   - `changed` — a fuzzy match only; the line was edited. Needs a look.
   - `missing` — no match. The line was cut, or rewritten beyond recognition.
3. **Report**: a summary ("118 matched · 6 moved · 4 changed · 2 missing") and a list.
4. **Resolve** screen for `changed` and `missing`: old text with the marker on the left,
   the new page at the best guess on the right. Actions per cue: **Accept** (keep the
   guess), **Place** (select new text), **Cut** (mark the cue as Cut, keep it in the list),
   **Skip** (leave unanchored; it shows in an "Unplaced" tray in the script view).
5. Old anchors stay with the old version. The version switcher at the top of the script
   view shows any version; the current one is used for Cue.page and printing.

Cues with `changed`/`missing` anchors get a warning icon in the grid until resolved.

## Print and PDF

*R21*

- Any view: **Print** produces a paginated layout with the view's columns, grouping and
  colors, a header (show, view name, date, version), and repeated group headers on page
  breaks.
- Built-in layouts, each a saved view with print settings:
  - **SM cue sheet**: cue number, page, SM call / trigger, LX, description; grouped by
    scene; big type.
  - **Notes by person** and **Notes by cue** for a session: what's open and who owns it.
  - **Content list** with thumbnail, version, status, cues.
  - **Surface sheet** with image, dimensions in both units, pixel size, PPI.
  - **Calling script**: the script with markers in the margin, optionally only the cues
    matching a filter.
- Output is a PDF download or the browser print dialog.

## Collaboration

*R22, R23*

- Presence avatars in the toolbar; each editor's selected cell is outlined in their color.
- Changes from others animate in (brief highlight). If someone edits the cell you're
  typing in, you see their value when you commit, and history keeps both.
- Sharing: invite by email with a role; "share this view" produces a link (login required
  by default; a read-only public link is a per-show setting for SM/director convenience).

## Keyboard reference (draft)

| Keys | Action |
| --- | --- |
| Enter / Tab | commit + down / right |
| Esc | cancel edit; close panel |
| Space | open detail panel |
| ⌘⇧Enter / ⌘⇧↑ | insert row below / above |
| ⌘D | duplicate row |
| ⌘Z / ⌘⇧Z | undo / redo |
| ⌘K | command palette (jump to cue, switch view, run "sort now"…) |
| ⌘/ | shortcut help |
| T | toggle tech mode (from the cue list) |
