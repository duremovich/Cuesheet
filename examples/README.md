# Examples

Reference material from past shows, used to design the data model.

## Some Like It Hot (Olney Theatre Center)

The CSVs in this folder are one Airtable base, exported table by table. Each file is named
`<Table>-<View>.csv`; the view name matters because Airtable only exports the fields and
rows visible in that view.

| File | Rows | What it is |
| --- | --- | --- |
| `Cue List-Video Cue List View.csv` | 122 | The video cue list: number, page, SM call, LX, timecode, AE time, measure, description, status, assignee, content |
| `Notes-NOTES.csv` | 319 | Tech notes, typed by department, with priority, done/in-progress, assignee, and links to scene, cue and content |
| `Content-Grid view.csv` | 42 | Pieces of content (`SSS-NNN-NAME`), version, scene, cues that use it, creator, loop points |
| `Breakdown-Grid view.csv` | 28 | Scenes: name, location, time of day, song, stage direction, description, video overview, content, surfaces |
| `Surfaces-Gallery.csv` | 16 | Projection surfaces with Millumin channel names and dimensions in meters |
| `Personnel-Grid view.csv` | 28 | Production team and cast |
| `Calendar-Grid view.csv` | 8 | Milestones |
| `Reference Links-Grid view.csv` | 11 | Moodboards and research links |
| `Directory-Grid view.csv` | 6 | Shared drives |
| `Network-Grid view.csv` | 10 | Devices, IPs and logins |
| `Millumin-Grid view.csv` | 13 | Keyboard shortcuts in the Millumin project |

Note: the cue list export has no Scene column even though the team groups by scene, so
the field is presumably hidden in that view. Two blank rows and a few duplicate cue numbers
are in the export as-is.

## Adding another show

Put each further show in its own folder, `examples/<show-name>/`:

- **CSV exports**, one per table, from an unfiltered view with all fields visible.
- **Screenshots** of field settings for formulas, rollups, lookups and single-selects,
  and of the views used during tech.
- **`notes.md`** (optional) on how the base was used and what was awkward.

Trim or anonymize anything sensitive. Structure and a few dozen realistic rows per table
are what matter.
