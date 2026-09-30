# 0001: Hosted web app

- **Status:** accepted
- **Date:** 2026-09-30

## Context

The tool is used by 2–5 people editing the same show at the same time during tech, and
read by stage management and directors. Options were a hosted web app, an
offline-capable web app, or a desktop app with local files (FileMaker/Lightwright style).

## Decision

A hosted web app with real-time shared data. Desktop-first, with a phone-sized quick-add
page for notes.

## Consequences

- Simplest path to real-time collaboration and sharing read-only views.
- Needs a server and someone to maintain it; hosting choice is still open.
- Offline use is not supported in v1. Venue Wi-Fi is a known risk; the data layer should
  not rule out a local-first mode later (see L2).
