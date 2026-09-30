# Research

What existing tools do, and what we're taking from each. Items marked **[unverified]** come
from search summaries or memory and haven't been confirmed against the primary source.

## Lighting paperwork: Lightwright

The industry standard for lighting paperwork (John McKernon / City Theatrical). The closest
analog to what we want, for a different department.

- Understands channels, dimmers, colors and gobos as real concepts, not text, and checks the
  rig for errors (overlapping patches, non-existent dimmers).
- Keeps a **full change history** of who changed what and when, flags changes, and can undo
  another user's changes. **[unverified detail]**
- **Worknotes** can be added, edited and prioritized. A "distribute" feature prints a
  personal worknote list per recipient and emails them. **[unverified detail]**
- Live link to ETC Eos consoles including cue lists with notes and labels.

Takeaways: per-row change history; notes assignable to a person or department with a
per-recipient list; treat the domain objects (cue, content, surface) as typed, not free text.

Sources: [Lightwright 6 brochure](https://www.fullcompass.com/common/files/31992-CityTheatricalLightwright6Brochure.pdf),
[ETC: importing Lightwright data](https://support.etcconnect.com/ETC/Consoles/Eos_Family/Software_and_Programming/Importing_Lightwright_Data_Into_Eos_Family_Consoles).

## Other paperwork tools

- **Eos Notes** (iOS): attaches notes to cues synced from an Eos console; notes can be
  categorized, filtered and shared as PDF. A close precedent for "notes linked to cues."
- **FocusTrack**: imports console data to produce show documentation.
- **Google Sheets "master notes"** used by some lighting designers: each note coded by
  department (P = programming, ME = master electrician, F = focus).
- **Video-specific**: no widely shared FileMaker or Airtable template for projection
  designers was found. *The Projection Designer's Toolkit* (Routledge) includes sample cue
  sheets and a scene-by-scene content breakdown, which matches the Breakdown table in the
  example base.

Sources: [Eos Notes](https://apps.apple.com/us/app/-/id6468970839),
[FocusTrack](https://www.focustrack.co.uk/news/ToGo/index.html),
[Google Sheets master notes](https://www.stolaf.edu/nbs/NBS_March_13/Article1/Article1.html),
[Projection Designer's Toolkit](https://hstech.org/books/video-and-projections/the-projection-designers-toolkit/).

## Cue numbering

**ETC Eos**
- Cue numbers 0.001–9999.999, up to three decimal places. Point cues (4.5) are inserted
  without renumbering anything. Cues are referenced as list/cue (`2/12.5`) **[unverified]**.
- Renumbering is a long-standing feature request that doesn't exist, which tells you
  designers treat cue numbers as fixed once they're in the SM's book.

**QLab 5**
- Cue numbers are optional text (letters allowed) **[unverified]**.
- "Auto-number new cues with increment": a cue added between 2 and 4 becomes 3; another
  between 2 and 3 becomes 2.5. A separate Renumber tool takes a start and increment.

**disguise**
- Cue tags are `xx.yy.zz` strings on a timeline, triggered by DMX, OSC or MSC.

Takeaways: store cue numbers as **text**, optional, never as the sort key for row order.
Offer a QLab-style "number between neighbors" suggestion and a range renumber tool. Warn on
duplicates, don't block them.

Sources: [Eos renumbering request](https://community.etcconnect.com/control_consoles/eos-family-consoles/i/feature-requests/renumbering-cues),
[Eos copying to decimals](https://community.etcconnect.com/control_consoles/eos-family-consoles/f/eos-family/32184/how-to-copy-cues-from-whole-numbers-to-decimals),
[QLab workspace settings](https://qlab.app/docs/v5/fundamentals/workspace-settings/),
[QLab tools menu](https://qlab.app/docs/v5/tools/tools-menu/),
[disguise DMX triggering](https://help.disguise.one/designer/timeline-tracks-transports/dmx/triggering-playback-dmx).

## Row ordering in Airtable alternatives

| Tool | Manual order | What happens to an edited row in a sorted view | Row coloring |
| --- | --- | --- | --- |
| Airtable | none | re-sorts, but waits until you leave the row | paid plans only |
| Grist | drag when unsorted; hidden float `manualSort` column | "active sort" jumps immediately; "Saving Row Positions" option gives spreadsheet behavior | yes, formula rules, free |
| Baserow | drag handle when unsorted | reported to re-sort incorrectly | – |
| NocoDB | internal high-precision `nc_order` | no drag reorder at time of post | – |
| Notion | drag only when no sort rule | any sort locks manual order | – |
| SeaTable | drag by row number | Tab in a sorted view moves to the wrong row | cell rules only |

The pattern: **manual order is a hidden numeric key; sorting and manual order are mutually
exclusive modes.** Nobody handles "I'm sorting but don't move my row yet" well.

**Fractional indexing** (Figma): each row gets a string key; inserting between two rows
takes the midpoint, so a move touches one row. Keys grow over time; concurrent inserts at
the same spot can interleave; ties need a tiebreaker. Libraries: npm `fractional-indexing`,
Rust `fractional_index`.

Takeaways: default view is "show order" with a fractional-index key, drag-to-reorder always
works there; any field sort is either a one-shot reorder or a live sort that holds the edited
row until focus leaves it. See [ux.md](ux.md#ordering-and-sorting).

Sources: [Airtable: sort/filter conflict with data entry](https://community.airtable.com/other-questions-13/instant-sort-filter-conflict-with-data-entry-20689),
[Airtable: "don't make the record move and dance"](https://community.airtable.com/legacy-product-ideas-75/suggestion-updating-records-on-a-sorted-criteria-highlight-them-only-at-first-do-not-make-the-record-move-and-dance-until-i-am-done-42013),
[Grist manual sort](https://community.getgrist.com/t/method-to-get-and-set-table-row-display-id/5274),
[Grist conditional formatting](https://support.getgrist.com/conditional-formatting/),
[NocoDB nc_order](https://community.nocodb.com/t/how-does-nc-order-work/2194),
[Baserow re-sort bug](https://community.baserow.io/t/edited-row-re-sorts-incorrectly/2076),
[SeaTable tab in sorted view](https://forum.seatable.com/t/hitting-tab-when-in-a-sorted-view-puts-the-cursor-into-the-wrong-row/7224),
[Figma: fractional indexing](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/),
[fractional-indexing npm](https://cdn.jsdelivr.net/npm/fractional-indexing@3.2.0/README.md).

## Cue notes during tech

Common pattern across the sources above: a note is tied to a cue (or floats at scene/show
level), has a department or category, an assignee, a priority, a done flag, and the
rehearsal it came from; lists are distributed per recipient. Tech notes split into things
fixable at the console (levels, timing) versus things needing physical or content work,
which for video means a re-render.

The example base confirms this: 319 notes, 82% typed as Content and/or Programming, most
linked to a cue and a content item, priorities 1–5, done/in-progress checkboxes.

## Still to verify

- Eos cue parts limit and list/cue notation.
- QLab cue-number rules (text, uniqueness).
- Lightwright worknote fields.
- Watchout and Millumin cue list conventions and export formats.
- Airtable's current plan limits.
