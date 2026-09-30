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
- Content `Version` values ("2.0", "4.0") aren't imported yet; they become ContentVersion
  records in M3.

Answered (M1): names missing from Personnel (the video team) become new people on import;
cues without content take the scene of the cues around them when both sides agree (on the
example base: 17 inferred, 28 left Unassigned). See CLAUDE.md, "Airtable import".

## Product

- **Script formats.** What do scripts usually arrive as: text PDF, scanned PDF, Word,
  Google Doc? How often do new versions come during rehearsal, and are the changes usually
  cuts/rewrites or reformatting? Scanned PDFs need OCR and anchor less reliably.
- **Whose cues on the script?** Video only, or should SM be able to put LX/SQ cues on the
  same script for a full calling script?
- **Where do files live?** Reference images, content thumbnails and script PDFs: uploaded
  to the app's own storage (simplest, costs a little), or links into Google Drive?
  Full-res media stays out of the app either way.
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

## Infrastructure

- **Sign-in for SM/director.** Do they need accounts, or is a read-only link enough?
- **Hosting.** Any preference or budget (a small VPS, a managed platform)? Who maintains
  it once it's running?
- **Offline.** Not v1, but how bad is venue Wi-Fi in practice? If tech regularly happens
  without internet, the architecture should plan for a local-first mode early.

## Validation

- A second show's base would confirm the model generalizes (especially scenes, surfaces
  and naming conventions).
- A shot list example for the Shot table.

## Answered

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
  lists (R14), calculations and unit conversion (R11, R12), images on surfaces (R13).
- **Saved views (M2a)** → CLAUDE.md "Saved views": personal views are private (snapshot,
  history and broadcasts are per user); an editor's unsaved changes to a shared view are a
  draft kept in the browser until Save/Discard; viewers' column widths and frozen columns
  are a per-browser overlay, other changes make a personal copy; link filters store record
  ids (renames keep working); multi-valued grouping groups by combination (Airtable-style,
  for now); sorting by a hidden column is allowed.
- **A table always has a shared view** (M2a review): the server refuses to delete the last
  one; drafts of shared views survive reloads and never overwrite a newer save (rebase or
  discard); viewers' copies are reused; M1c widths migrate to a per-user overlay.
