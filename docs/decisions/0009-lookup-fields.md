# 0009: Lookup fields, computed on the client from record columns

- **Status:** accepted
- **Date:** 2026-11-15

## Context

Shows imported from Airtable lean on lookups: the WG base's Notes table has "Content
(from Cue #)", each linked cue's Content shown as linked-record chips on the note. Formula
fields could already read a link's records, but only their names, and a formula's result
is plain text, never chips. Dylan chose a generic, Airtable-style lookup field type over a
one-off Notes column. The questions: where lookups are computed, how they name what they
read, and how a lookup on one tab reads another tab's fields.

## Decision

- **A custom field type `lookup`**, options `{link, field}`: the column key of a link field
  on its own table (`cues`, `scene`, `custom.venue`) and a column key of the linked table
  (`content`, `custom.mood`). Keys, not ids, because core fields have no ids and column keys
  are what views already use. The server checks only their shape: a missing link or field
  is a `#NAME` value on the client, as for a formula naming a field that's gone, so deleting
  or retyping a field never cascades into lookups.
- **Computed on the client, never stored**, like formula fields: the values are already in
  every member's store, so the live sync, undo and history need nothing new, and a value
  can't go stale on the server.
- **Record columns.** A lookup can read any table, so it can't use the other tab's grid
  columns (each tab builds them over its own view objects). Every table gets record columns
  over its raw rows (`src/web/features/custom/lookup.ts`): the same keys, titles, types and
  value shapes as its tab (a unit test compares them), and its custom fields through the
  tabs' own `customColumns`, so a lookup of a formula or of another lookup computes exactly
  as the tab does. They're cached per store state.
- **The kind decides the column**: links → read-only chips (the pickers' items), select
  choices → read-only choices with their colors, anything else → a formula-type value (one
  value, or the list). `src/shared/lookup.ts` resolves the kind for both sides, so the
  server's view validation (`viewFieldsFor`) agrees with the client's filters; when a field a
  lookup shows changes type or goes away, the views of tables with lookups are re-checked.
- **Cycles** are caught twice: statically along a chain of lookups, and at run time with a
  stack of lookups being computed (a cycle through a formula). Both are `#ERROR` values.

## Consequences

- Any link reaches any field, through core links, their reverse side, references and
  custom links, on core and custom tables, with filters, sorting, grouping, color rules,
  print and CSV export working from the column.
- A lookup can't show a tab's computed count columns (a content item's Notes, a scene's
  Cues) or files: they aren't record columns. The record columns must follow the tabs'
  columns; the unit test fails when they drift.
- Share links never see lookups (custom fields are in no share scope), so they can't leak
  rows of tables outside the link's scope. Showing custom fields on share links would need
  lookups to be scoped too.
- The Airtable importer still skips lookup columns: a CSV doesn't say what they look up.
