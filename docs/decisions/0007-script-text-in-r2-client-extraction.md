# 0007: Script text lives in R2; extraction runs in the browser

- **Status:** accepted
- **Date:** 2026-09-30

## Context

Decision 0004 anchors cues to a script's extracted text. A show's data lives in its
Durable Object's SQLite (decision 0005), but a script's text is big (a 150-page musical is
several hundred KB of blocks as JSON) and DO rows are capped (the op engine allows 512 KiB
per row), every snapshot would carry it, and every version adds another copy. Extracting
text from a PDF or DOCX is CPU-heavy (pdf.js parses fonts and content streams) and Workers
have tight CPU limits; the file may also be large.

## Decision

- **Extraction runs in the browser** (`src/web/features/script/extract/`): pdf.js
  (`pdfjs-dist`'s legacy build, loaded lazily with its worker) for PDFs, JSZip (lazy) + a small XML tokenizer for
  DOCX, plain parsing for TXT/Markdown. The result is a `ScriptText` (blocks with page and
  kind, printed page labels, source, confidence), posted to
  `POST /api/shows/:id/script/versions`. Scanned PDFs (no text layer) are refused with
  guidance; OCR (e.g. tesseract.js) isn't built in.
- **The text is stored gzipped in R2** at `shows/<showId>/script/<versionId>-<nonce>.json.gz` (a random nonce per import, so a purge never hits a live text; a used version id is never reused) and
  served by `GET …/versions/:vid/text`. It's immutable per version. The DO stores only the
  `script_versions` row: counts, source, confidence, the R2 key and a compact `page_map`
  (`[{startBlock, page, label}]`) so it can derive an anchor's page (and `Cue.page`) from
  its block without the text.
- **Re-anchoring runs in the Worker** on import (`src/shared/script-anchor`, pure and
  shared with the client): it reads the previous version's text from R2, matches every
  anchor, and sends one op batch (version, current version, anchors) to the DO. The server
  validates anchors against what it has (`block < block_count`), trusting the client's
  engine for the rest.
- The original file is uploaded through the attachments pipeline to the version's
  `source_file` field (DOCX is now an allowed attachment type); the client sets
  `script_versions.attachment_id` after the upload.

## Consequences

- Snapshots stay small (anchors and version rows only); the reader fetches one version's
  text on demand, cached by the browser (immutable).
- The server can't re-extract or check a text against its file; a client could post text
  that doesn't match the upload. Acceptable for a team-internal tool.
- Extraction quality depends on the browser's pdf.js; heuristics (character names, headings,
  page labels in margins) are ours and tested with generated fixtures.
- Text bytes count toward the show's storage; deleting a version purges its text after the
  same 24 h delay as attachments.
