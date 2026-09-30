# Requirements

**Must** = v1 can't ship without it. **Should** = next. **Later** = wanted, not designed yet.
Each requirement has an ID so notes and decisions can refer to it. The behaviors are
specified in [ux.md](ux.md); the tables in [data-model.md](data-model.md).

## Must-have

### Ordering and entry (the Airtable fixes)

- **R1 Stable row order.** A row never moves while it is being edited. The default view of
  every ordered table is manual "show order". Insert above/below and drag-to-reorder always
  work there. Unnumbered cues stay where they're put.
- **R2 Sorting is deliberate.** Sorting by a field is either a one-shot reorder ("sort by cue
  number now", which rewrites show order) or a live sort that holds the edited row in place
  until focus leaves it and then moves it with an animation. Never re-sort on keystroke.
- **R3 Cue numbers are text.** Optional, any format, validated against a pattern with a
  warning (not a block) on duplicates. A "number between neighbors" suggestion on insert and
  a range renumber tool.
- **R4 Group by scene.** Sticky, collapsible headers from the scene link, with counts,
  "add cue here", and dragging across groups re-links the row. Act as an optional outer
  group. Section rows for dividers that aren't scenes.
- **R5 Fast grid entry.** Inline editing; Tab/Enter/arrow navigation; Space opens the
  detail panel; typing on a selected cell starts editing; Escape cancels.
- **R5a Find-or-create pickers.** Every linked-record field opens a search popup on
  typing (fuzzy, over the linked table's primary field and a few secondary ones such as
  scene or description); no match → Enter creates the record with the typed name, links
  it, and it appears in that table's list immediately. Recently used and same-scene
  records rank first. Works identically in the grid, detail panel, tech mode and script
  view.
- **R5b Global search.** `⌘K` searches cues, content, notes, scenes, surfaces and people
  by number or name and jumps to the record (grid row, panel or script marker).
- **R6 Notes panel.** Any cue or content item has a notes side panel; adding a note there
  pre-fills the links.
- **R7 Tech mode.** A keyboard-driven layout for taking notes against the current cue:
  type, Enter, next. Plus a phone-sized quick-add page.

### Data

- **R8 Core schema** as in the data model: Show, Scene, Cue, Content, ContentVersion, Note,
  Surface, Script/ScriptVersion/CueAnchor, ShotList/Shot, Person.
- **R9 Custom fields** on any table and **custom tables**, with the field types listed in
  the data model.
- **R10 Content versions** as records; one current version per content item; the cue list
  shows the current version next to the content.
- **R11 Measurements and units.** Measurement fields store a value + unit and display in the
  show, view or user unit; accept feet/inches, meters, cm, mm on input; convert seamlessly.
- **R12 Calculations.** Formula fields with unit-aware arithmetic, lookups and rollups;
  built-in PPI, pixel pitch and aspect on surfaces; a surface calculator panel (enter any
  two of physical size / pixel size / PPI and see the rest).
- **R13 Images.** Attachments on surfaces, content, shots and notes with thumbnails in the
  grid, a gallery view, and a detail panel showing the image large. Surfaces in particular
  show the set photo with the channel's coverage.
- **R14 Shot lists** as a core table with the same ordering, grouping and print behavior
  as cues.
- **R15 Change history** per record (who, when, field, old → new), viewable in the detail
  panel; undo of your own last change.

### Views

- **R16 Saved views** per table: filters, sorts, grouping, hidden/ordered fields, row
  height, color rules. Personal or shared. Views used during tech are one click away.
- **R17 Conditional formatting.** Row and cell color rules (field, operator, value →
  color), free, per view. Rules can use formula fields.
- **R18 Detail panel** for any record: all fields, linked records, notes, history, images.
- **R19 Gallery view** for surfaces and content.
- **R28 Dark mode by default.** The app opens in a dark theme; a light theme is one click
  away and the choice persists. No pure white surfaces in dark mode; select-option and
  formatting colors stay readable on both themes.
- **R20 Script view.** Import a script (PDF, DOCX or Google Doc); read it in the browser
  with cues in the margin at their anchor, showing cue number, trigger type and trigger
  text; place a cue by selecting text; place LX/timecode/visual cues at a position; jump
  between grid and script. On a new script version, re-anchor every cue, report
  matched / moved / changed / missing, and give a resolve screen for the flagged ones.
- **R21 Print / PDF.** Any view prints cleanly. Built-in layouts: SM cue sheet, notes by
  person, notes by cue, content list, surface sheet, calling script (script with cues in
  the margin).

### Collaboration

- **R22 Real-time.** Multiple editors see each other's changes within a second; presence
  shows who is in the show and which row they have selected; conflicting edits to the same
  cell resolve last-write-wins with the history showing both.
- **R23 Roles.** Per show: editor, commenter (read everything, add and edit own notes),
  viewer. Share a view by link, optionally read-only without login for SM/director.
- **R24 Sign-in** for the team: email + password, invite-only. Google sign-in can come later.

### Import / export

- **R25 Airtable CSV import** with column mapping and link resolution.
- **R26 CSV export** of any view.
- **R27 Show templates**: clone a show's structure (scenes optional, surfaces, custom
  tables, views) into a new show.

## Should-have

- **S1** Annotate a surface's reference image in the app (draw the outline/region).
- **S2** Projector calculations: throw distance from lens ratio and width, and the reverse.
- **S3** "My notes" and "Tonight's notes" (current session) as default views; note
  distribution as PDF/email per assignee at the end of a session.
- **S4** Content thumbnails auto-generated from an uploaded still or a linked file.
- **S5** Timecode and duration arithmetic in formulas (e.g. cue offset from AE time).
- **S6** Comments/@mentions on any record, distinct from notes.
- **S7** Keyboard shortcut help and a command palette.
- **S8** Duplicate a cue/content/shot with links; bulk edit selected rows.

## Later / research

- **L1** Export cue lists to Millumin, Disguise, QLab; import Eos cue lists to fill
  `lx_cue`.
- **L2** Offline / flaky-network mode (local cache, queued writes).
- **L3** Dashboards: notes burndown per session, content status by scene.
- **L4** Automations (when status becomes Rendered, notify the programmer).
- **L5** Mobile app beyond the quick-add page.
- **L6** Read the current cue from the media server (OSC/MIDI) so tech mode follows the
  show automatically.

## Explicitly not doing

- Playback or show control.
- Storing full-resolution media.
- Multi-organization SaaS features (billing, public sign-up).
- A full spreadsheet formula language.
