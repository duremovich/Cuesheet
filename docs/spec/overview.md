# Overview

## What this is

Cuesheet is a team-internal, hosted web app for managing the paperwork of a video/projection
design: the cue list, the notes taken about each cue during tech, the pieces of content that
play in those cues, and the supporting show information around them (scenes, surfaces,
people, shot lists, script).

It is a relational database with a fixed core tuned to that workflow, plus the ability to add
custom fields and side tables for everything else a show needs. Think Airtable, but built
around how a video team actually works on a linear show.

## Why not Airtable

The team uses Airtable today. It works, but:

1. **Rows fly away while you're typing.** With a sort applied, a record re-sorts the moment
   a sorted field changes. To keep the cue list in order you have to sort by cue number, so
   inserting a new cue between two existing ones (which often doesn't have a number yet)
   sends it to the top of the group. Grouping by scene helps but doesn't fix it.
2. **Data entry is clunky.** Linked-record pickers, multi-selects and long text are slow to
   enter at a tech table, and there's no keyboard-first way to capture a note against the
   cue you're looking at.
3. **Paywalls.** Record coloring, larger record limits and other useful features are on paid
   tiers. This is a small team and the tool is not a product; we'd rather own it.
4. **Calculations are awkward.** Pixel-per-inch, screen dimensions and unit conversion
   (meters vs. feet/inches) are done with fragile formulas or outside the base.

## Guiding principle: ease and speed of use

Every design choice is judged by how fast a designer can get information in and out
during tech. Concretely:

- **Find or create in one motion.** Anywhere a record is linked (content on a cue, a person
  on a note, a scene on content), typing opens a search over that table; if there's no
  match, Enter creates the record right there and links it, without leaving the cell.
- **Search is everywhere.** A global search (`⌘K`) jumps to any cue, content item, note,
  scene or surface by number or name.
- **Keyboard first, mouse optional.** Every common action has a shortcut; the mouse is
  never required in the grid, tech mode or pickers.
- **Never lose your place.** Rows don't move under you, panels open beside the grid rather
  than over it, and focus returns to where you were.
- **Sensible defaults, no forms.** New records inherit context (scene from the group,
  cue from tech mode, session label from the show), so most entries are one field.

## Who uses it

| Role | Access | Typical use |
| --- | --- | --- |
| Video designer, associates, programmer | Editor | Build and maintain the cue list and content, take notes in tech, track versions |
| Stage management | Viewer / commenter | Read the cue list (calls, LX numbers, pages), print a cue sheet, leave notes |
| Director, other designers | Viewer / commenter | See content and what's changing, leave notes |

Usually 2–5 editors on a show, often editing at the same time during tech.

## Where it runs

- **Hosted web app.** Open it in a browser; everyone works on the same live data.
- **Real-time multi-user.** Edits appear for everyone within a second or so; you can see
  who's in the show and which row they're on.
- **Desktop-first, with a phone-sized quick-add** for notes during tech.
- **Offline is not a v1 requirement**, but it's a known risk: venue Wi-Fi is unreliable.
  The design should not preclude it (see [open questions](open-questions.md)).

## Scope

- One team, many shows. Shows are separate workspaces with their own data; a show can be
  archived and cloned as a template.
- Primarily linear shows (musicals, plays), where the cue list follows the script.
- Also used for video-shoot shot lists and for calculations (PPI, screen dimensions, unit
  conversion).

## Not doing (v1)

- **Show control or playback.** Cuesheet is paperwork; Millumin/Disguise/QLab play the show.
  Exporting cue lists to them is a later feature.
- **Storing the media itself.** Content records point at files (paths or Drive links) and
  store thumbnails. Full-resolution video does not live in the app.
- **Offline sync.**
- **A full Airtable-style formula language.** A small, unit-aware formula set that covers
  the calculations we actually do.
- **Anything commercial**: billing, public sign-up, multi-organization tenancy.

## Spec documents

| File | What's in it |
| --- | --- |
| [data-model.md](data-model.md) | Tables, fields, links; how the Airtable base maps onto them |
| [requirements.md](requirements.md) | Must-have / should-have / later |
| [ux.md](ux.md) | How ordering, entry, grouping, tech mode, script view and printing behave |
| [research.md](research.md) | What we learned from existing tools |
| [open-questions.md](open-questions.md) | Unresolved questions |
