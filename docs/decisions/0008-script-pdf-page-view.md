# 0008: The script's PDF page view maps anchors through a traced re-extraction

- **Status:** accepted
- **Date:** 2026-11-05

## Context

M4b's reader shows a version's *extracted* text, reflowed (ux.md said "not the PDF
image"). Real scripts are formatted with care (small-caps speakers, italic directions,
boxed rehearsal marks in the margin, score references), and the team wants to read and
mark up the script as it looks, like a calling script on paper: cue numbers in a margin,
lines to the trigger, the trigger words underlined.

Anchors (decision 0004) are positions in the extracted block text (block, offset, length,
with quote and context); the original file is stored with the version (decision 0007).
To draw an anchor on the PDF, a block offset has to become a glyph on a page.

## Decision

- **A PDF page view** (`src/web/features/script/pdf/`) is the Script tab's default for a
  version whose original is a PDF: pdf.js renders each page (canvas) with its text layer
  (selectable, searchable), plus an SVG overlay and a cue margin. The extracted-text
  reader stays (a "PDF pages | Text" toggle; DOCX/TXT/MD versions only have it). Anchors,
  placement ops, re-anchoring and the Resolve screen are unchanged: both views write the
  same anchors through the same engine.
- **Mapping by re-running the extraction's layout with tracing.** The view loads the
  original, reads every page's text items, and runs the same layout code as the import
  (`layoutPdfTraced` in `extract/pdf.ts`), which records for each block character the
  text item and character it came from (`normalizeTextTraced` keeps the map through
  `normalizeText`). Those traced blocks are aligned with the version's stored blocks:
  identical lists (same file, same extractor) match by index; otherwise each stored block
  is searched in its page's traced text, so a version extracted by an older extractor
  still maps where its text can be found. Glyph positions within an item come from the
  same canvas measurement pdf.js's text layer uses, so underlines meet the selectable text.
- The reverse direction (a selection in the text layer → block/offset) uses the same map,
  snapping off glyphs that aren't block text (page numbers, running headers).
- Nothing new is stored: no glyph coordinates in anchors, no server work. The map is
  computed in the browser per version and cached in memory with the parsed document.

## Consequences

- Anchors stay text positions, so a new version re-anchors exactly as before, and the
  PDF view of an older version uses that version's own file.
- Blocks the PDF can't account for (another extraction, an edited text) aren't drawn;
  their cues are listed beside the pages ("Not on a page") instead of guessed.
- Opening the view costs one `getTextContent` per page and a layout pass (≈ 0.2 s for 31
  pages in Node); pages render lazily (virtualized), so long scripts stay smooth.
- Rotated pages and vertical text aren't handled by the glyph geometry (marks would be
  misplaced); scripts don't use them.
- Changes to the extraction's layout (`extract/pdf.ts`) now also affect the PDF view's
  mapping of *new* imports only; old versions fall back to the per-page text search.
