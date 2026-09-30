# 0005: Build on Cloudflare (Workers, Durable Objects, D1, R2)

- **Status:** accepted
- **Date:** 2026-09-30

## Context

The team already has a Cloudflare account. Decision 0001 chose a hosted web app; the
platform was open. The alternatives were a container on a managed host (Fly/Railway) with
Postgres, or Supabase.

## Decision

- **Cloudflare Workers** run the API (Hono) and serve the React app as static assets.
- **One Durable Object per show**, SQLite-backed, holds that show's tables (scenes, cues,
  content, notes, …) and its WebSocket connections. Every write goes through the DO, which
  applies it and broadcasts the change to connected clients. This gives real-time
  collaboration and per-show isolation without a separate sync service.
- **D1** holds the cross-show index: users, sessions, shows, memberships.
- **R2** holds attachments (images, script PDFs).
- **Drizzle ORM** for schema and migrations on both D1 and DO SQLite.
- Local development and tests run under `wrangler` / the Cloudflare Vite plugin, which
  emulate DOs, D1 and R2 faithfully. Playwright drives the app end to end.

## Consequences

- Data is SQLite per show rather than one Postgres. Fine at this scale (hundreds of cues,
  thousands of notes per show); cross-show queries go through D1 or per-DO calls.
- Hosting cost is the free plan or the $5/month Workers Paid plan.
- The DO is a natural place for ordering (fractional index) and conflict handling, since
  it serializes writes per show.
- Deploying from the Claude sandbox needs `*.cloudflare.com` allowed in its network
  policy and an API token; otherwise deploy from a developer machine or GitHub Actions.
- Offline mode later would mean a client-side cache and queued writes against the DO.
