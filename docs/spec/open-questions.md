# Open questions

Answered questions move into the spec; this is what's still open. Answers so far are
summarized at the bottom.

## About the example data

- The exported *Cue List* view has no Scene column, but the team groups by scene. Is there
  a hidden Scene link field, or is it derived from Content → Scene? (The spec assumes a
  direct Cue → Scene link.)
- Duplicate cue numbers in the export (49.00 ×2, 54.00 ×2, 51.50 ×2) and 51.50 sitting near
  the top: leftovers, or does the team intentionally keep duplicates sometimes?
- LX column values like `x`, `?` and `.5`: what do these mean? Is `x` "no LX, taken
  manually"?
- Is AE Time a property of the cue (position in the comp when this cue fires) or of the
  content? The spec puts it on the cue.
- The Personnel table has a *Scenes* link: is that "which scenes this cast member is in"?
  Does it need to be core, or is a custom field fine?

### Raised by the M1 importer

- Airtable's `Created Time` has no time zone; the importer reads it as UTC. Should it use
  the show's (venue's) zone?
- (Answered, M3a) Content `Version` values ("2.0", "4.0") are imported as one current
  ContentVersion each ("V02", "V04"; status Available, no date).

Answered (M1): names missing from Personnel (the video team) become new people on import;
cues without content take the scene of the cues around them when both sides agree (on the
example base: 17 inferred, 28 left Unassigned). See CLAUDE.md, "Airtable import".

## Product

- **Script formats.** What do scripts usually arrive as: text PDF, scanned PDF, Word,
  Google Doc? How often do new versions come during rehearsal, and are the changes usually
  cuts/rewrites or reformatting? Scanned PDFs need OCR and anchor less reliably.
  (M4a: text PDFs, DOCX, TXT and Markdown import; scanned PDFs are refused with guidance to
  OCR them first, since tesseract.js in the browser is large and slow; Google Docs via
  File → Download as PDF/DOCX. Revisit OCR if scans turn out to be common.)
- **Re-anchoring thresholds** (M4a): fuzzy match accepted at bigram Dice ≥ 0.8, searched
  ±15% of the script around the predicted place first; "matched" = same printed page and ≤ 3
  blocks from the prediction. Tune against a real pair of script drafts when we have one.
- **Version stats** (M4a): `script_versions.stats` is the count by state right after
  re-anchoring (a report), not a live count; the resolve screen computes live counts from
  the anchors. OK?
- **Whose cues on the script?** Video only, or should SM be able to put LX/SQ cues on the
  same script for a full calling script?
- **Which calculations matter** beyond PPI, screen dimensions and unit conversion: throw
  distance / lens ratio, LED pixel pitch, content duration and timecode math? A past
  shot-list or calculation sheet would help.
- **Note types.** Is the list in the base (Content, Programming, Director, Prod Mtg,
  Admin, Technical, Artistic, R&D, Stage Management) the right starting set?

## Grid

- **Enter in a picker.** In a select or link cell, Enter picks and stays on the cell (Tab
  picks and moves right). Text cells move down on Enter. Should pickers move down too?
- **Row deletes.** The grid's undo covers cell edits only; deleting rows isn't undoable,
  so deleting more than one row asks for confirmation. Should deletes become undoable
  (soft delete in the data layer), which would let us drop the confirmation?
- **Pasting into link cells.** Paste fills text, number and select cells only. Should it
  also resolve names in link cells (find, or create when missing)?

## Cue list (M1c decisions to confirm)

Things the first build had to decide; each is easy to change.

- **Act grouping.** The grid has one grouping level, so when any scene has an act the act
  leads the scene group's subtitle ("Act 1 · song · 2 open notes") instead of being an
  outer collapsible group. Is a real outer act group worth building?
- **Cue number pattern.** Warn-only default: digits, optional `.digits` parts, optional
  trailing letters (`14`, `14.25`, `8.5A`, `1.2.3`). Numbers compare as decimals, so
  `14.2` and `14.20` count as duplicates. Should the pattern be a per-show setting now?
- **Ghost numbers.** After the last cue: the next whole number with the same decimals
  (`14.20` → `15.00`); before the first cue: the midpoint from 0 (`0.10` → `0.05`); no
  numbered cues at all: `1`. Neighbours that aren't plain decimals (`8.5A`) give no ghost.
- **Sort now.** Sorts the whole show by number; unnumbered cues go to the end (after a
  confirmation); section rows stay above the numbered cue that followed them. Not undoable
  yet. Should it sort within each scene instead, keeping scene order?
- **Live sort scope.** Now part of the saved view (M2a). Viewers can use it too (it's a view
  setting; changing a shared view gives them a personal copy).
- **Content created from a picker** is named `SSS-NNN-<typed>` (scene number padded to 3
  digits, next free NNN in that scene) unless the typed name already has the prefix or
  the cue has no numeric scene.
- **Unassigned group** is always shown on the cue list (even when empty) so there's
  always a place to add a cue and to drop cues without a scene.
- **Notes** are grouped by status with Done collapsed by default, oldest first; "+ Add
  note" adds an Open note. Notes have no manual order, so an inserted note settles at the
  end of its group once you leave it.
- **Deletes** from the grid are immediate for one row (multi-row asks first); deleting a
  scene with cues moves its cues to Unassigned (server cascade). Should scene deletes
  always confirm?

## Saved views (M2a decisions to confirm)

- **Filtered groups.** With a filter on, groups left empty are hidden (the Unassigned group
  too). "Clear filters" in the "Hidden by the current filter" toast clears all the view's
  filters, not just the last one.
- **Rebase granularity.** Rebasing a draft onto a newer shared view takes your value for
  each top-level config key you changed (all filters, all color rules, …), not a merge
  within a key.

## Units, formulas and surfaces (M3b decisions to confirm)

- **Default unit.** Meters when nothing is set. The show default lives in the ShowDO
  `meta` row (M3a owned D1 migrations this round); move it to D1 `shows` if it ever needs
  to be listed across shows. Is ft-in the better default for US shows?
- **Pixels are plain numbers** in formulas, so `pixel_width / width` is a `#UNIT` error
  and pixels-per-length goes through `PPI()`; length × length (areas) is an error too.
- **Surfaces import.** Surfaces-Gallery.csv has 16 rows, the last one blank: 15 surfaces
  are imported. A region's parent comes from its channel (`CH02.1` → `CH02`). The
  export's Breakdown.Surfaces column is empty; links resolve by surface name or channel
  when it has values. `content.resolution` stays text (M3a owns content); the
  `pixel_size` field type exists for it and for custom fields.
- **Locale.** Lengths parse `.` as the decimal point and `,` only as a thousands separator
  (`1,200 mm` = 1.2 m; `4,5 m` is refused rather than read as 4.5). A decimal-comma locale
  would need its own rule; no change for now.
- **Calculator.** The aspect lock starts off. The region diagram shows the region's
  share, not its position (surfaces have no offsets yet).

## Script view and print (M4b decisions to confirm)

- **Cut** sets the cue's status to a new **Cut** option (red) and deletes its anchor on
  the new version; the cue stays in the list. The option is seeded by a migration.
- **Marker colors** follow a per-user, per-show choice (Status / Trigger type / none;
  localStorage), not a saved view. When the script gets saved views, move it there.
- **Other departments' cues** (the LX/SQ toggle): shown as faint `LX 117` / `SQ 12`
  labels beside the video cue that carries them, since LX/SQ cues aren't records of their
  own.
- **Unplaced** = cues anchored on the previous version with no placed anchor on the
  current one (Cut cues excluded). Older gaps (v1 → v3) aren't tracked.
- **Numbers** for a new cue come from the nearest anchored cues in *script* order; if
  those disagree with show order (a cue placed out of order), the new cue still goes
  right after the one before it in the script.
- **Positional anchors** from a margin click sit at the start of the block clicked; a
  finer position (between words) isn't offered.
- **Print** is the browser's print dialog / Save as PDF: no server-side PDF. The calling
  script prints the whole script; a page range isn't offered.

## Custom fields, shots, export, templates (M5a decisions to confirm)

- **Custom field keys** are slugs made from the name and never change; renaming a field
  changes only its label. Formulas may name fields by label or key (`{Camera}`,
  `camera`), so renaming a field breaks formulas that use its old label: key references
  are the stable form.
- **Changing a field's type** clears the values that don't fit (text ↔ long text ↔ URL
  keep them; a single or multiple select becomes text, "A, B"), after a confirmation that
  says how many rows have values; views drop the filters, sorts, grouping and color rules
  that no longer apply. **Renaming a select choice** keeps it on its rows and in view
  filters; removing a used choice asks first (with the count) and clears it. Pointing a
  link at another table clears its links; turning off "Allow more than one" keeps each
  row's first link.
- **Link fields** store ids on the linking side only; the other side shows them read-only
  (a custom row's panel lists who links to it). Two-way editable links (Airtable's
  automatic reverse field) aren't built.
- **Sensitive fields** are masked for everyone and revealed per panel visit; they're
  still synced to every member (no per-role hiding), kept out of history (values written
  while a field was sensitive stay hidden after the flag is removed), formulas (`#HIDDEN`),
  ⌘K and exports (owners can include them in an export).
- **CSV exports are "Excel-safe"** by default: a cell starting with `=`, `+`, `-` or `@`
  gets a leading `'` so spreadsheets don't run it (plain numbers are left alone).
- **Templates** are shows flagged in D1 (`is_template`): you open and edit them like any
  show; they copy scenes (optional), surfaces, custom fields and tables (no rows), shared
  views and the default unit. Personal views, shot lists and core select options aren't
  copied (options are the same in every show until they become editable).
- **Shot numbers** reuse the cue-number rules (ghost midpoint, duplicate warning) within
  one list. A shot list's own `content` link isn't built (each shot links content).
- **Printing a custom table** isn't offered yet (the Print view knows the core tabs); CSV
  export works.
- **Bulk edit Undo** puts each row's previous value back from the toast (8 s); it isn't
  part of the grid's ⌘Z stack.
- **CSV exports** show values as the grid does (lengths in your unit, formulas rounded as
  displayed). "Export all" is the raw form (meters, ids, stored text).

## Infrastructure

- **Sign-in for SM/director.** Do they need accounts, or is a read-only link enough?
- **Hosting.** Any preference or budget (a small VPS, a managed platform)? Who maintains
  it once it's running?
- **Offline.** Not v1, but how bad is venue Wi-Fi in practice? If tech regularly happens
  without internet, the architecture should plan for a local-first mode early.

## Validation

- A second show's base would confirm the model generalizes (especially scenes, surfaces
  and naming conventions).
- A shot list example for the Shot table (the M5a fields follow data-model.md; confirm
  framing and status lists with a real shoot).

## Answered

- **Custom field values on notes** (M5a review): commenters may edit custom values on
  their own notes, like the notes' core fields. → CLAUDE.md "Custom fields and custom
  tables"

- **Resolve → Skip** (M4b): leaves the cue unanchored on the new version, per ux.md: a
  guessed (`changed`) anchor is set to `missing` with no position, so the cue shows in
  the reader's Unplaced tray (and keeps its cue-list warning). **Accept** is the way to
  keep a guess. → CLAUDE.md "Script view"

- **Platform**: hosted web app. → overview
- **Team size**: 2–5 editors, simultaneously in tech. → overview, R22
- **Schema**: fixed core + custom fields and tables. → data model
- **Cue → Scene**: the cue list has a hidden Scene link field. → data model
- **Sign-in**: email + password, invite-only for v1. → R24
- **Platform**: Cloudflare Workers / Durable Objects / D1 / R2. → decision 0005
- **Blank rows in the cue list**: the team groups by scene; grouping is essential. → R4
- **Content versions**: version history per content item. → ContentVersion
- **Audience**: video team edits; SM, director and other designers view/comment. → R23
- **Tech entry**: laptop at the tech table and phone/tablet. → R7
- **Sessions** (M2b): one current session per show, shared by the team and set by
  editors; new notes are stamped with it, and any note's session can be edited on its
  own. → data model (Note.session), CLAUDE.md "Session model"
- **Cue prefix in notes** (M2b): only explicit prefixes link a cue: `q8.5 `, `Q8.5 `,
  `#8.5 `, `8.5: ` (whitespace required after each, so `10:30 …` and `2:1 …` are text).
  A bare leading number is text; `*` makes a general note.
  → CLAUDE.md "Compose grammar"
- **Tech mode shortcut** (M2b): no bare `T` (type-to-edit wins); the header link, ⌘K and
  ⌘/Ctrl+Shift+. open it. ⌘/Ctrl+G "go to cue" inside tech mode is fine.
- **Follow** (M2b): keeps the current cue in view. Following the SM's cue (or OSC from
  the show control system) is a later feature.
- **A scene's notes** (M2b): notes linked to the scene or to any of its cues (Notes tab,
  tab count, tech mode's "Scene open notes").
- **History paging** (M2b): by limit (50 more at a time, up to 1000) is fine.
- **Row panel width** (M2b): per user (per browser).
- **Deleting a note** (M2b): immediate, with an Undo toast (8 s) instead of a confirm.
- **Tech mode without `?cue=`** (M2b): opens at the last tech cue of the show.
- **`@name`** (M2b): a full name without spaces or a unique first name; the picker that
  typing `@` opens is the reliable way; unknown `@words` stay in the text.
- **Also needed**: script view with cue placement and version re-anchoring (R20), shot
  lists (R14), calculations and unit conversion (R11, R12), images on surfaces (R13, done in M3a).
- **Saved views (M2a)** → CLAUDE.md "Saved views": personal views are private (snapshot,
  history and broadcasts are per user); an editor's unsaved changes to a shared view are a
  draft kept in the browser until Save/Discard; viewers' column widths and frozen columns
  are a per-browser overlay, other changes make a personal copy; link filters store record
  ids (renames keep working); multi-valued grouping groups by combination (Airtable-style,
  for now); sorting by a hidden column is allowed.
- **Content versions** (M3a): records per content item, exactly one current whenever
  there are any (setting one clears the others; the first is current; deleting or
  un-currenting the current one promotes the newest other; the only one stays current).
  → CLAUDE.md "Content versions"
- **Where files live** (M3a): uploaded to the app's R2 bucket (25 MB per file, 2 GB per
  show; images, PDF, MP4/MOV, text; HEIC refused with a hint). Thumbnails are generated in
  the Worker with Photon (WASM). Full-res media stays out. → CLAUDE.md "Attachments"
- **Deleted files and Undo** (M3a): R2 objects of deleted attachments are kept for 24 h
  (a `pending_r2_deletes` list in the DO, purged by its alarm, bytes released only then),
  so Undo of a file or of a note with photos restores them. → CLAUDE.md "Attachments"
- **Very large photos** (M3a): images over 16.7 MP are scaled down in the browser before
  upload (longest side ≤ 4096 px), keeping the original size in `custom.original_size`;
  GIFs and animated WebP upload as they are, so they may have no thumbnail (the original
  is shown instead).
- **Version date** (M3a): a day (`YYYY-MM-DD`) is enough. Imported versions are
  Available.
- **Storage cap** (M3a): 2 GB per show (thumbnails not counted).
- **Gallery** (M3a): a view layout option; the grid stays the default for Content (a
  "Content gallery" preset is one click away). → CLAUDE.md "Saved views"
- **A table always has a shared view** (M2a review): the server refuses to delete the last
  one; drafts of shared views survive reloads and never overwrite a newer save (rebase or
  discard); viewers' copies are reused; M1c widths migrate to a per-user overlay.
- **Units (M3b)** → CLAUDE.md "Units, formulas and surfaces": the toolbar's m / cm /
  ft-in toggle sets *your* unit (per browser, everywhere), never the view; a view can pin
  a unit only through Fields → Unit override (editors; a "View unit" chip shows it).
  Order: view override → your unit → show default → meters. ft-in displays to the
  nearest 1/8" (editing shows the exact value). Negative lengths are refused. A bare
  number in ft-in is decimal feet (`14.75` = 14' 9"). The row panel's History shows
  lengths in the active unit.
- **Surface calculator (M3b)**: for a region of a parent with a pixel canvas, the pixel
  size is the *default lock*, not read-only.
- **Custom formula columns**: built in M5a as formula custom fields (see "Custom fields,
  shots, export, templates" above).
