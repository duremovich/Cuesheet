# 0002: Fixed core schema plus custom fields and tables

- **Status:** accepted
- **Date:** 2026-09-30

## Context

Airtable is fully generic: any tables, any fields. That flexibility is why it can't do
cue-specific things well (group by scene is just "group by a field", notes on a cue are a
rollup you build yourself). The alternative extreme, a fixed schema, would make every
show's odd table (network devices, Millumin shortcuts) a code change.

## Decision

A fixed core the app understands (Show, Scene, Cue, Content, ContentVersion, Note,
Surface, Script, CueAnchor, ShotList, Shot, Person), each of which can take user-added
custom fields, plus fully user-defined custom tables with the same field types and UI.

## Consequences

- The app can build real features on the core: scene grouping, notes panels, script
  anchoring, surface calculations, print layouts.
- Custom tables cover the long tail without code.
- Core fields can be renamed in the UI but not removed; unused ones can be hidden.
- Changing the core later means a migration, so the core should stay small.
