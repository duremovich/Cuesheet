# 0003: Manual row order with a fractional-index key

- **Status:** proposed
- **Date:** 2026-09-30

## Context

The single biggest Airtable complaint: with a sort applied, a record moves the moment a
sorted field changes, so inserting an unnumbered cue between two others sends it away.
Airtable has no manual row order at all. Grist, NocoDB and Baserow each keep a hidden
numeric order column; Figma's fractional indexing does the same with strings that never
run out of precision.

## Decision

Every ordered table (Scene, Cue, Content, Shot) stores an `order_key`: a fractional-index
string (e.g. the `fractional-indexing` scheme). Show order is the default view and sorts by
that key. Inserting between two rows generates a key between their keys, touching only the
new row. Sorting by a field is either a one-shot "sort now" that rewrites keys, or a live
sort that never moves a row while it has focus. Cue number is a text field and is never the
sort key for show order.

## Consequences

- Inserts and drags are single-row writes, which works well with real-time sync.
- Keys grow slowly over many inserts at the same spot; a periodic rebalance (rewrite all
  keys in a table) keeps them short and is safe when no one is dragging.
- Two users inserting at the same spot at the same time both keep their rows. The server
  computes keys (see 0006), so there is no tie: the insert applied second lands directly
  after the anchor, before the first. That is acceptable.
- Import assigns keys in CSV row order.
