# 0004: Anchor cues in the script by text context, not page position

- **Status:** accepted (implemented in M4a; thresholds in CLAUDE.md "Script")
- **Date:** 2026-09-30

## Context

Cues need to be shown on the script, and scripts change during rehearsal. If a cue is
stored as "page 14, 3 inches down", any reflow, cut or reformatting breaks every anchor
after the change. Stage-management tools that annotate PDFs directly have this problem.

## Decision

A cue's place in the script is a **CueAnchor**: the quoted trigger text plus ~32 characters
of context before and after, and the block/character offset in the extracted text of a
specific script version. Scripts are imported as extracted text (OCR for scans), not
rendered as PDF images. On a new version, anchors are re-matched (exact with context →
exact → fuzzy → context only) and each result is labeled matched / moved / changed /
missing for the user to review.

## Consequences

- Cues survive reflow, page renumbering and unrelated edits.
- Extraction quality matters: scanned PDFs and unusual layouts degrade matching and are
  flagged on import.
- The displayed script is our rendering of the text, not the original PDF layout; the
  original stays attached for reference and printing.
- Old anchors are kept per version so history is viewable.
