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
- **Sessions.** Do you label notes by rehearsal ("Tech 3", "Preview 1") today, or is
  date enough?

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
- **Also needed**: script view with cue placement and version re-anchoring (R20), shot
  lists (R14), calculations and unit conversion (R11, R12), images on surfaces (R13).
